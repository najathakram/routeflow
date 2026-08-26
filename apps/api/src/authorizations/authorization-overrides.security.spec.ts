/**
 * Security tests for §8 responsibility overrides.
 *
 * createOverride's existence checks read via `forTenant().findUnique` with a
 * `select: { id: true }` — the exclusive select omitted tenantId, defeating the
 * post-filter tenant guard, so a cross-tenant customer/category id validated
 * and the created override FK-referenced another tenant's row. The checks now
 * use the tenant-scoped `findFirst`; these specs pin "a cross-tenant id 404s":
 * findUnique is mocked to return the foreign row (raw-DB behavior), findFirst
 * to return null (scoped behavior) — reverting to findUnique fails the test.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { AuthorizationOverridesService } from "./authorization-overrides.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";

const USER = { sub: "user-1", username: "op" } as any;
const DTO = {
  trackedCategoryId: "cat-1",
  scope: "ORDER",
  reason: "test",
  acknowledgedTenant: true,
} as any;

describe("AuthorizationOverridesService — cross-tenant ids 404 in createOverride", () => {
  let service: AuthorizationOverridesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthorizationOverridesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(AuthorizationOverridesService);
  });

  it("404s a cross-tenant customerId and writes no override", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-foreign" });
    prisma.customer.findFirst.mockResolvedValue(null);

    await expect(service.createOverride("cust-foreign", DTO, USER)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.authorizationOverride.create).not.toHaveBeenCalled();
  });

  it("404s a cross-tenant trackedCategoryId and writes no override", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.trackedCategory.findUnique.mockResolvedValue({ id: "cat-foreign" });
    prisma.trackedCategory.findFirst.mockResolvedValue(null);

    await expect(
      service.createOverride("cust-1", { ...DTO, trackedCategoryId: "cat-foreign" }, USER),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.authorizationOverride.create).not.toHaveBeenCalled();
  });

  it("creates the override when both ids are in-tenant", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.trackedCategory.findFirst.mockResolvedValue({ id: "cat-1" });
    prisma.authorizationOverride.create.mockResolvedValue({ id: "ov-1" });

    await expect(service.createOverride("cust-1", DTO, USER)).resolves.toEqual({ id: "ov-1" });
  });
});
