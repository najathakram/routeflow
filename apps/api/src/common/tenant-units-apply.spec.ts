/**
 * Units U-6: the write side of scripts/backfill-tenant-units.mjs, driven through an in-memory
 * Prisma stand-in with real transaction rollback. Pins: bounded transactions (N products each), the
 * timeouts every transaction sets first, the FOR SHARE re-reads before any write (SA M4), no Product
 * write at all (SA M1), compare-and-set parent fills (SA M2), idempotent re-runs, clean resume after a
 * crash between batches, and a row edited between plan and apply never overwritten.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planTenantUnits } = require("../../scripts/lib/tenant-units-plan.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  applyTenantUnitsPlan,
  batchWrites,
  BACKFILL_BATCH_SIZE,
  WRITE_TIMEOUTS,
} = require("../../scripts/lib/tenant-units-apply.cjs");

const TENANT = "t1";

type Unit = {
  id: string;
  tenantId: string;
  productId: string;
  label: string;
  tenantUnitId: string | null;
  factorToBase: number;
  parentUnitId: string | null;
  perParent: number | null;
};
type State = {
  tenantUnits: Array<{ id: string; tenantId: string; nameKey: string; name: string }>;
  productUnits: Unit[];
  products: Array<{ id: string; tenantId: string; unit: string }>;
};

/**
 * Evaluates a Prisma `where` against a row the way Prisma does for the shapes used here: every key
 * must match (null matches NULL) and an `undefined` key is DROPPED (that is how Prisma widens a where,
 * so the fake must widen too).
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
}

function fake(
  state: State,
  opts: {
    failUnitUpdateAt?: number;
    /** Runs at the start of the nth transaction: an operator edit landing mid-run. */
    beforeTx?: (n: number, state: State) => void;
  } = {},
) {
  let seq = 0;
  let unitUpdates = 0;
  const stats = { transactions: 0, productsPerTx: [] as number[], ops: [] as string[][] };
  let touched: Set<string> | null = null;
  let log: string[] = [];
  // No `product` model: the backfill must never write (or even reach for) a Product (SA M1).
  const db = {
    $executeRawUnsafe: async (sql: string) => {
      log.push(`exec:${sql}`);
      return 0;
    },
    $queryRawUnsafe: async (sql: string, tenantId: string, ids: string[]) => {
      if (!/FOR SHARE/.test(sql)) throw new Error(`unexpected query: ${sql}`);
      if (sql.includes('"TenantUnit"')) {
        log.push("share:units");
        return state.tenantUnits
          .filter((u) => u.tenantId === tenantId && ids.includes(u.nameKey))
          .map((u) => ({ id: u.id, nameKey: u.nameKey }));
      }
      log.push("share:parents");
      return state.productUnits
        .filter((u) => u.tenantId === tenantId && ids.includes(u.id))
        .map((u) => ({ id: u.id, productId: u.productId, factorToBase: u.factorToBase }));
    },
    tenantUnit: {
      upsert: async ({ where, create }: any) => {
        log.push("upsert");
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
        log.push("write");
        unitUpdates += 1;
        if (opts.failUnitUpdateAt === unitUpdates) throw new Error("boom");
        const rows = state.productUnits.filter((r) => matches(r, where));
        for (const row of rows) {
          Object.assign(row, data);
          touched?.add(row.productId);
        }
        return { count: rows.length };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      stats.transactions += 1;
      opts.beforeTx?.(stats.transactions, state);
      const snap = JSON.parse(JSON.stringify(state));
      touched = new Set();
      log = [];
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
        stats.ops.push(log);
        touched = null;
      }
    },
  };
  return { db, stats };
}

/** n products, each with one "Case" level of 12 (no base row): plans a link + a parent fill each. */
const seed = (n: number): State => ({
  tenantUnits: [],
  productUnits: Array.from({ length: n }, (_, i) => ({
    id: `pu${i}`,
    tenantId: TENANT,
    productId: `p${i}`,
    label: "Case",
    tenantUnitId: null,
    factorToBase: 12,
    parentUnitId: null,
    perParent: null,
  })),
  products: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, tenantId: TENANT, unit: "Tray" })),
});

