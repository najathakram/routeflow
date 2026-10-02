import { ConflictException } from "@nestjs/common";
import { resolveReactivationConflicts } from "./product-reactivation-holders";
import { ACTOR, T, makeTx, product, row } from "./product-code-release.fake-tx";

/**
 * SA-603i (reuse API): `PATCH /products/:id { isActive:true [, deactivateHolderIds] }`. Under the locks (codes -> name
 * -> rows sorted) the server re-derives the ACTIVE holders of each retired code and of the name. No ids: any holder is a
 * 409 listing ALL of them. With ids: they must be EXACTLY that set (else the same 409 with the CURRENT set), a FAMILY /
 * active-variant holder is never one-call deactivatable, and each deactivated holder gets codes released + an audit row.
 */
const reactivating = (over = {}) =>
  product({ id: "me", name: "Gone Apple", isActive: false, retiredSku: "S1", ...over });
const input = (holderIds: string[] | undefined, extra = {}) => ({
  tenantId: T,
  productId: "me",
  name: "Gone Apple",
  parentProductId: null,
  skip: [] as Array<"sku" | "barcode" | "unitSku">,
  holderIds,
  actorId: ACTOR,
  ...extra,
});
const bodyOf = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(ConflictException);
  return (err as ConflictException).getResponse() as Record<string, any>;
};

