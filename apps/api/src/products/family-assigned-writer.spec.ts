import { writeFamilyAssigned } from "./product-parent";

describe("writeFamilyAssigned (SA-823b: the one writer of product.family_assigned)", () => {
  const input = {
    tenantId: "t-1",
    actorId: "u1",
    productId: "p1",
    fromParentId: null,
    toParentId: "fam",
    variantName: "Mint",
    via: "family_editor" as const,
  };

  it("writes the exact audit row on the given tx", async () => {
    const create = jest.fn().mockResolvedValue({});
    await writeFamilyAssigned({ auditLog: { create } }, input);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        tenantId: "t-1",
        userId: "u1",
        action: "product.family_assigned",
        entityType: "Product",
        entityId: "p1",
        meta: {
          productId: "p1",
          fromParentId: null,
          toParentId: "fam",
          variantName: "Mint",
          via: "family_editor",
        },
      },
    });
  });

  it("a missing actor is userId null", async () => {
    const create = jest.fn().mockResolvedValue({});
    await writeFamilyAssigned({ auditLog: { create } }, { ...input, actorId: undefined });
    expect(create.mock.calls[0][0].data.userId).toBeNull();
  });

  it.each([undefined, null, ""])(
    "throws a plain Error on tenantId %p and writes nothing",
    async (t) => {
      const create = jest.fn();
      const err = await writeFamilyAssigned(
        { auditLog: { create } },
        { ...input, tenantId: t },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(create).not.toHaveBeenCalled();
    },
  );
});
