/**
 * Test kit for the code-release / reactivation specs: a tiny in-memory fake `tx` that records the call order, so the
 * lock-first source order is pinned, not only the end state. Not production code.
 */
export type ProductRow = {
  id: string;
  tenantId: string;
  name: string;
  isActive: boolean;
  parentProductId?: string | null;
  kind?: string;
  sku: string | null;
  barcode: string | null;
  unitSku: string | null;
  retiredSku: string | null;
  retiredBarcode: string | null;
  retiredUnitSku: string | null;
};
export type BarcodeRow = {
  id: string;
  tenantId: string;
  productId: string;
  level: string;
  code: string | null;
  retiredCode: string | null;
};

export const T = "tenant-a";
export const ACTOR = "user-1";

export function product(over: Partial<ProductRow> & { id: string }): ProductRow {
  return {
    tenantId: T,
    name: `Product ${over.id}`,
    isActive: true,
    sku: null,
    barcode: null,
    unitSku: null,
    retiredSku: null,
    retiredBarcode: null,
    retiredUnitSku: null,
    ...over,
  };
}

function matchesValue(actual: unknown, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (filter === null) return actual == null;
  if (filter !== null && typeof filter === "object") {
    const f = filter as { not?: unknown; in?: unknown[]; equals?: string; mode?: string };
    if ("equals" in f) {
      return f.mode === "insensitive"
        ? String(actual).toLowerCase() === String(f.equals).toLowerCase()
        : actual === f.equals;
    }
    if ("not" in f) return f.not === null ? actual != null : actual !== f.not;
    if ("in" in f) return (f.in ?? []).includes(actual);
  }
  return actual === filter;
}

export function makeTx(seed: { products: ProductRow[]; barcodes?: BarcodeRow[] }) {
  const calls: string[] = [];
  const products = seed.products.map((p) => ({ ...p }));
  const barcodes = (seed.barcodes ?? []).map((b) => ({ ...b }));
  const audits: Array<{ data: Record<string, unknown> }> = [];
  const matchesWhere = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "OR")
        return (v as Array<Record<string, unknown>>).some((w) => matchesWhere(row, w));
      return matchesValue(row[k], v);
    });
  const tx = {
    calls,
    products,
    barcodes,
    audits,
    $executeRaw: jest.fn((strings: TemplateStringsArray) => {
      calls.push(strings.join("?").includes("pg_advisory_xact_lock") ? "lock:code" : "raw");
      return Promise.resolve(1);
    }),
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`lock:row:${String(values[0])}`);
      return Promise.resolve([]);
    }),
    product: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        calls.push("product.findFirst");
        return Promise.resolve(products.find((p) => matchesWhere(p, where)) ?? null);
      }),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        calls.push("product.findMany");
        return Promise.resolve(products.filter((p) => matchesWhere(p, where)));
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<ProductRow> }) => {
        calls.push(`product.update:${where.id}`);
        const row = products.find((p) => p.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
    productBarcode: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        calls.push("productBarcode.findMany");
        return Promise.resolve(barcodes.filter((b) => matchesWhere(b, where)));
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<BarcodeRow> }) => {
        calls.push(`productBarcode.update:${where.id}`);
        Object.assign(
          barcodes.find((b) => b.id === where.id)!,
          data,
        );
        return Promise.resolve({});
      }),
    },
    auditLog: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        calls.push("auditLog.create");
        audits.push(args);
        return Promise.resolve({});
      }),
    },
  };
  return tx;
}

export const row = (
  id: string,
  productId: string,
  level: string,
  code: string | null,
  retired?: string,
) => ({ id, tenantId: T, productId, level, code, retiredCode: retired ?? null }) as BarcodeRow;
