import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { AuthorizationOverridesService } from "./authorization-overrides.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("AuthorizationOverridesService", () => {
  let service: AuthorizationOverridesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let audit: { log: jest.Mock };
  const user = { sub: "u1", username: "operator1", role: "OPERATOR" } as any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        AuthorizationOverridesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(AuthorizationOverridesService);
    prisma.authorizationOverride.create.mockImplementation((a: any) =>
      Promise.resolve({ id: "ovr-1", ...a.data }),
    );
    prisma.trackedCategory.findFirst.mockResolvedValue({ id: "cat-1" });
  });

  it("createOverride writes the append-only row AND an immutable audit log", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "c1" });
    const ovr = await service.createOverride(
      "c1",
      {
        trackedCategoryId: "cat-1",
        reason: "long-standing buyer",
        scope: "UNTIL:2026-12-31T00:00:00Z",
        acknowledgedTenant: "Acme Distribution",
      },
      user,
    );
    expect(ovr).toMatchObject({
      acceptedById: "u1",
      acceptedByName: "operator1",
      scope: "UNTIL:2026-12-31T00:00:00Z",
      acknowledgedTenant: "Acme Distribution",
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "regulated.responsibility_override",
        entityType: "AuthorizationOverride",
      }),
    );
  });

  it("createOverride 404s an unknown customer", async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(
      service.createOverride(
        "nope",
        { trackedCategoryId: "cat-1", reason: "x", scope: "ORDER:o1", acknowledgedTenant: "Acme" },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("isOverrideActive is true for an active UNTIL override", async () => {
    prisma.authorizationOverride.findMany.mockResolvedValue([
      { scope: "UNTIL:2999-01-01T00:00:00Z" },
    ]);
    expect(await service.isOverrideActive("c1", "cat-1")).toBe(true);
  });

  it("isOverrideActive is false when only expired / mismatched overrides exist", async () => {
    prisma.authorizationOverride.findMany.mockResolvedValue([
      { scope: "UNTIL:2000-01-01T00:00:00Z" },
      { scope: "ORDER:other-order" },
    ]);
    expect(await service.isOverrideActive("c1", "cat-1", "ord-1")).toBe(false);
  });

  it("isOverrideActive matches an ORDER-scoped override for the same order", async () => {
    prisma.authorizationOverride.findMany.mockResolvedValue([{ scope: "ORDER:ord-1" }]);
    expect(await service.isOverrideActive("c1", "cat-1", "ord-1")).toBe(true);
  });
});
