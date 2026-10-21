import { ConflictException } from "@nestjs/common";
import { ProductFamiliesService } from "./product-families.service";

/** SA-823 (PR-2): reactivating an import-made empty family writes its own audit row in the same transaction. */
describe("ProductFamiliesService.reactivateFamilyContainer", () => {
  const build = (members = 0) => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      product: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ name: "Acme Cola" })
          .mockResolvedValueOnce({ kind: "FAMILY" }),
        count: jest.fn().mockResolvedValue(members),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      getTenantId: () => "tenant-a",
      tenantTransaction: async (cb: (t: unknown) => unknown) => cb(tx),
    };
    const svc = new (
      ProductFamiliesService as unknown as new (
        p: unknown,
        g: unknown,
        a: unknown,
      ) => ProductFamiliesService
    )(prisma, {}, {});
    jest.spyOn(svc, "reserveFamilyName").mockResolvedValue([]);
    return { svc, tx };
  };

  it("writes one product.family.reactivated row (actor, reason) in the same transaction as the isActive write", async () => {
    const { svc, tx } = build();
    await svc.reactivateFamilyContainer("fam-1", "user-1");
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "fam-1" },
      data: { isActive: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-a",
      userId: "user-1",
      action: "product.family.reactivated",
      entityType: "Product",
      entityId: "fam-1",
      meta: { reason: "import re-run" },
    });
  });

  it("a family with members is refused and nothing is written", async () => {
    const { svc, tx } = build(2);
    await expect(svc.reactivateFamilyContainer("fam-1", "user-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
