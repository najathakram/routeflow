import {
  assertBarcodeAvailable,
  lockBarcodeCodes,
  syncProductBarcodesFromLegacy,
  syncProductImagesFromLegacy,
} from "./product-catalog-sync";

/**
 * T8 (#2728 M1 build-plan): a mocked `tx` recording every call in order, so the lock/read/write
 * SEQUENCE can be asserted, not just the end state. `calls` is a flat log of every model/raw call
 * this mock makes; each helper pushes `{ op, args }` before doing its (fake) work.
 */
type Call = { op: string; args: unknown };

interface BarcodeRow {
  id: string;
  tenantId: string;
  productId: string;
  code: string;
  level: string;
  origin: string;
  copiedFromLevel: string | null;
  primaryFor: string | null;
}
interface ProductRow {
  id: string;
  tenantId: string;
  barcode: string | null;
}
interface ImageRow {
  id: string;
  tenantId: string;
  productId: string;
  storageKey: string;
  sortOrder: number;
  isPrimary: boolean;
  focalX: number | null;
  focalY: number | null;
}

function makeTx(
  seed: { barcodes?: BarcodeRow[]; products?: ProductRow[]; images?: ImageRow[] } = {},
) {
  const calls: Call[] = [];
  let barcodeRows = [...(seed.barcodes ?? [])];
  const productRows = [...(seed.products ?? [])];
  let imageRows = [...(seed.images ?? [])];

  const matchesIdFilter = (id: string, filter: unknown): boolean => {
    if (filter == null) return true;
    if (
      typeof filter === "object" &&
      filter !== null &&
      "not" in (filter as Record<string, unknown>)
    ) {
      return id !== (filter as { not: string }).not;
    }
    return id === filter;
  };

  const tx = {
    calls,
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ op: "$executeRaw", args: { text: strings.join("?"), values } });
      return Promise.resolve(1);
    }),
    productBarcode: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        calls.push({ op: "productBarcode.findFirst", args: { where } });
        const match = barcodeRows.find(
          (r) =>
            r.tenantId === where.tenantId &&
            r.code === where.code &&
            matchesIdFilter(r.productId, where.productId),
        );
        return Promise.resolve(match ? { productId: match.productId } : null);
      }),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        calls.push({ op: "productBarcode.findMany", args: { where } });
        return Promise.resolve(
          barcodeRows
            .filter((r) => r.tenantId === where.tenantId && r.productId === where.productId)
            .map((r) => ({
              id: r.id,
              code: r.code,
              level: r.level,
              origin: r.origin,
              copiedFromLevel: r.copiedFromLevel,
              primaryFor: r.primaryFor,
            })),
        );
      }),
      deleteMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) => {
        calls.push({ op: "productBarcode.deleteMany", args: { where } });
        const ids = new Set(where.id.in);
        barcodeRows = barcodeRows.filter((r) => !ids.has(r.id));
        return Promise.resolve({ count: ids.size });
      }),
      createMany: jest.fn(({ data }: { data: Omit<BarcodeRow, "id">[] }) => {
        calls.push({ op: "productBarcode.createMany", args: { data } });
        for (const d of data) barcodeRows.push({ id: `new-${barcodeRows.length}`, ...d });
        return Promise.resolve({ count: data.length });
      }),
    },
    product: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        calls.push({ op: "product.findFirst", args: { where } });
        const match = productRows.find(
          (r) =>
            r.tenantId === where.tenantId &&
            r.barcode === where.barcode &&
            matchesIdFilter(r.id, where.id),
        );
        return Promise.resolve(match ? { id: match.id } : null);
      }),
    },
    productImage: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        calls.push({ op: "productImage.findMany", args: { where } });
        return Promise.resolve(
          imageRows.filter((r) => r.tenantId === where.tenantId && r.productId === where.productId),
        );
      }),
      deleteMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) => {
        calls.push({ op: "productImage.deleteMany", args: { where } });
        const ids = new Set(where.id.in);
        imageRows = imageRows.filter((r) => !ids.has(r.id));
        return Promise.resolve({ count: ids.size });
      }),
      create: jest.fn(({ data }: { data: Omit<ImageRow, "id"> }) => {
        calls.push({ op: "productImage.create", args: { data } });
        const row = { id: `new-img-${imageRows.length}`, ...data };
        imageRows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<ImageRow> }) => {
        calls.push({ op: "productImage.update", args: { where, data } });
        imageRows = imageRows.map((r) => (r.id === where.id ? { ...r, ...data } : r));
        return Promise.resolve();
      }),
    },
  };
  return tx;
}

describe("lockBarcodeCodes (T8)", () => {
  it("locks each DISTINCT non-blank code once, in sorted order, keyed tenantId:code", async () => {
    const tx = makeTx();
    await lockBarcodeCodes(tx, "t1", ["222", null, "111", "", "  ", "111", undefined, "222"]);
    const raws = tx.calls.filter((c) => c.op === "$executeRaw");
    expect(raws).toHaveLength(2);
    expect((raws[0].args as { values: unknown[] }).values).toEqual(["product-barcode", "t1:111"]);
    expect((raws[1].args as { values: unknown[] }).values).toEqual(["product-barcode", "t1:222"]);
  });
});

