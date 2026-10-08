/**
 * Units U-6: the write side of scripts/backfill-tenant-units.mjs, driven through an in-memory
 * Prisma stand-in with real transaction rollback. Pins: bounded transactions (N products each),
 * idempotent re-runs, and clean resume after a crash between batches.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planTenantUnits } = require("../../scripts/lib/tenant-units-plan.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  applyTenantUnitsPlan,
  batchWrites,
  BACKFILL_BATCH_SIZE,
} = require("../../scripts/lib/tenant-units-apply.cjs");

const TENANT = "t1";

type State = {
  tenantUnits: Array<{ id: string; tenantId: string; nameKey: string; name: string }>;
  productUnits: Array<{
    id: string;
    tenantId: string;
    productId: string;
    label: string;
    tenantUnitId: string | null;
  }>;
  products: Array<{ id: string; tenantId: string; unit: string; packLabel: string | null }>;
};

function fake(state: State, opts: { failProductUpdateAt?: number } = {}) {
  let seq = 0;
  let productUpdates = 0;
  const stats = { transactions: 0, productsPerTx: [] as number[] };
  let touched: Set<string> | null = null;
  const db = {
    tenantUnit: {
      upsert: async ({ where, create }: any) => {
        const k = where.tenantId_nameKey;
        let row = state.tenantUnits.find(
          (u) => u.tenantId === k.tenantId && u.nameKey === k.nameKey,
        );
        if (!row) {
          row = { id: `tu${++seq}`, ...create };
          state.tenantUnits.push(row!);
        }
        return { id: row!.id };
      },
    },
    productUnit: {
      updateMany: async ({ where, data }: any) => {
        const row = state.productUnits.find(
          (r) => r.id === where.id && r.tenantId === where.tenantId && r.tenantUnitId === null,
        );
        if (row) {
          row.tenantUnitId = data.tenantUnitId;
          touched?.add(row.productId);
        }
        return { count: row ? 1 : 0 };
      },
    },
    product: {
      updateMany: async ({ where, data }: any) => {
        productUpdates += 1;
        if (opts.failProductUpdateAt === productUpdates) throw new Error("boom");
        const row = state.products.find(
          (p) => p.id === where.id && p.tenantId === where.tenantId && !p.packLabel,
        );
        if (row) {
          row.packLabel = data.packLabel;
          touched?.add(row.id);
        }
        return { count: row ? 1 : 0 };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      stats.transactions += 1;
      const snap = JSON.parse(JSON.stringify(state));
      touched = new Set();
      try {
        const out = await fn(db);
        stats.productsPerTx.push(touched.size);
        return out;
      } catch (err) {
        state.tenantUnits = snap.tenantUnits;
        state.productUnits = snap.productUnits;
        state.products = snap.products;
        throw err;
      } finally {
        touched = null;
      }
    },
  };
  return { db, stats };
}

const seed = (n: number): State => ({
  tenantUnits: [],
  productUnits: Array.from({ length: n }, (_, i) => ({
    id: `pu${i}`,
    tenantId: TENANT,
    productId: `p${i}`,
    label: "Case",
    tenantUnitId: null,
  })),
  products: Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    tenantId: TENANT,
    unit: "Tray",
    packLabel: null,
  })),
});

async function runOnce(state: State, f: ReturnType<typeof fake>, batchSize?: number) {
  const productUnits = state.productUnits.map((u) => ({
    id: u.id,
    label: u.label,
    tenantUnitId: u.tenantUnitId,
  }));
  const productIdByUnit = new Map(state.productUnits.map((u) => [u.id, u.productId]));
  const plan = planTenantUnits({
    productUnits,
    products: state.products,
    existingUnits: state.tenantUnits.map((u) => ({ nameKey: u.nameKey })),
  });
  const existingUnits = state.tenantUnits.map((u) => ({ id: u.id, nameKey: u.nameKey }));
  return applyTenantUnitsPlan({
    prisma: f.db,
    tenantId: TENANT,
    plan,
    existingUnits,
    productIdByUnit,
    batchSize,
  });
}

describe("batched backfill apply (U-6)", () => {
  it("names a default batch size", () => {
    expect(Number.isInteger(BACKFILL_BATCH_SIZE)).toBe(true);
    expect(BACKFILL_BATCH_SIZE).toBeGreaterThan(0);
  });

  it("batchWrites groups by product, N products per batch, a product's writes stay together", () => {
    const plan = {
      links: [
        { productUnitId: "u1", nameKey: "case" },
        { productUnitId: "u2", nameKey: "case" },
        { productUnitId: "u3", nameKey: "case" },
      ],
      packFills: [
        { productId: "pa", packLabel: "Tray" },
        { productId: "pb", packLabel: "Tray" },
      ],
    };
    const byUnit = new Map([
      ["u1", "pa"],
      ["u2", "pa"],
      ["u3", "pc"],
    ]);
    const batches = batchWrites(plan, byUnit, 2);
    expect(batches).toHaveLength(2);
    const productsIn = (b: any) =>
      new Set([
        ...b.links.map((l: any) => byUnit.get(l.productUnitId)),
        ...b.packFills.map((f: any) => f.productId),
      ]);
    for (const b of batches) expect(productsIn(b).size).toBeLessThanOrEqual(2);
    const all = batches.flatMap((b: any) => b.links.map((l: any) => l.productUnitId)).sort();
    expect(all).toEqual(["u1", "u2", "u3"]);
    expect(batches.flatMap((b: any) => b.packFills)).toHaveLength(2);
    const holder = batches.find((b: any) => b.links.some((l: any) => l.productUnitId === "u1"));
    expect(holder.links.map((l: any) => l.productUnitId)).toContain("u2");
    expect(holder.packFills.map((f: any) => f.productId)).toContain("pa");
  });

  it("rejects a non-positive or non-integer batch size", () => {
    expect(() => batchWrites({ links: [], packFills: [] }, new Map(), 0)).toThrow();
    expect(() => batchWrites({ links: [], packFills: [] }, new Map(), 1.5)).toThrow();
  });

  it("applies in bounded transactions: never more than N products in one", async () => {
    const state = seed(7);
    const f = fake(state);
    await runOnce(state, f, 3);
    // 1 for the unit upserts + ceil(7 / 3) product batches
    expect(f.stats.transactions).toBe(1 + 3);
    expect(Math.max(...f.stats.productsPerTx)).toBeLessThanOrEqual(3);
    expect(state.productUnits.every((u) => u.tenantUnitId)).toBe(true);
    expect(state.products.every((p) => p.packLabel === "Tray")).toBe(true);
  });

  it("is idempotent: a second run opens no transaction and writes nothing", async () => {
    const state = seed(5);
    await runOnce(state, fake(state), 2);
    const before = JSON.stringify(state);
    const f2 = fake(state);
    const r = await runOnce(state, f2, 2);
    expect(f2.stats.transactions).toBe(0);
    expect(r.batches).toBe(0);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("a crash between batches keeps finished batches and resumes cleanly", async () => {
    const state = seed(6);
    // batch size 2 => 3 product batches; the 4th product update (batch 2) throws
    await expect(runOnce(state, fake(state, { failProductUpdateAt: 4 }), 2)).rejects.toThrow(
      "boom",
    );
    const done = state.products.filter((p) => p.packLabel).length;
    expect(done).toBe(2); // batch 1 committed; batch 2 rolled back whole
    expect(state.tenantUnits).toHaveLength(2); // case + tray survive (own earlier transaction)
    const linkedProducts = new Set(
      state.productUnits.filter((u) => u.tenantUnitId).map((u) => u.productId),
    );
    expect(linkedProducts.size).toBe(2); // links and fills move together per product
    const f2 = fake(state);
    await runOnce(state, f2, 2);
    expect(state.tenantUnits).toHaveLength(2); // no duplicate unit
    expect(state.products.every((p) => p.packLabel === "Tray")).toBe(true);
    expect(state.productUnits.every((u) => u.tenantUnitId)).toBe(true);
    // resume only did the remaining 2 batches (no unit-create transaction needed)
    expect(f2.stats.transactions).toBe(2);
  });
});
