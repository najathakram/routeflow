import { ConflictException } from "@nestjs/common";
import { deactivateReactivationHolders } from "./product-reactivation-holders";
import { ACTOR, T, makeTx, product, row } from "./product-code-release.fake-tx";

/**
 * Lead/SA ruling (reuse API, contract (c)): `PATCH /products/:id { isActive:true, deactivateHolderIds:[...] }`. In ONE
 * tx the server re-derives the ACTIVE holders that block the reactivation (of each retired code and of the name) UNDER
 * the locks, refuses (409 HOLDERS_CHANGED) unless the requested ids are EXACTLY that set, then deactivates each (codes
 * released) with one audit row per holder. No arbitrary product can be deactivated through this door.
 */
const reactivating = (over = {}) =>
  product({ id: "me", name: "Gone Apple", isActive: false, retiredSku: "S1", ...over });
const input = (holderIds: string[], extra = {}) => ({
  tenantId: T,
  productId: "me",
  name: "Gone Apple",
  parentProductId: null,
  skip: [] as Array<"sku" | "barcode" | "unitSku">,
  holderIds,
  actorId: ACTOR,
  ...extra,
});

describe("deactivateReactivationHolders", () => {
  it("deactivates EXACTLY the active holder of a retired code: isActive false, its codes released, one audit row", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1", barcode: "B9" })],
      barcodes: [row("r1", "h1", "UNIT", "B9")],
    });
    await deactivateReactivationHolders(tx, input(["h1"]));
    expect(tx.products[1]).toMatchObject({
      isActive: false,
      sku: null,
      retiredSku: "S1",
      barcode: null,
      retiredBarcode: "B9",
    });
    expect(tx.barcodes[0]).toMatchObject({ code: null, retiredCode: "B9" });
    expect(tx.audits).toHaveLength(1);
    expect(tx.audits[0].data).toMatchObject({
      tenantId: T,
      userId: ACTOR,
      action: "product.deactivated_for_reactivation",
      entityType: "Product",
      entityId: "h1",
    });
    expect((tx.audits[0].data.meta as { reactivatedProductId: string }).reactivatedProductId).toBe(
      "me",
    );
  });

  it("a NAME holder counts too: the active same-name product is deactivated", async () => {
    const tx = makeTx({
      products: [reactivating({ retiredSku: null }), product({ id: "n1", name: "gone apple" })],
    });
    await deactivateReactivationHolders(tx, input(["n1"]));
    expect(tx.products[1].isActive).toBe(false);
  });

  it("refuses (409 HOLDERS_CHANGED, nothing written) unless the ids are EXACTLY the conflicting set", async () => {
    const mk = () =>
      makeTx({
        products: [
          reactivating(),
          product({ id: "h1", name: "Holder", sku: "S1" }),
          product({ id: "bystander", name: "Bystander", sku: "S9" }),
        ],
      });
    for (const ids of [["bystander"], ["h1", "bystander"], [], ["nobody"]]) {
      const tx = mk();
      const err = await deactivateReactivationHolders(tx, input(ids)).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "HOLDERS_CHANGED",
        holders: [{ productId: "h1", productName: "Holder" }],
      });
      expect(tx.products.every((p) => p.isActive !== false || p.id === "me")).toBe(true);
      expect(tx.audits).toHaveLength(0);
    }
  });

  it("an ID that matches no real conflict is refused when there is no conflict at all (no deactivating arbitrary products)", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "x", name: "Other", sku: "ZZ" })],
    });
    await expect(deactivateReactivationHolders(tx, input(["x"]))).rejects.toMatchObject({
      response: { code: "HOLDERS_CHANGED", holders: [] },
    });
    expect(tx.products[1].isActive).toBe(true);
  });

  it("an INACTIVE holder is not a blocker: it is left alone (the restore releases it lazily)", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "old", name: "Old", isActive: false, sku: "S1" })],
    });
    await deactivateReactivationHolders(tx, input([]));
    expect(tx.audits).toHaveLength(0);
    expect(tx.products[1]).toMatchObject({ sku: "S1" });
  });

  it("a field the same PATCH re-sets (skip) is not a conflict", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1" })],
    });
    await deactivateReactivationHolders(tx, input([], { skip: ["sku"] }));
    expect(tx.products[1].isActive).toBe(true);
  });

  it("takes the code locks and the name lock BEFORE reading holders, and each holder row lock BEFORE its write", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1" })],
    });
    await deactivateReactivationHolders(tx, input(["h1"]));
    const i = (c: string) => tx.calls.indexOf(c);
    const firstRead = tx.calls.findIndex((c) => c === "product.findMany");
    expect(i("lock:code")).toBeLessThan(firstRead);
    expect(i("lock:row:h1")).toBeLessThan(i("product.update:h1"));
    expect(i("product.update:h1")).toBeLessThan(i("auditLog.create"));
  });
});