async function runOnce(state: State, f: ReturnType<typeof fake>, batchSize?: number) {
  const productUnits = state.productUnits.map((u) => ({ ...u }));
  const plan = planTenantUnits({
    productUnits,
    products: state.products,
    existingUnits: state.tenantUnits.map((u) => ({ nameKey: u.nameKey })),
  });
  return applyTenantUnitsPlan({
    prisma: f.db,
    tenantId: TENANT,
    plan,
    productIdByUnit: new Map(state.productUnits.map((u) => [u.id, u.productId])),
    batchSize,
  });
}

const fillsFor = (n: number) => ({
  links: [],
  parentFills: Array.from({ length: n }, (_, i) => ({
    productUnitId: `u${i}`,
    productId: `p${String(i).padStart(4, "0")}`,
  })),
});

describe("batched backfill apply (U-6)", () => {
  it("batches at the boundary: 0 / 200 / 201 products are 0 / 1 / 2 batches", () => {
    expect(BACKFILL_BATCH_SIZE).toBe(200);
    expect(batchWrites(fillsFor(0), new Map())).toHaveLength(0);
    expect(batchWrites(fillsFor(200), new Map())).toHaveLength(1);
    const two = batchWrites(fillsFor(201), new Map());
    expect(two.map((b: { parentFills: unknown[] }) => b.parentFills.length)).toEqual([200, 1]);
  });

  it("batchWrites groups by product, N products per batch, a product's writes stay together", () => {
    const plan = {
      links: [
        { productUnitId: "u1", nameKey: "case" },
        { productUnitId: "u2", nameKey: "case" },
        { productUnitId: "u3", nameKey: "case" },
      ],
      parentFills: [
        { productUnitId: "u1", productId: "pa" },
        { productUnitId: "u4", productId: "pb" },
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
        ...b.parentFills.map((f: any) => f.productId),
      ]);
    for (const b of batches) expect(productsIn(b).size).toBeLessThanOrEqual(2);
    const holder = batches.find((b: any) => b.links.some((l: any) => l.productUnitId === "u1"));
    expect(holder.links.map((l: any) => l.productUnitId)).toContain("u2");
    expect(holder.parentFills.map((f: any) => f.productId)).toContain("pa");
  });

  it("rejects a non-positive or non-integer batch size", () => {
    expect(() => batchWrites({ links: [], parentFills: [] }, new Map(), 0)).toThrow();
    expect(() => batchWrites({ links: [], parentFills: [] }, new Map(), 1.5)).toThrow();
  });

  it("applies in bounded transactions, each setting lock + statement timeouts first", async () => {
    const state = seed(7);
    const f = fake(state);
    const r = await runOnce(state, f, 3);
    // 1 for the unit upserts + ceil(7 / 3) product batches
    expect(f.stats.transactions).toBe(1 + 3);
    expect(Math.max(...f.stats.productsPerTx)).toBeLessThanOrEqual(3);
    for (const ops of f.stats.ops) {
      expect(ops.slice(0, 2)).toEqual(WRITE_TIMEOUTS.map((s: string) => `exec:${s}`));
    }
    expect(WRITE_TIMEOUTS.join(" ")).toMatch(/lock_timeout.*statement_timeout/);
    expect(state.productUnits.every((u) => u.tenantUnitId && u.perParent === 12)).toBe(true);
    expect(r).toMatchObject({ linked: 7, parentFilled: 7, linksChanged: 0, parentsChanged: 0 });
  });

  it("never writes a Product (SA M1): products are byte-identical after a run", async () => {
    const state = seed(4);
    const before = JSON.stringify(state.products);
    await runOnce(state, fake(state), 2);
    expect(JSON.stringify(state.products)).toBe(before);
  });

  it("re-reads the batch's units and parents FOR SHARE before any write (SA M4)", async () => {
    const state = seed(2);
    state.productUnits.push({
      id: "base0",
      tenantId: TENANT,
      productId: "p0",
      label: "Piece",
      tenantUnitId: null,
      factorToBase: 1,
      parentUnitId: null,
      perParent: null,
    });
    const f = fake(state);
    await runOnce(state, f, 5);
    const batch = f.stats.ops[1];
    const firstWrite = batch.indexOf("write");
    expect(batch.indexOf("share:units")).toBeGreaterThan(-1);
    expect(batch.indexOf("share:parents")).toBeGreaterThan(-1);
    expect(batch.indexOf("share:units")).toBeLessThan(firstWrite);
    expect(batch.indexOf("share:parents")).toBeLessThan(firstWrite);
    expect(state.productUnits.find((u) => u.id === "pu0")).toMatchObject({
      parentUnitId: "base0",
      perParent: 12,
    });
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
    // batch size 2 => 3 product batches of 4 unit writes each; the 5th write (batch 2) throws
    await expect(runOnce(state, fake(state, { failUnitUpdateAt: 5 }), 2)).rejects.toThrow("boom");
    const doneProducts = new Set(
      state.productUnits.filter((u) => u.tenantUnitId || u.perParent).map((u) => u.productId),
    );
    expect(doneProducts.size).toBe(2); // batch 1 committed; batch 2 rolled back whole
    expect(state.tenantUnits).toHaveLength(2); // case + tray survive (own earlier transaction)
    const f2 = fake(state);
    await runOnce(state, f2, 2);
    expect(state.tenantUnits).toHaveLength(2); // no duplicate unit
    expect(state.productUnits.every((u) => u.tenantUnitId && u.perParent === 12)).toBe(true);
    // resume only did the remaining 2 batches (no unit-create transaction needed)
    expect(f2.stats.transactions).toBe(2);
  });

  it("a row edited between plan and apply is never overwritten, and is reported as changed", async () => {
    const state = seed(6);
    // tx 1 = unit upserts; tx 2 = p0,p1; tx 3 = p2,p3 (edited just before it opens); tx 4 = p4,p5
    const f = fake(state, {
      beforeTx: (n, st) => {
        if (n !== 3) return;
        st.productUnits[2].label = "Renamed"; // level renamed: the Case link is stale
        st.productUnits[2].factorToBase = 10; // factor changed: the parent fill is stale
        st.productUnits[3].tenantUnitId = "manual"; // someone linked it
        st.productUnits[3].perParent = 3; // someone set the chain
      },
    });
    const r = await runOnce(state, f, 2);
    expect(state.productUnits[2]).toMatchObject({
      label: "Renamed",
      tenantUnitId: null,
      factorToBase: 10,
      perParent: null,
    });
    expect(state.productUnits[3]).toMatchObject({ tenantUnitId: "manual", perParent: 3 });
    for (const i of [0, 1, 4, 5]) {
      expect(state.productUnits[i]).toMatchObject({ perParent: 12 });
      expect(state.productUnits[i].tenantUnitId).toBeTruthy();
    }
    // counts are what was ACTUALLY written, not what was planned
    expect(r).toMatchObject({ linked: 4, parentFilled: 4, linksChanged: 2, parentsChanged: 2 });
  });

  it("a unit deleted since planning is not linked or recreated; the link is reported changed", async () => {
    const state = seed(2);
    const f = fake(state, {
      beforeTx: (n, st) => {
        if (n === 2) st.tenantUnits = st.tenantUnits.filter((u) => u.nameKey !== "case");
      },
    });
    const r = await runOnce(state, f, 5);
    expect(state.tenantUnits.map((u) => u.nameKey)).toEqual(["tray"]);
    expect(state.productUnits.every((u) => u.tenantUnitId === null)).toBe(true);
    expect(r).toMatchObject({ linked: 0, linksChanged: 2, parentFilled: 2 });
  });

  it("a parent whose factor moved since planning is not filled against", async () => {
    const state = seed(1);
    state.productUnits.push({
      id: "six",
      tenantId: TENANT,
      productId: "p0",
      label: "Six",
      tenantUnitId: null,
      factorToBase: 6,
      parentUnitId: null,
      perParent: null,
    });
    const f = fake(state, {
      beforeTx: (n, st) => {
        if (n === 2) st.productUnits.find((u) => u.id === "six")!.factorToBase = 4;
      },
    });
    const r = await runOnce(state, f, 5);
    // pu0 (12) planned against six (6, x2): the parent is now 4, so pu0 is left alone
    expect(state.productUnits.find((u) => u.id === "pu0")).toMatchObject({
      parentUnitId: null,
      perParent: null,
    });
    expect(r.parentsChanged).toBeGreaterThanOrEqual(1);
  });
});
