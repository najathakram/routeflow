import * as fs from "fs";
import * as path from "path";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  assertBarcodeAvailable,
  isBarcodeUniqueViolation,
  lockBarcodeCodes,
  mapBarcodeUniqueViolation,
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
  productId: string | null;
  storageKey: string;
  sortOrder: number;
  isPrimary: boolean;
  focalX: number | null;
  focalY: number | null;
}

/** The fake's code filter: an exact string, or `{ in: [...] }` (B1214: every equivalent spelling of a label). */
function matchesCode(value: unknown, filter: unknown): boolean {
  if (filter && typeof filter === "object" && "in" in (filter as object)) {
    return (filter as { in: unknown[] }).in.includes(value);
  }
  return value === filter;
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
            matchesCode(r.code, where.code) &&
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
      deleteMany: jest.fn(({ where }: { where: { id?: { in: string[] } } }) => {
        calls.push({ op: "productBarcode.deleteMany", args: { where } });
        // SA-603a: the stale-released-row purge (`code: null`) carries no id list — nothing released in the mock.
        const ids = new Set(where.id?.in ?? []);
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
            matchesCode(r.barcode, where.barcode) &&
            matchesIdFilter(r.id, where.id),
        );
        return Promise.resolve(match ? { id: match.id } : null);
      }),
    },
    productImage: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        calls.push({ op: "productImage.findMany", args: { where } });
        if ("storageKey" in where) {
          const inList = (where.storageKey as { in: string[] }).in;
          // Models `OR: [{ productId: { not: X } }, { productId: null }]` (a row of another product,
          // or a tray row with no product, holds the key).
          const orArms =
            (where.OR as Array<{ productId: { not: string } | null }> | undefined) ?? [];
          const notProductId = orArms.find((a) => a.productId !== null)?.productId?.not;
          return Promise.resolve(
            imageRows
              .filter(
                (r) =>
                  r.tenantId === where.tenantId &&
                  inList.includes(r.storageKey) &&
                  (notProductId === undefined ||
                    r.productId === null ||
                    r.productId !== notProductId),
              )
              .map((r) => ({ storageKey: r.storageKey, productId: r.productId })),
          );
        }
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

  // #2728 M1 follow-up (SA-572f, amendment 1 — FINAL): legacy (pre-#2533) imageKeys can hold a
  // duplicate key or a key that names another product's own prefix (a planted foreign key). Mirror
  // only mirrorableImageKeys (own, deduped) and skip — PER KEY, never throw, never touch another
  // product's row — any key another product's row already holds.
  it("a duplicate key mirrors ONCE: k1 sortOrder 0 primary, k2 sortOrder 1 (exactly 2 creates)", async () => {
    const tx = makeTx();
    await syncProductImagesFromLegacy(tx, {
      tenantId: "t1",
      productId: "p1",
      imageKeys: ["products/p1/k1.jpg", "products/p1/k1.jpg", "products/p1/k2.jpg"],
    });
    const creates = tx.calls.filter((c) => c.op === "productImage.create");
    expect(creates).toHaveLength(2);
    expect((creates[0].args as { data: Record<string, unknown> }).data).toMatchObject({
      storageKey: "products/p1/k1.jpg",
      sortOrder: 0,
      isPrimary: true,
    });
    expect((creates[1].args as { data: Record<string, unknown> }).data).toMatchObject({
      storageKey: "products/p1/k2.jpg",
      sortOrder: 1,
      isPrimary: false,
    });
  });

  it("a foreign-prefixed key (not this product's own) never mirrors: no row for it", async () => {
    const tx = makeTx();
    await syncProductImagesFromLegacy(tx, {
      tenantId: "t1",
      productId: "p1",
      imageKeys: ["products/p1/k1.jpg", "products/OTHER/x.jpg"],
    });
    const creates = tx.calls.filter((c) => c.op === "productImage.create");
    expect(creates).toHaveLength(1);
    expect((creates[0].args as { data: Record<string, unknown> }).data.storageKey).toBe(
      "products/p1/k1.jpg",
    );
  });

  it("a key another product's row already holds is SKIPPED (per-key), never thrown, other keys still mirror", async () => {
    const tx = makeTx({
      images: [
        {
          id: "img-other",
          tenantId: "t1",
          productId: "other-product",
          storageKey: "products/p1/k1.jpg",
          sortOrder: 0,
          isPrimary: true,
          focalX: null,
          focalY: null,
        },
      ],
    });
    await expect(
      syncProductImagesFromLegacy(tx, {
        tenantId: "t1",
        productId: "p1",
        imageKeys: ["products/p1/k1.jpg", "products/p1/k2.jpg"],
      }),
    ).resolves.toBeUndefined();
    const creates = tx.calls.filter((c) => c.op === "productImage.create");
    expect(creates).toHaveLength(1);
    expect((creates[0].args as { data: Record<string, unknown> }).data).toMatchObject({
      storageKey: "products/p1/k2.jpg",
      sortOrder: 1,
    });
    // Never touches (deletes/updates) the OTHER product's row.
    expect(tx.calls.some((c) => c.op === "productImage.deleteMany")).toBe(false);
  });

  it("a TRAY row (productId NULL) holding a key counts as held too: skipped, never a unique-violation create", async () => {
    const tx = makeTx({
      images: [
        {
          id: "img-tray",
          tenantId: "t1",
          productId: null,
          storageKey: "products/p1/k1.jpg",
          sortOrder: 0,
          isPrimary: false,
          focalX: null,
          focalY: null,
        },
      ],
    });
    await syncProductImagesFromLegacy(tx, {
      tenantId: "t1",
      productId: "p1",
      imageKeys: ["products/p1/k1.jpg"],
    });
    expect(tx.calls.filter((c) => c.op === "productImage.create")).toHaveLength(0);
    const held = tx.calls.find(
      (c) =>
        c.op === "productImage.findMany" && "storageKey" in (c.args as { where: object }).where,
    );
    expect((held?.args as { where: { OR: unknown[] } }).where.OR).toContainEqual({
      productId: null,
    });
  });
});