describe("assertBarcodeAvailable (T8/T9 SA-572b Q3)", () => {
  it("another product's ProductBarcode row holding the code -> 409 BARCODE_TAKEN with holder productId", async () => {
    const tx = makeTx({
      barcodes: [
        {
          id: "b1",
          tenantId: "t1",
          productId: "holder-1",
          code: "999",
          level: "UNIT",
          origin: "ENTERED",
          copiedFromLevel: null,
          primaryFor: "UNIT",
        },
      ],
    });
    await expect(
      assertBarcodeAvailable(tx, { tenantId: "t1", productId: "me", code: "999" }),
    ).rejects.toMatchObject({
      getResponse: expect.any(Function),
    });
    try {
      await assertBarcodeAvailable(tx, { tenantId: "t1", productId: "me", code: "999" });
      throw new Error("expected a throw");
    } catch (e) {
      const body = (e as { getResponse: () => unknown }).getResponse();
      expect(body).toMatchObject({ code: "BARCODE_TAKEN", barcode: "999", productId: "holder-1" });
    }
    expect(tx.calls.some((c) => c.op === "productBarcode.createMany")).toBe(false);
    expect(tx.calls.some((c) => c.op === "productBarcode.deleteMany")).toBe(false);
  });

  it("another (un-backfilled) legacy Product row holding the code -> the same 409", async () => {
    const tx = makeTx({ products: [{ id: "holder-2", tenantId: "t1", barcode: "555" }] });
    try {
      await assertBarcodeAvailable(tx, { tenantId: "t1", productId: "me", code: "555" });
      throw new Error("expected a throw");
    } catch (e) {
      const body = (e as { getResponse: () => unknown }).getResponse();
      expect(body).toMatchObject({ code: "BARCODE_TAKEN", barcode: "555", productId: "holder-2" });
    }
  });

  it("a create (productId null) is blocked by ANY existing holder of the code", async () => {
    const tx = makeTx({ products: [{ id: "holder-3", tenantId: "t1", barcode: "777" }] });
    await expect(
      assertBarcodeAvailable(tx, { tenantId: "t1", productId: null, code: "777" }),
    ).rejects.toBeTruthy();
  });

  it("no holder -> resolves, and the lock precedes the first find read (source-order pin)", async () => {
    const tx = makeTx();
    await lockBarcodeCodes(tx, "t1", ["333"]);
    await assertBarcodeAvailable(tx, { tenantId: "t1", productId: "me", code: "333" });
    const firstLockIdx = tx.calls.findIndex((c) => c.op === "$executeRaw");
    const firstFindIdx = tx.calls.findIndex(
      (c) => c.op === "productBarcode.findFirst" || c.op === "product.findFirst",
    );
    expect(firstLockIdx).toBeGreaterThanOrEqual(0);
    expect(firstFindIdx).toBeGreaterThan(firstLockIdx);
  });
});

