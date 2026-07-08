import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AuthorizationsService } from "./authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("AuthorizationsService", () => {
  let service: AuthorizationsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let audit: { log: jest.Mock };
  const user = { sub: "u1", username: "operator1", role: "OPERATOR" } as any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        AuthorizationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(AuthorizationsService);
    prisma.customer.findUnique.mockResolvedValue({ id: "c1" });
    prisma.trackedCategory.findUnique.mockResolvedValue({ id: "cat-1" });
    prisma.customerAuthorization.create.mockImplementation((a: any) =>
      Promise.resolve({ id: "a1", ...a.data }),
    );
    prisma.customerAuthorization.update.mockImplementation((a: any) =>
      Promise.resolve({ id: a.where.id, ...a.data }),
    );
  });

  it("create (wholesaler-added) → VERIFIED with the verifier snapshot", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue(null);
    const auth = await service.create(
      "c1",
      { trackedCategoryId: "cat-1", expiresAt: "2027-01-01T00:00:00Z" },
      user,
    );
    expect(auth).toMatchObject({
      status: "VERIFIED",
      source: "WHOLESALER_ADDED",
      verifiedById: "u1",
      verifiedByName: "operator1",
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "regulated_authorization.created" }),
    );
  });

  it("create upserts an existing row (never duplicates the unique)", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue({ id: "existing" });
    await service.create("c1", { trackedCategoryId: "cat-1" }, user);
    expect(prisma.customerAuthorization.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "existing" } }),
    );
    expect(prisma.customerAuthorization.create).not.toHaveBeenCalled();
  });

  it("approve PENDING → VERIFIED, and rejects a non-pending approve", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue({
      id: "a1",
      customerId: "c1",
      status: "PENDING_REVIEW",
    });
    const res = await service.approve("c1", "a1", user);
    expect(res).toMatchObject({ status: "VERIFIED", verifiedByName: "operator1" });

    prisma.customerAuthorization.findUnique.mockResolvedValue({
      id: "a1",
      customerId: "c1",
      status: "VERIFIED",
    });
    await expect(service.approve("c1", "a1", user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("reject PENDING → REJECTED", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue({
      id: "a1",
      customerId: "c1",
      status: "PENDING_REVIEW",
    });
    const res = await service.reject("c1", "a1", { reason: "bad doc" }, user);
    expect(res).toMatchObject({ status: "REJECTED" });
  });

  it("renew re-verifies with a fresh expiry", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue({
      id: "a1",
      customerId: "c1",
      status: "EXPIRED",
    });
    const res = await service.renew("c1", "a1", { expiresAt: "2028-01-01T00:00:00Z" }, user);
    expect(res).toMatchObject({ status: "VERIFIED" });
    expect(res.expiresAt).toEqual(new Date("2028-01-01T00:00:00Z"));
  });

  it("getOwned rejects an authorization belonging to another customer", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue({
      id: "a1",
      customerId: "OTHER",
      status: "PENDING_REVIEW",
    });
    await expect(service.approve("c1", "a1", user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("create 404s a cross-tenant / unknown category", async () => {
    prisma.trackedCategory.findUnique.mockResolvedValue(null); // forTenant → null for cross-tenant id
    await expect(
      service.create("c1", { trackedCategoryId: "cat-other-tenant" }, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.customerAuthorization.create).not.toHaveBeenCalled();
  });

  it("create resolves a P2002 race to the existing row (no 500)", async () => {
    prisma.customerAuthorization.findUnique
      .mockResolvedValueOnce(null) // initial existing check → create path
      .mockResolvedValueOnce({ id: "raced-1" }); // post-P2002 re-lookup
    prisma.customerAuthorization.create.mockRejectedValueOnce({ code: "P2002" });
    const auth = await service.create("c1", { trackedCategoryId: "cat-1" }, user);
    expect(prisma.customerAuthorization.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "raced-1" } }),
    );
    expect(auth).toMatchObject({ status: "VERIFIED" });
  });

  it("renew rejects laundering a REJECTED authorization to VERIFIED", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue({
      id: "a1",
      customerId: "c1",
      status: "REJECTED",
    });
    await expect(
      service.renew("c1", "a1", { expiresAt: "2028-01-01T00:00:00Z" }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("findExpiringSoon returns [] with no tenant context (no cross-tenant leak)", async () => {
    prisma.getTenantId.mockReturnValue(null);
    await expect(service.findExpiringSoon()).resolves.toEqual([]);
    expect(prisma.customerAuthorization.findMany).not.toHaveBeenCalled();
  });

  it("findExpiringSoon computes 30/7/1 buckets and flags expired", async () => {
    prisma.getTenantId.mockReturnValue("t1");
    const now = new Date("2026-07-10T00:00:00.000Z");
    const day = 86_400_000;
    prisma.customerAuthorization.findMany.mockResolvedValue([
      {
        id: "a",
        customerId: "c",
        trackedCategoryId: "cat",
        status: "VERIFIED",
        expiresAt: new Date(now.getTime() + day / 2),
        customer: { businessName: "Acme" },
        trackedCategory: { name: "Tobacco" },
      },
      {
        id: "b",
        customerId: "c",
        trackedCategoryId: "cat",
        status: "VERIFIED",
        expiresAt: new Date(now.getTime() + 5 * day),
        customer: { businessName: "Acme" },
        trackedCategory: { name: "Tobacco" },
      },
      {
        id: "c",
        customerId: "c",
        trackedCategoryId: "cat",
        status: "EXPIRED",
        expiresAt: new Date(now.getTime() - day),
        customer: null,
        trackedCategory: null,
      },
    ] as any);
    const res = await service.findExpiringSoon(30, now);
    expect(
      res.map((r) => ({
        id: r.id,
        bucket: r.bucket,
        expired: r.expired,
        customerName: r.customerName,
      })),
    ).toEqual([
      { id: "a", bucket: 1, expired: false, customerName: "Acme" },
      { id: "b", bucket: 7, expired: false, customerName: "Acme" },
      { id: "c", bucket: null, expired: true, customerName: "Customer" },
    ]);
  });
});
