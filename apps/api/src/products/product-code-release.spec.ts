import { ConflictException } from "@nestjs/common";
import {
  claimCodes,
  lockCodesOfProducts,
  releaseProductCodes,
  restoreProductCodes,
  CODE_RELEASED_ON_REUSE_ACTION,
} from "./product-code-release";
import { ACTOR, T, makeTx, product, row } from "./product-code-release.fake-tx";

/**
 * SA-603 / SA-603a (c): deactivate releases a product's codes (legacy column -> retired*, level rows ->
 * retiredCode); a colliding INACTIVE holder is released lazily, in the same tx, with one AuditLog row; an ACTIVE
 * holder is a 409 naming it; reactivate restores only what is still free. A tiny in-memory fake `tx` records the
 * call order so the lock-first source order is pinned, not only the end state.
 */
describe("releaseProductCodes (deactivate)", () => {
  it("moves sku/barcode/unitSku into retired* and nulls the live columns; level rows keep the code in retiredCode", async () => {
    const tx = makeTx({
      products: [product({ id: "p1", sku: "S1", barcode: "B1", unitSku: "U1" })],
      barcodes: [row("r1", "p1", "BOX", "B1"), row("r2", "p1", "UNIT", "B1")],
    });
    const out = await releaseProductCodes(tx, { tenantId: T, productId: "p1" });
    expect(out.released).toEqual(expect.arrayContaining(["sku", "barcode", "unitSku"]));
    expect(tx.products[0]).toMatchObject({
      sku: null,
      barcode: null,
      unitSku: null,
      retiredSku: "S1",
      retiredBarcode: "B1",
      retiredUnitSku: "U1",
    });
    expect(tx.barcodes.map((b) => [b.code, b.retiredCode])).toEqual([
      [null, "B1"],
      [null, "B1"],
    ]);
  });

  it("takes the code locks BEFORE the first write, and is a no-op when nothing is live (idempotent)", async () => {
    const tx = makeTx({ products: [product({ id: "p1", sku: "S1" })] });
    await releaseProductCodes(tx, { tenantId: T, productId: "p1" });
    const firstWrite = tx.calls.findIndex((c) => c.startsWith("product.update"));
    expect(tx.calls.indexOf("lock:code")).toBeGreaterThanOrEqual(0);
    expect(tx.calls.indexOf("lock:code")).toBeLessThan(firstWrite);

    tx.calls.length = 0;
    const again = await releaseProductCodes(tx, { tenantId: T, productId: "p1" });
    expect(again.released).toEqual([]);
    expect(tx.calls.filter((c) => c.startsWith("product.update"))).toEqual([]);
    expect(tx.products[0].retiredSku).toBe("S1");
  });

  it("never touches another product's rows", async () => {
    const tx = makeTx({
      products: [product({ id: "p1", sku: "S1" }), product({ id: "p2", sku: "S2" })],
      barcodes: [row("r9", "p2", "UNIT", "B2")],
    });
    await releaseProductCodes(tx, { tenantId: T, productId: "p1" });
    expect(tx.products[1].sku).toBe("S2");
    expect(tx.barcodes[0].code).toBe("B2");
  });
});

describe("lockCodesOfProducts (clearAll's ONE sorted lock set, capped)", () => {
  it("peeks every product's codes and locks them in ONE call (one lock per distinct code), returning the set", async () => {
    const tx = makeTx({
      products: [
        product({ id: "a", sku: "SA", barcode: "BA" }),
        product({ id: "b", sku: "SB", barcode: "BA" }),
      ],
      barcodes: [row("r1", "a", "UNIT", "BA")],
    });
    const set = await lockCodesOfProducts(tx, T, ["a", "b"]);
    expect([...set].sort()).toEqual(["BA", "SA", "SB"]);
    expect(tx.calls.filter((c) => c === "lock:code")).toHaveLength(3); // distinct codes, locked once each
    expect(tx.calls.indexOf("lock:code")).toBeGreaterThan(
      tx.calls.lastIndexOf("productBarcode.findMany"),
    );
  });

  it("refuses a set above the cap with a readable coded 409 and takes NO lock", async () => {
    const tx = makeTx({
      products: Array.from({ length: 5 }, (_, i) => product({ id: `p${i}`, sku: `S${i}` })),
    });
    const err = await lockCodesOfProducts(tx, T, ["p0", "p1", "p2", "p3", "p4"], 4).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "CATALOG_TOO_LARGE_FOR_CLEAR_ALL",
      codeCount: 5,
      max: 4,
    });
    expect(String(err.getResponse().message)).toMatch(/smaller batches/);
    expect(tx.calls).not.toContain("lock:code");
  });
});