describe("syncProductBarcodesFromLegacy (T8)", () => {
  it("empty productId throws before any tx call", async () => {
    const tx = makeTx();
    await expect(
      syncProductBarcodesFromLegacy(tx, {
        tenantId: "t1",
        productId: "",
        barcode: "123",
        unitsPerBox: 1,
      }),
    ).rejects.toThrow();
    expect(tx.calls).toHaveLength(0);
  });

  it("empty tenantId throws before any tx call", async () => {
    const tx = makeTx();
    await expect(
      syncProductBarcodesFromLegacy(tx, {
        tenantId: "",
        productId: "p1",
        barcode: "123",
        unitsPerBox: 1,
      }),
    ).rejects.toThrow();
    expect(tx.calls).toHaveLength(0);
  });

  it("the lock precedes the first find*/read (SA-572c source-order pin)", async () => {
    const tx = makeTx();
    await syncProductBarcodesFromLegacy(tx, {
      tenantId: "t1",
      productId: "p1",
      barcode: "036000291452",
      unitsPerBox: 1,
    });
    const firstLockIdx = tx.calls.findIndex((c) => c.op === "$executeRaw");
    const firstReadIdx = tx.calls.findIndex(
      (c) =>
        c.op === "productBarcode.findFirst" ||
        c.op === "product.findFirst" ||
        c.op === "productBarcode.findMany",
    );
    expect(firstLockIdx).toBe(0);
    expect(firstReadIdx).toBeGreaterThan(firstLockIdx);
  });

  it("upb 1 -> 12 (same code): the UNIT ENTERED row is deleted, BOX ENTERED + UNIT COPIED created", async () => {
    const tx = makeTx({
      barcodes: [
        {
          id: "row-unit",
          tenantId: "t1",
          productId: "p1",
          code: "036000291452",
          level: "UNIT",
          origin: "ENTERED",
          copiedFromLevel: null,
          primaryFor: "UNIT",
        },
      ],
    });
    await syncProductBarcodesFromLegacy(tx, {
      tenantId: "t1",
      productId: "p1",
      barcode: "036000291452",
      unitsPerBox: 12,
    });
    const del = tx.calls.find((c) => c.op === "productBarcode.deleteMany");
    expect((del?.args as { where: { id: { in: string[] } } }).where.id.in).toEqual(["row-unit"]);
    const created = tx.calls.find((c) => c.op === "productBarcode.createMany");
    const rows = (created?.args as { data: Array<{ level: string; origin: string }> }).data;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "BOX", origin: "ENTERED" }),
        expect.objectContaining({ level: "UNIT", origin: "COPIED" }),
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("barcode cleared -> this product's rows are deleted, tenantId+productId asserted in the where", async () => {
    const tx = makeTx({
      barcodes: [
        {
          id: "row-box",
          tenantId: "t1",
          productId: "p1",
          code: "999",
          level: "BOX",
          origin: "ENTERED",
          copiedFromLevel: null,
          primaryFor: "BOX",
        },
        {
          id: "row-unit",
          tenantId: "t1",
          productId: "p1",
          code: "999",
          level: "UNIT",
          origin: "COPIED",
          copiedFromLevel: "BOX",
          primaryFor: "UNIT",
        },
      ],
    });
    await syncProductBarcodesFromLegacy(tx, {
      tenantId: "t1",
      productId: "p1",
      barcode: null,
      unitsPerBox: 12,
    });
    const del = tx.calls.find((c) => c.op === "productBarcode.deleteMany");
    expect(del).toBeTruthy();
    const where = (
      del?.args as { where: { tenantId: string; productId: string; id: { in: string[] } } }
    ).where;
    expect(where.tenantId).toBe("t1");
    expect(where.productId).toBe("p1");
    expect(new Set(where.id.in)).toEqual(new Set(["row-box", "row-unit"]));
    expect(tx.calls.some((c) => c.op === "productBarcode.createMany")).toBe(false);
  });

  it("another product holding the new code -> 409, no createMany/deleteMany", async () => {
    const tx = makeTx({
      products: [{ id: "holder", tenantId: "t1", barcode: "444" }],
    });
    await expect(
      syncProductBarcodesFromLegacy(tx, {
        tenantId: "t1",
        productId: "p1",
        barcode: "444",
        unitsPerBox: 1,
      }),
    ).rejects.toMatchObject({ getResponse: expect.any(Function) });
    expect(tx.calls.some((c) => c.op === "productBarcode.createMany")).toBe(false);
    expect(tx.calls.some((c) => c.op === "productBarcode.deleteMany")).toBe(false);
  });
});

describe("syncProductImagesFromLegacy (T8)", () => {
  it("reorder: sortOrder/isPrimary updated; a removed key is deleted; focal parsed from the key", async () => {
    const tx = makeTx({
      images: [
        {
          id: "img-a",
          tenantId: "t1",
          productId: "p1",
          storageKey: "products/p1/a.jpg",
          sortOrder: 0,
          isPrimary: true,
          focalX: null,
          focalY: null,
        },
        {
          id: "img-b",
          tenantId: "t1",
          productId: "p1",
          storageKey: "products/p1/b-fp30x70.jpg",
          sortOrder: 1,
          isPrimary: false,
          focalX: null,
          focalY: null,
        },
        {
          id: "img-c",
          tenantId: "t1",
          productId: "p1",
          storageKey: "products/p1/c.jpg",
          sortOrder: 2,
          isPrimary: false,
          focalX: null,
          focalY: null,
        },
      ],
    });
    // Reordered: b first (now primary), a second, c dropped.
    await syncProductImagesFromLegacy(tx, {
      tenantId: "t1",
      productId: "p1",
      imageKeys: ["products/p1/b-fp30x70.jpg", "products/p1/a.jpg"],
    });
    const del = tx.calls.find((c) => c.op === "productImage.deleteMany");
    expect((del?.args as { where: { id: { in: string[] } } }).where.id.in).toEqual(["img-c"]);
    const updates = tx.calls.filter((c) => c.op === "productImage.update");
    const bUpdate = updates.find((c) => (c.args as { where: { id: string } }).where.id === "img-b");
    expect((bUpdate?.args as { data: Record<string, unknown> }).data).toMatchObject({
      sortOrder: 0,
      isPrimary: true,
      focalX: 30,
      focalY: 70,
    });
    const aUpdate = updates.find((c) => (c.args as { where: { id: string } }).where.id === "img-a");
    expect((aUpdate?.args as { data: Record<string, unknown> }).data).toMatchObject({
      sortOrder: 1,
      isPrimary: false,
    });
  });

  it("empty productId throws before any tx call", async () => {
    const tx = makeTx();
    await expect(
      syncProductImagesFromLegacy(tx, { tenantId: "t1", productId: "", imageKeys: [] }),
    ).rejects.toThrow();
    expect(tx.calls).toHaveLength(0);
  });
});