/**
 * SA-572c / SA-572g source pin: every caller's tx body must call `lockBarcodeCodes(` BEFORE
 * `assertBarcodeAvailable(` (source order, matched pairwise in order of appearance — each caller
 * has exactly one of each). This is the ordering the RACE pin in products-dual-write.db.spec.ts
 * (SA-572c RACE) exercises against a real Postgres advisory lock.
 *
 * revert-red: remove the xact lock (or reorder the two calls) in any of these tx bodies and this
 * fails immediately, with no Postgres needed — the loser would otherwise pass
 * assertBarcodeAvailable (it can't see the uncommitted winner), block on the legacy unique in
 * product.create, get P2002, and the mapped 409 would carry productId null instead of the winner's
 * id (the exact failure the DB-lane race pin's productId assertion is there to catch).
 */
describe("source pin: lockBarcodeCodes precedes assertBarcodeAvailable in every caller tx body", () => {
  const FILES = ["products.service.ts", path.join("..", "import", "import.service.ts")];

  it("lockBarcodeCodes( appears before its paired assertBarcodeAvailable( in each file", () => {
    let totalPairs = 0;
    for (const rel of FILES) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
      const lockIdxs: number[] = [];
      const assertIdxs: number[] = [];
      for (const m of src.matchAll(/lockBarcodeCodes\(/g)) lockIdxs.push(m.index as number);
      for (const m of src.matchAll(/assertBarcodeAvailable\(/g)) assertIdxs.push(m.index as number);
      expect(lockIdxs.length).toBeGreaterThan(0);
      // Extra lock calls are legitimate (the deactivate/release paths lock codes and assert nothing, SA-603a), but
      // EVERY assertBarcodeAvailable must be preceded by its own lock since the previous assert.
      expect(lockIdxs.length).toBeGreaterThanOrEqual(assertIdxs.length);
      let prevAssert = -1;
      for (const a of assertIdxs) {
        const lock = Math.max(-1, ...lockIdxs.filter((l) => l < a));
        expect(lock).toBeGreaterThan(prevAssert);
        prevAssert = a;
      }
      totalPairs += assertIdxs.length;
    }
    // Non-vacuous: both files together must have found real pairs to check.
    expect(totalPairs).toBeGreaterThanOrEqual(4);
  });
});

/**
 * SA-572h (a): the P2002 belt must recognise the error the Prisma pg DRIVER ADAPTER actually raises.
 * With the adapter there is no `meta.target`: the constraint rides in
 * `meta.driverAdapterError.cause.constraint` as `{ index: <name> }` or `{ fields: [...] }` (read from
 * @prisma/adapter-pg's 23505 mapping and @prisma/client's error construction). The predicate is scoped
 * to exactly two constraints, Product(tenantId, barcode) and ProductBarcode(tenantId, code, level);
 * every other unique violation, including the other constraints of the same tables, is rethrown.
 */
function p2002(meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta,
  });
}
const adapterMeta = (
  constraint: { index?: string; fields?: string[] } | undefined,
  table?: string,
): Record<string, unknown> => ({
  driverAdapterError: {
    name: "DriverAdapterError",
    cause: { kind: "UniqueConstraintViolation", constraint, table },
  },
});

