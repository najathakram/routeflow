import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { AuthorizationGuardService } from "./authorization-guard.service";
import { AuthorizationOverridesService } from "./authorization-overrides.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("AuthorizationGuardService.checkAuthorized", () => {
  let service: AuthorizationGuardService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let overrides: { isOverrideActive: jest.Mock };

  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  beforeEach(async () => {
    prisma = createMockPrisma();
    overrides = { isOverrideActive: jest.fn().mockResolvedValue(false) };
    const mod = await Test.createTestingModule({
      providers: [
        AuthorizationGuardService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthorizationOverridesService, useValue: overrides },
      ],
    }).compile();
    service = mod.get(AuthorizationGuardService);
  });

  const line = (trackedCategoryId: string | null) => ({ trackedCategoryId });

  it("RELEASE GATE: a requiresLicense=FALSE category (tobacco) is NEVER blocked", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-tob", name: "Tobacco", requiresLicense: false, appliesScope: null },
    ]);
    const res = await service.checkAuthorized({ customerId: "c1", lines: [line("cat-tob")] });
    expect(res.blocked).toEqual([]);
    // never even looks up an authorization for a non-gated category
    expect(prisma.customerAuthorization.findUnique).not.toHaveBeenCalled();
  });

  it("fast path: an order with no regulated lines makes zero category queries", async () => {
    const res = await service.checkAuthorized({
      customerId: "c1",
      lines: [line(null), line(null)],
    });
    expect(res.blocked).toEqual([]);
    expect(prisma.trackedCategory.findMany).not.toHaveBeenCalled();
  });

  it("blocks a requiresLicense=TRUE category with no authorization (NO_AUTH)", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-alc", name: "Alcohol", requiresLicense: true, appliesScope: null },
    ]);
    prisma.customerAuthorization.findUnique.mockResolvedValue(null);
    const res = await service.checkAuthorized({ customerId: "c1", lines: [line("cat-alc")] });
    expect(res.blocked).toEqual([
      { trackedCategoryId: "cat-alc", categoryName: "Alcohol", reason: "NO_AUTH" },
    ]);
  });

  it("passes a VERIFIED non-expired authorization", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-alc", name: "Alcohol", requiresLicense: true, appliesScope: null },
    ]);
    prisma.customerAuthorization.findUnique.mockResolvedValue({
      status: "VERIFIED",
      expiresAt: future,
    });
    const res = await service.checkAuthorized({ customerId: "c1", lines: [line("cat-alc")] });
    expect(res.blocked).toEqual([]);
  });

  it("blocks an EXPIRED authorization lazily (persisted status still VERIFIED)", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-alc", name: "Alcohol", requiresLicense: true, appliesScope: null },
    ]);
    prisma.customerAuthorization.findUnique.mockResolvedValue({
      status: "VERIFIED",
      expiresAt: past, // cron hasn't flipped it yet
    });
    const res = await service.checkAuthorized({ customerId: "c1", lines: [line("cat-alc")] });
    expect(res.blocked[0]).toMatchObject({ reason: "EXPIRED" });
  });

  it("an active §8 override satisfies the guard", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-alc", name: "Alcohol", requiresLicense: true, appliesScope: null },
    ]);
    prisma.customerAuthorization.findUnique.mockResolvedValue(null);
    overrides.isOverrideActive.mockResolvedValue(true);
    const res = await service.checkAuthorized({
      customerId: "c1",
      lines: [line("cat-alc")],
      orderId: "ord-1",
    });
    expect(res.blocked).toEqual([]);
  });

  it("honors appliesScope — an out-of-scope sale is not gated", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-crv", name: "CRV", requiresLicense: true, appliesScope: { cities: ["Oakland"] } },
    ]);
    prisma.customerAuthorization.findUnique.mockResolvedValue(null);
    // delivering to Fresno → CRV (Oakland-scoped) doesn't apply → not blocked
    const res = await service.checkAuthorized({
      customerId: "c1",
      lines: [line("cat-crv")],
      deliveryCity: "Fresno",
    });
    expect(res.blocked).toEqual([]);
  });

  it("FAILS CLOSED: a scoped category with an UNKNOWN delivery city is still gated", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-crv", name: "CRV", requiresLicense: true, appliesScope: { cities: ["Oakland"] } },
    ]);
    prisma.customerAuthorization.findUnique.mockResolvedValue(null);
    // no deliveryCity supplied → cannot rule the sale out of scope → must block
    const res = await service.checkAuthorized({ customerId: "c1", lines: [line("cat-crv")] });
    expect(res.blocked[0]).toMatchObject({ trackedCategoryId: "cat-crv", reason: "NO_AUTH" });
  });

  it("assertAuthorizedOrThrow throws a structured 409 when blocked", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-alc", name: "Alcohol", requiresLicense: true, appliesScope: null },
    ]);
    prisma.customerAuthorization.findUnique.mockResolvedValue(null);
    await expect(
      service.assertAuthorizedOrThrow({ customerId: "c1", lines: [line("cat-alc")] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