describe("resolveReactivationConflicts", () => {
  it("the exact set: the blocking holder is deactivated (codes released) with ONE audit row naming what was freed", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1", barcode: "B9" })],
      barcodes: [row("r1", "h1", "UNIT", "B9")],
    });
    await resolveReactivationConflicts(tx, input(["h1"]));
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
      meta: {
        reactivatedProductId: "me",
        // audit == effect (Opus #2860 N1): everything the deactivation released, not only the colliding sku
        freed: expect.arrayContaining([
          { field: "sku", value: "S1" },
          { field: "barcode", value: "B9" },
        ]),
        reason: "deactivated to reactivate me",
      },
    });
  });

  it("a NAME holder counts too: the active same-name product is deactivated", async () => {
    const tx = makeTx({
      products: [reactivating({ retiredSku: null }), product({ id: "n1", name: "gone apple" })],
    });
    await resolveReactivationConflicts(tx, input(["n1"]));
    expect(tx.products[1].isActive).toBe(false);
  });

  it("no ids + holders: a 409 listing ALL of them, top-level keys repeating holders[0] (sku first, then name)", async () => {
    const tx = makeTx({
      products: [
        reactivating(),
        product({ id: "h1", name: "Sku Holder", sku: "S1" }),
        product({ id: "n1", name: "Gone Apple" }),
      ],
    });
    const body = await bodyOf(resolveReactivationConflicts(tx, input(undefined)));
    expect(body).toMatchObject({
      code: "CODE_TAKEN",
      field: "sku",
      value: "S1",
      productId: "h1",
      productName: "Sku Holder",
    });
    expect(body.holders).toEqual([
      { code: "CODE_TAKEN", field: "sku", value: "S1", productId: "h1", productName: "Sku Holder" },
      {
        code: "NAME_TAKEN",
        field: "name",
        value: "Gone Apple",
        productId: "n1",
        productName: "Gone Apple",
      },
    ]);
    expect(tx.audits).toHaveLength(0);
    expect(tx.products.filter((p) => p.isActive === false)).toHaveLength(1); // only `me`
  });

  it("a barcode conflict keeps the SA-572b keys (code BARCODE_TAKEN, barcode, productId) beside the flat ones", async () => {
    const tx = makeTx({
      products: [
        reactivating({ retiredSku: null, retiredBarcode: "B5" }),
        product({ id: "h1", name: "BH", barcode: "B5" }),
      ],
    });
    const body = await bodyOf(resolveReactivationConflicts(tx, input(undefined)));
    expect(body).toMatchObject({
      code: "BARCODE_TAKEN",
      barcode: "B5",
      field: "barcode",
      value: "B5",
      productId: "h1",
    });
    expect(body.holders[0]).toMatchObject({ code: "BARCODE_TAKEN", field: "barcode", value: "B5" });
  });

  it("a stale/wrong set is refused with the same shape and the CURRENT holders; nothing is written", async () => {
    for (const ids of [["bystander"], ["h1", "bystander"], ["nobody"]]) {
      const tx = makeTx({
        products: [
          reactivating(),
          product({ id: "h1", name: "Holder", sku: "S1" }),
          product({ id: "bystander", name: "By", sku: "S9" }),
        ],
      });
      const body = await bodyOf(resolveReactivationConflicts(tx, input(ids)));
      expect(body).toMatchObject({ code: "CODE_TAKEN", productId: "h1" });
      expect(body.holders).toHaveLength(1);
      expect(tx.products.every((p) => p.isActive !== false || p.id === "me")).toBe(true);
      expect(tx.audits).toHaveLength(0);
    }
  });

  it("ids sent but nothing blocks any more: 409 HOLDERS_CHANGED with an empty holders list, nothing deactivated", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "x", name: "Other", sku: "ZZ" })],
    });
    const body = await bodyOf(resolveReactivationConflicts(tx, input(["x"])));
    expect(body).toMatchObject({ code: "HOLDERS_CHANGED", holders: [] });
    expect(tx.products[1].isActive).toBe(true);
  });

  it("a cross-tenant id is never in the set: 409, and the other tenant's product is untouched", async () => {
    const foreign = { ...product({ id: "f1", name: "Foreign", sku: "S1" }), tenantId: "tenant-b" };
    const tx = makeTx({
      products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1" }), foreign],
    });
    const body = await bodyOf(resolveReactivationConflicts(tx, input(["h1", "f1"])));
    expect(body.holders.map((h: { productId: string }) => h.productId)).toEqual(["h1"]);
    expect(tx.products.find((p) => p.id === "f1")!.isActive).toBe(true);
  });

  it("a FAMILY holder, or a holder with ACTIVE variants, is refused even when its id is sent (blocked: HAS_ACTIVE_VARIANTS)", async () => {
    for (const setup of [
      [product({ id: "h1", name: "Fam", sku: "S1", kind: "FAMILY" })],
      [
        product({ id: "h1", name: "Parent", sku: "S1" }),
        product({ id: "v1", name: "Kid", parentProductId: "h1" }),
      ],
    ]) {
      const tx = makeTx({ products: [reactivating(), ...setup] });
      const body = await bodyOf(resolveReactivationConflicts(tx, input(["h1"])));
      expect(body.holders[0]).toMatchObject({ productId: "h1", blocked: "HAS_ACTIVE_VARIANTS" });
      expect(tx.products.find((p) => p.id === "h1")!.isActive).toBe(true);
      expect(tx.audits).toHaveLength(0);
    }
  });

  it("an INACTIVE holder is not a blocker (the restore releases it lazily), and a re-set field (skip) is not a conflict", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "old", name: "Old", isActive: false, sku: "S1" })],
    });
    await expect(resolveReactivationConflicts(tx, input(undefined))).resolves.toEqual({
      deactivatedIds: [],
    });
    const tx2 = makeTx({
      products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1" })],
    });
    await expect(
      resolveReactivationConflicts(tx2, input(undefined, { skip: ["sku"] })),
    ).resolves.toEqual({ deactivatedIds: [] });
  });

  it("lock order: the code locks, then the name lock, BEFORE any holder read; then rows in sorted id order; then the writes", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1" })],
    });
    await resolveReactivationConflicts(tx, input(["h1"]));
    const i = (c: string) => tx.calls.indexOf(c);
    expect(i("lock:code")).toBeLessThan(tx.calls.indexOf("product.findMany"));
    expect(tx.calls.filter((c) => c === "lock:code").length).toBeGreaterThanOrEqual(2); // code lock + name lock
    // rows sorted by id: "h1" < "me"
    expect(i("lock:row:h1")).toBeLessThan(i("lock:row:me"));
    expect(i("lock:row:me")).toBeLessThan(i("product.update:h1"));
    expect(i("product.update:h1")).toBeLessThan(i("auditLog.create"));
  });

  it("returns the ids it deactivated (the caller emits one product-changed event for them, N4)", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1" })],
    });
    await expect(resolveReactivationConflicts(tx, input(["h1"]))).resolves.toEqual({
      deactivatedIds: ["h1"],
    });
    const none = makeTx({ products: [reactivating()] });
    await expect(resolveReactivationConflicts(none, input(undefined))).resolves.toEqual({
      deactivatedIds: [],
    });
  });

  it("B2: every code the holder's release will free must already be in the caller's ONE locked set, else 409 and nothing written", async () => {
    const mk = () =>
      makeTx({
        products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1", barcode: "B9" })],
      });
    const short = mk();
    const body = await bodyOf(
      resolveReactivationConflicts(short, input(["h1"], { lockedCodes: new Set(["S1"]) })),
    );
    expect(body).toMatchObject({ code: "CODE_TAKEN", productId: "h1" });
    expect(short.products[1].isActive).toBe(true);
    expect(short.audits).toHaveLength(0);
    const full = mk();
    await resolveReactivationConflicts(full, input(["h1"], { lockedCodes: new Set(["S1", "B9"]) }));
    expect(full.products[1].isActive).toBe(false);
  });

  it("B1: the holder's codes are released BEFORE its isActive write (two writes, release first)", async () => {
    const tx = makeTx({
      products: [reactivating(), product({ id: "h1", name: "Holder", sku: "S1" })],
    });
    await resolveReactivationConflicts(tx, input(["h1"]));
    expect(tx.calls.filter((c) => c === "product.update:h1")).toHaveLength(2);
    expect(tx.calls.indexOf("lock:row:h1")).toBeLessThan(tx.calls.indexOf("product.update:h1"));
    expect(tx.products[1]).toMatchObject({ isActive: false, sku: null, retiredSku: "S1" });
  });
});