describe("releaseProductCodes lockedCodes (Opus #2860 R1)", () => {
  it("r3 B1: a code outside the caller's set is refused BEFORE any lock is issued (a late lock would deadlock)", async () => {
    const tx = makeTx({ products: [product({ id: "p1", sku: "S1", barcode: "NEW" })] });
    const err = await releaseProductCodes(tx, {
      tenantId: T,
      productId: "p1",
      lockedCodes: new Set(["S1"]), // NEW appeared after the caller locked
    }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "CODES_CHANGED" });
    expect(tx.calls).not.toContain("lock:code");
    expect(tx.calls.some((c) => c.startsWith("lock:row"))).toBe(false);
  });

  it("a live code that was NOT in the caller's locked set is a 409 CODES_CHANGED and nothing is written", async () => {
    const tx = makeTx({ products: [product({ id: "p1", sku: "S1", barcode: "B1" })] });
    const err = await releaseProductCodes(tx, {
      tenantId: T,
      productId: "p1",
      lockedCodes: new Set(["S1"]), // B1 was not locked up front
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "CODES_CHANGED" });
    expect(tx.products[0]).toMatchObject({ sku: "S1", barcode: "B1", retiredSku: null });
  });

  it("with every code locked it releases as before", async () => {
    const tx = makeTx({ products: [product({ id: "p1", sku: "S1", barcode: "B1" })] });
    await releaseProductCodes(tx, {
      tenantId: T,
      productId: "p1",
      lockedCodes: new Set(["S1", "B1"]),
    });
    expect(tx.products[0]).toMatchObject({
      sku: null,
      barcode: null,
      retiredSku: "S1",
      retiredBarcode: "B1",
    });
  });
});