describe("isBarcodeUniqueViolation / mapBarcodeUniqueViolation (SA-572h a)", () => {
  it("adapter shape, constraint NAME: Product(tenantId, barcode) is a barcode conflict", () => {
    const e = p2002(adapterMeta({ index: "Product_tenantId_barcode_key" }, "Product"));
    expect(isBarcodeUniqueViolation(e)).toBe(true);
  });

  it("adapter shape, constraint NAME: ProductBarcode(tenantId, code, level) is a barcode conflict", () => {
    const e = p2002(
      adapterMeta({ index: "ProductBarcode_tenantId_code_level_key" }, "ProductBarcode"),
    );
    expect(isBarcodeUniqueViolation(e)).toBe(true);
  });

  it("adapter shape, constraint FIELDS (no index name): the two barcode field sets match, order-insensitive", () => {
    expect(isBarcodeUniqueViolation(p2002(adapterMeta({ fields: ["tenantId", "barcode"] })))).toBe(
      true,
    );
    expect(isBarcodeUniqueViolation(p2002(adapterMeta({ fields: ["barcode", "tenantId"] })))).toBe(
      true,
    );
    expect(
      isBarcodeUniqueViolation(p2002(adapterMeta({ fields: ["tenantId", "code", "level"] }))),
    ).toBe(true);
  });

  it("native-engine shape (meta.target): a field array and a constraint-name string both still match", () => {
    expect(isBarcodeUniqueViolation(p2002({ target: ["tenantId", "barcode"] }))).toBe(true);
    expect(isBarcodeUniqueViolation(p2002({ target: "Product_tenantId_barcode_key" }))).toBe(true);
    expect(isBarcodeUniqueViolation(p2002({ target: ["tenantId", "code", "level"] }))).toBe(true);
  });

  it("NEGATIVE: another table's / another constraint's P2002 is NOT a barcode conflict", () => {
    const others: Array<Record<string, unknown>> = [
      adapterMeta({ index: "ProductImage_tenantId_storageKey_key" }, "ProductImage"),
      adapterMeta({ fields: ["tenantId", "storageKey"] }, "ProductImage"),
      adapterMeta({ index: "Product_tenantId_sku_key" }, "Product"),
      adapterMeta({ fields: ["tenantId", "sku"] }, "Product"),
      adapterMeta({ index: "Product_tenantId_unitSku_key" }, "Product"),
      // The SAME table, but the one-primary-per-level constraint: a bug signal, not a code conflict.
      adapterMeta({ index: "ProductBarcode_productId_primaryFor_key" }, "ProductBarcode"),
      adapterMeta({ fields: ["productId", "primaryFor"] }, "ProductBarcode"),
      // A name that merely CONTAINS the substrings the old predicate matched on.
      adapterMeta({ index: "Customer_tenantId_barcodeReaderId_key" }, "Customer"),
      adapterMeta({ index: "PromoCode_tenantId_code_key" }, "PromoCode"),
      adapterMeta({ fields: ["tenantId", "code"] }, "PromoCode"),
      { target: ["tenantId", "code"] },
      {},
      adapterMeta(undefined),
    ];
    for (const meta of others) expect(isBarcodeUniqueViolation(p2002(meta))).toBe(false);
  });

  it("NEGATIVE: a non-P2002 Prisma error, a plain Error and a non-error are not barcode conflicts", () => {
    const notUnique = new Prisma.PrismaClientKnownRequestError("nope", {
      code: "P2025",
      clientVersion: "test",
      meta: adapterMeta({ index: "Product_tenantId_barcode_key" }),
    });
    expect(isBarcodeUniqueViolation(notUnique)).toBe(false);
    expect(isBarcodeUniqueViolation(new Error("Product_tenantId_barcode_key"))).toBe(false);
    expect(isBarcodeUniqueViolation("P2002")).toBe(false);
    expect(isBarcodeUniqueViolation(null)).toBe(false);
  });

  it("mapBarcodeUniqueViolation: an adapter-shaped barcode P2002 becomes the 409 BARCODE_TAKEN body", () => {
    const e = p2002(adapterMeta({ index: "Product_tenantId_barcode_key" }, "Product"));
    let thrown: unknown;
    try {
      mapBarcodeUniqueViolation(e, "036000291452");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toMatchObject({
      code: "BARCODE_TAKEN",
      barcode: "036000291452",
      productId: null,
    });
  });

  it("mapBarcodeUniqueViolation: another table's P2002 is rethrown UNCHANGED (same object)", () => {
    const e = p2002(adapterMeta({ index: "ProductImage_tenantId_storageKey_key" }, "ProductImage"));
    let thrown: unknown;
    try {
      mapBarcodeUniqueViolation(e, "x");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(e);
  });
});
