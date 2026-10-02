import { Prisma } from "@prisma/client";

/**
 * A fake transaction for the locked stock functions (`decrementStockForSale`, `settleStockForEdit`).
 * `$queryRaw` is the aggregated `UPDATE ... RETURNING` (it moves stock and returns the counter the
 * row now holds); `product.update` is the edit path's per-product write. `preRead` lets a spec make
 * the `product.findMany` read STALE (stock a concurrent order moved before this write — SA-606k C8)
 * while the write still acts on the real counter.
 */
export type FakeProduct = {
  id: string;
  name: string;
  currentStock: number;
  unitsPerBox: number | null;
};

const D = (n: number | string) => new Prisma.Decimal(n);
export const TENANT_ID = "t-1";

export function fakeStockTx(products: FakeProduct[], preRead?: Record<string, number>) {
  const isSql = (v: any) => typeof v?.sql === "string" && Array.isArray(v?.values);
  const flat = (v: any): any[] =>
    v == null ? [] : isSql(v) ? flat(v.values) : Array.isArray(v) ? v.flatMap(flat) : [v];
  const byId = (id: string) => products.find((p) => p.id === id)!;
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, ...values: any[]) => {
      const bound = flat(values).filter((v) => v !== TENANT_ID);
      const rows: { id: string; currentStock: Prisma.Decimal }[] = [];
      for (let i = 0; i < bound.length; i += 2) {
        const p = byId(bound[i]);
        p.currentStock -= Number(bound[i + 1]);
        rows.push({ id: p.id, currentStock: D(p.currentStock) });
      }
      return rows;
    }),
    product: {
      findMany: jest.fn(async ({ where }: any) =>
        products
          .filter((p) => where.id.in.includes(p.id))
          .map((p) => ({ ...p, currentStock: preRead?.[p.id] ?? p.currentStock })),
      ),
      findFirst: jest.fn(async () => ({
        costingMethod: "AVCO",
        averageCost: D(2),
        standardCost: null,
      })),
      update: jest.fn(async ({ where, data }: any) => {
        const p = byId(where.id);
        p.currentStock += Number(data.currentStock.increment ?? 0);
        p.currentStock -= Number(data.currentStock.decrement ?? 0);
        return { ...p, currentStock: D(p.currentStock) };
      }),
    },
    stockLot: { findMany: jest.fn().mockResolvedValue([]) },
    stockMovement: { create: jest.fn(async () => ({ id: "m" })) },
  };
  return tx;
}