describe("claimCodes (create / update / reactivate collide with a holder)", () => {
  it("an ACTIVE holder is a 409 CODE_TAKEN naming it, and nothing is written", async () => {
    const tx = makeTx({ products: [product({ id: "h1", name: "Holder One", sku: "S1" })] });
    await expect(
      claimCodes(tx, {
        tenantId: T,
        productId: null,
        actorId: ACTOR,
        codes: [{ field: "sku", value: "S1" }],
      }),
    ).rejects.toMatchObject({
      response: {
        code: "CODE_TAKEN",
        field: "sku",
        value: "S1",
        productId: "h1",
        productName: "Holder One",
      },
    });
    expect(tx.calls.some((c) => c.startsWith("product.update"))).toBe(false);
    expect(tx.audits).toHaveLength(0);
  });

  it("an INACTIVE holder is released in the same tx with ONE audit row; the holder's other codes stay", async () => {
    const tx = makeTx({
      products: [
        product({ id: "h1", isActive: false, sku: "S1", barcode: "B1" }),
        product({ id: "h2", isActive: false, sku: "S2" }),
      ],
    });
    await claimCodes(tx, {
      tenantId: T,
      productId: null,
      actorId: ACTOR,
      codes: [{ field: "sku", value: "S1" }],
    });
    expect(tx.products[0]).toMatchObject({ sku: null, retiredSku: "S1", barcode: "B1" });
    expect(tx.products[1]).toMatchObject({ sku: "S2", retiredSku: null });
    expect(tx.calls).not.toContain("product.update:h2");
    expect(tx.audits).toHaveLength(1);
    expect(tx.audits[0].data).toMatchObject({
      tenantId: T,
      userId: ACTOR,
      action: CODE_RELEASED_ON_REUSE_ACTION,
      entityType: "Product",
      entityId: "h1",
    });
  });

  it("locks the code, then the holder row, then writes (source order)", async () => {
    const tx = makeTx({ products: [product({ id: "h1", isActive: false, sku: "S1" })] });
    await claimCodes(tx, {
      tenantId: T,
      productId: null,
      actorId: ACTOR,
      codes: [{ field: "sku", value: "S1" }],
    });
    const i = (c: string) => tx.calls.indexOf(c);
    expect(i("lock:code")).toBeLessThan(i("lock:row:h1"));
    expect(i("lock:row:h1")).toBeLessThan(i("product.update:h1"));
    expect(i("product.update:h1")).toBeLessThan(i("auditLog.create"));
  });

  it("a barcode held only by an inactive product's level rows is released there (one audit row)", async () => {
    const tx = makeTx({
      products: [product({ id: "h1", isActive: false })],
      barcodes: [row("r1", "h1", "BOX", "B9"), row("r2", "h1", "UNIT", "B9")],
    });
    await claimCodes(tx, {
      tenantId: T,
      productId: "me",
      actorId: ACTOR,
      codes: [{ field: "barcode", value: "B9" }],
    });
    expect(tx.barcodes.map((b) => [b.code, b.retiredCode])).toEqual([
      [null, "B9"],
      [null, "B9"],
    ]);
    expect(tx.audits).toHaveLength(1);
  });

  it("an ACTIVE holder through a level row is a 409 too (barcode namespace)", async () => {
    const tx = makeTx({
      products: [product({ id: "h1", name: "Row Holder" })],
      barcodes: [row("r1", "h1", "UNIT", "B9")],
    });
    await expect(
      claimCodes(tx, {
        tenantId: T,
        productId: "me",
        actorId: ACTOR,
        codes: [{ field: "barcode", value: "B9" }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("never treats the claiming product as its own holder", async () => {
    const tx = makeTx({ products: [product({ id: "me", sku: "S1" })] });
    await expect(
      claimCodes(tx, {
        tenantId: T,
        productId: "me",
        actorId: ACTOR,
        codes: [{ field: "sku", value: "S1" }],
      }),
    ).resolves.toBeUndefined();
    expect(tx.audits).toHaveLength(0);
  });

  it("sku and barcode namespaces stay separate (legacy rule): a sku equal to another product's barcode is allowed", async () => {
    const tx = makeTx({ products: [product({ id: "h1", barcode: "X1" })] });
    await expect(
      claimCodes(tx, {
        tenantId: T,
        productId: null,
        actorId: ACTOR,
        codes: [{ field: "sku", value: "X1" }],
      }),
    ).resolves.toBeUndefined();
  });

  it("a unit code collides with any other product's sku, barcode or unitSku", async () => {
    const tx = makeTx({ products: [product({ id: "h1", name: "Sku Holder", sku: "U7" })] });
    await expect(
      claimCodes(tx, {
        tenantId: T,
        productId: null,
        actorId: ACTOR,
        codes: [{ field: "unitSku", value: "U7" }],
      }),
    ).rejects.toMatchObject({
      response: { code: "CODE_TAKEN", field: "unitSku", productId: "h1" },
    });
  });
});

describe("restoreProductCodes (reactivate)", () => {
  it("restores every retired code that is still free and clears retired*", async () => {
    const tx = makeTx({
      products: [
        product({
          id: "p1",
          isActive: false,
          retiredSku: "S1",
          retiredBarcode: "B1",
          retiredUnitSku: "U1",
        }),
      ],
      barcodes: [row("r1", "p1", "UNIT", null, "B1")],
    });
    await restoreProductCodes(tx, { tenantId: T, productId: "p1", actorId: ACTOR });
    expect(tx.products[0]).toMatchObject({
      sku: "S1",
      barcode: "B1",
      unitSku: "U1",
      retiredSku: null,
      retiredBarcode: null,
      retiredUnitSku: null,
    });
    expect(tx.barcodes[0]).toMatchObject({ code: "B1", retiredCode: null });
  });

  it("an ACTIVE holder of a retired code is a 409 naming it; nothing is restored", async () => {
    const tx = makeTx({
      products: [
        product({ id: "p1", isActive: false, retiredSku: "S1" }),
        product({ id: "h1", name: "New Holder", sku: "S1" }),
      ],
    });
    await expect(
      restoreProductCodes(tx, { tenantId: T, productId: "p1", actorId: ACTOR }),
    ).rejects.toMatchObject({
      response: {
        code: "CODE_TAKEN",
        field: "sku",
        value: "S1",
        productId: "h1",
        productName: "New Holder",
      },
    });
    expect(tx.products[0]).toMatchObject({ sku: null, retiredSku: "S1" });
  });

  it("an INACTIVE holder of a retired code is released (audited) and the code restored", async () => {
    const tx = makeTx({
      products: [
        product({ id: "p1", isActive: false, retiredSku: "S1" }),
        product({ id: "h1", isActive: false, sku: "S1" }),
      ],
    });
    await restoreProductCodes(tx, { tenantId: T, productId: "p1", actorId: ACTOR });
    expect(tx.products[0]).toMatchObject({ sku: "S1", retiredSku: null });
    expect(tx.products[1]).toMatchObject({ sku: null, retiredSku: "S1" });
    expect(tx.audits).toHaveLength(1);
  });

  it("keeps a code set while inactive (live wins) and drops the stale retired value", async () => {
    const tx = makeTx({
      products: [product({ id: "p1", isActive: false, sku: "NEW", retiredSku: "OLD" })],
    });
    await restoreProductCodes(tx, { tenantId: T, productId: "p1", actorId: ACTOR });
    expect(tx.products[0]).toMatchObject({ sku: "NEW", retiredSku: null });
  });

  it("is a no-op for a product with nothing retired", async () => {
    const tx = makeTx({ products: [product({ id: "p1", sku: "S1" })] });
    await restoreProductCodes(tx, { tenantId: T, productId: "p1", actorId: ACTOR });
    expect(tx.calls.some((c) => c.startsWith("product.update"))).toBe(false);
  });
});
