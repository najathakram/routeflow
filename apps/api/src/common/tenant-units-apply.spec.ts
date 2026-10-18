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
  TENANT_UNITS_LOCK_SQL,
  PRODUCT_UNITS_LOCK_SQL,
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
  tenantUnits: Array<{
    id: string;
    tenantId: string;
    nameKey: string;
    name: string;
    archivedAt?: Date | null;
  }>;
  productUnits: Unit[];
  products: Array<{ id: string; tenantId: string; unit: string; unitsPerBox: number | null }>;
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
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      log.push(params.length > 0 ? `exec:${sql} [${params.join(",")}]` : `exec:${sql}`);
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
      if (sql.includes('"Product"')) {
        log.push("share:packs");
        return state.products
          .filter((p) => p.tenantId === tenantId && ids.includes(p.id))
          .map((p) => ({ id: p.id, unitsPerBox: p.unitsPerBox }));
      }
      log.push("share:parents");
      return state.productUnits
        .filter((u) => u.tenantId === tenantId && ids.includes(u.id))
        .map((u) => ({ id: u.id, productId: u.productId, factorToBase: u.factorToBase }));
    },
    tenantUnit: {
      // active units (archivedAt null), what U-1's unitRoom counts
      count: async ({ where }: any) => {
        log.push("count");
        return state.tenantUnits.filter(
          (u) => u.tenantId === where.tenantId && (u.archivedAt ?? null) === where.archivedAt,
        ).length;
      },
      // the names that already exist (archived included: the unique key spans them)
      findMany: async ({ where }: { where: { tenantId: string; nameKey: { in: string[] } } }) => {
        log.push("findMany");
        return state.tenantUnits
          .filter((u) => u.tenantId === where.tenantId && where.nameKey.in.includes(u.nameKey))
          .map((u) => ({ nameKey: u.nameKey }));
      },
      // skipDuplicates on the unique (tenantId, nameKey): returns the rows ACTUALLY inserted
      createMany: async ({ data, skipDuplicates }: any) => {
        log.push("createMany");
        if (!skipDuplicates) throw new Error("createMany without skipDuplicates");
        let count = 0;
        for (const d of data) {
          if (state.tenantUnits.some((u) => u.tenantId === d.tenantId && u.nameKey === d.nameKey))
            continue;
          state.tenantUnits.push({ id: `tu${++seq}`, ...d });
          count += 1;
        }
        return { count };
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
  products: Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    tenantId: TENANT,
    unit: "Tray",
    unitsPerBox: null,
  })),
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
      id: "six0",
      tenantId: TENANT,
      productId: "p0",
      label: "Six",
      tenantUnitId: null,
      factorToBase: 6,
      parentUnitId: null,
      perParent: null,
    });
    const f = fake(state);
    await runOnce(state, f, 5);
    const batch = f.stats.ops[1];
    const firstWrite = batch.indexOf("write");
    for (const read of ["share:units", "share:parents", "share:packs"]) {
      expect(batch.indexOf(read)).toBeGreaterThan(-1);
      expect(batch.indexOf(read)).toBeLessThan(firstWrite);
    }
    expect(state.productUnits.find((u) => u.id === "pu0")).toMatchObject({
      parentUnitId: "six0",
      perParent: 2,
    });
  });

  describe("U-1's ladder locks (MUST 2): tenant units SHARED, then each product, before any row lock", () => {
    const tenantLock = `exec:${TENANT_UNITS_LOCK_SQL} [${TENANT}]`;
    const productLock = (id: string) => `exec:${PRODUCT_UNITS_LOCK_SQL} [${id}]`;

    it("the exact statements are the ones tenant-units-lock.ts issues", () => {
      expect(TENANT_UNITS_LOCK_SQL).toBe(
        "SELECT pg_advisory_xact_lock_shared(hashtext('tenant-units'), hashtext($1))",
      );
      expect(PRODUCT_UNITS_LOCK_SQL).toBe(
        "SELECT pg_advisory_xact_lock(hashtext('product-units'), hashtext($1))",
      );
    });

    it("each batch tx: timeouts, the tenant lock, the batch's products sorted, THEN reads and writes", async () => {
      const state = seed(5); // p0..p4, batch size 2 => [p0,p1] [p2,p3] [p4]
      const f = fake(state);
      await runOnce(state, f, 2);
      const batches = f.stats.ops.slice(1); // ops[0] is the unit-create tx
      expect(batches).toHaveLength(3);
      const expected = [["p0", "p1"], ["p2", "p3"], ["p4"]];
      batches.forEach((ops, i) => {
        expect(ops.slice(0, 2 + 1 + expected[i].length)).toEqual([
          ...WRITE_TIMEOUTS.map((s: string) => `exec:${s}`),
          tenantLock,
          ...expected[i].map(productLock),
        ]);
        const firstRowOp = ops.findIndex((o) => o.startsWith("share:") || o === "write");
        expect(firstRowOp).toBe(2 + 1 + expected[i].length);
      });
    });

    it("products are locked in sorted order whatever order the plan lists them", async () => {
      const state = seed(3);
      state.productUnits.reverse(); // plan sees pu2, pu1, pu0
      const f = fake(state);
      await runOnce(state, f, 5);
      expect(f.stats.ops[1].slice(2, 6)).toEqual([
        tenantLock,
        productLock("p0"),
        productLock("p1"),
        productLock("p2"),
      ]);
    });

    it("a product with a link AND a parent fill is locked once", async () => {
      const state = seed(1);
      const f = fake(state);
      await runOnce(state, f, 5);
      expect(f.stats.ops[1].filter((o) => o.includes("product-units"))).toHaveLength(1);
    });

    it("the unit-create tx takes no ladder lock (it writes no ladder data)", async () => {
      const state = seed(1);
      const f = fake(state);
      await runOnce(state, f, 5);
      expect(f.stats.ops[0].some((o) => o.includes("advisory"))).toBe(false);
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

  it("a mid-run failure says how many batches had committed, and onBatch saw each commit", async () => {
    const state = seed(6);
    const seen: Array<[number, number]> = [];
    const f = fake(state, { failUnitUpdateAt: 9 }); // batch 3 of 3 (4 writes per batch)
    const plan = planTenantUnits({
      productUnits: state.productUnits.map((u) => ({ ...u })),
      products: state.products,
      existingUnits: [],
    });
    const err = await applyTenantUnitsPlan({
      prisma: f.db,
      tenantId: TENANT,
      plan,
      productIdByUnit: new Map(state.productUnits.map((u) => [u.id, u.productId])),
      batchSize: 2,
      onBatch: (done: number, total: number) => seen.push([done, total]),
    }).catch((e: unknown) => e);
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
    ]);
    expect(err).toMatchObject({ message: "boom", batchesCommitted: 2, batchesTotal: 3 });
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

  it("a pack fill writes parentUnitId NULL and f / upb; a pack that moved is skipped", async () => {
    const state = seed(2);
    state.products[0].unitsPerBox = 4; // Case 12 = 3 packs of 4
    state.products[1].unitsPerBox = 4;
    const f = fake(state, {
      beforeTx: (n, st) => {
        if (n === 2) st.products[1].unitsPerBox = 6; // p1's pack changed under the apply
      },
    });
    const r = await runOnce(state, f, 5);
    expect(state.productUnits[0]).toMatchObject({ parentUnitId: null, perParent: 3 });
    expect(state.productUnits[1]).toMatchObject({ parentUnitId: null, perParent: null });
    expect(r).toMatchObject({ parentFilled: 1, parentsChanged: 1 });
  });

  it("reports the units ACTUALLY inserted: one created by someone else since planning is not counted", async () => {
    const state = seed(2);
    const f = fake(state, {
      beforeTx: (n, st) => {
        if (n === 1)
          st.tenantUnits.push({ id: "theirs", tenantId: TENANT, nameKey: "tray", name: "Tray" });
      },
    });
    const r = await runOnce(state, f, 5);
    expect(r.unitsCreated).toBe(1); // case; tray already existed when the insert ran
    expect(state.tenantUnits.map((u) => u.nameKey).sort()).toEqual(["case", "tray"]);
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

  describe("SA-810 cap at apply time (a system writer: never refuses, never exceeds 200)", () => {
    const crowd = (n: number, archived = 0) => [
      ...Array.from({ length: n }, (_, i) => ({
        id: `x${i}`,
        tenantId: TENANT,
        nameKey: `have${i}`,
        name: `Have${i}`,
      })),
      ...Array.from({ length: archived }, (_, i) => ({
        id: `a${i}`,
        tenantId: TENANT,
        nameKey: `old${i}`,
        name: `Old${i}`,
        archivedAt: new Date("2026-01-01"),
      })),
    ];
    const toCreate = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `New${i}`, nameKey: `new${i}` }));
    const active = (s: State) => s.tenantUnits.filter((u) => !u.archivedAt).length;

    it("units added by someone else since planning shrink the room: it creates only what fits", async () => {
      const state: State = { ...seed(0), tenantUnits: crowd(198) };
      const f = fake(state);
      const r = await applyTenantUnitsPlan({
        prisma: f.db,
        tenantId: TENANT,
        plan: { toCreate: toCreate(5), links: [], parentFills: [] },
        productIdByUnit: new Map(),
      });
      expect(r.unitsCreated).toBe(2);
      expect(r.unitsCapped).toBe(3);
      expect(active(state)).toBe(200);
    });

    it("a tenant over the cap (230 active, 7 archived) gets 0 new units and no createMany at all", async () => {
      const state: State = { ...seed(0), tenantUnits: crowd(230, 7) };
      const f = fake(state);
      const r = await applyTenantUnitsPlan({
        prisma: f.db,
        tenantId: TENANT,
        plan: { toCreate: toCreate(4), links: [], parentFills: [] },
        productIdByUnit: new Map(),
      });
      expect(r.unitsCreated).toBe(0);
      expect(r.unitsCapped).toBe(4);
      expect(active(state)).toBe(230);
      expect(f.stats.ops.flat()).not.toContain("createMany");
    });

    it("archived units are not counted: 190 active + 40 archived leaves room for 10", async () => {
      const state: State = { ...seed(0), tenantUnits: crowd(190, 40) };
      const r = await applyTenantUnitsPlan({
        prisma: fake(state).db,
        tenantId: TENANT,
        plan: { toCreate: toCreate(10), links: [], parentFills: [] },
        productIdByUnit: new Map(),
      });
      expect(r.unitsCreated).toBe(10);
      expect(r.unitsCapped).toBe(0);
    });

    it("a level whose unit was capped out at apply time is left unlinked, reported as over the cap (not 'changed')", async () => {
      const state: State = { ...seed(1), tenantUnits: crowd(200) };
      const plan = {
        toCreate: [{ name: "Case", nameKey: "case" }],
        links: [{ productUnitId: "pu0", nameKey: "case", label: "Case" }],
        parentFills: [],
      };
      const r = await applyTenantUnitsPlan({
        prisma: fake(state).db,
        tenantId: TENANT,
        plan,
        productIdByUnit: new Map([["pu0", "p0"]]),
      });
      expect(r.unitsCreated).toBe(0);
      expect(r.linked).toBe(0);
      expect(r.linksOverCap).toBe(1);
      expect(r.linksChanged).toBe(0);
      expect(r.unitsCappedNames).toEqual(["Case"]);
      expect(state.productUnits[0].tenantUnitId).toBeNull();
    });

    // 3 words, 197 active: room 3 at planning. aaa and bbb have 1 use each, zzz has 100.
    const usageState = (): State => {
      const s = seed(0);
      s.tenantUnits = crowd(197);
      s.products = [
        { id: "pa", tenantId: TENANT, unit: "aaa", unitsPerBox: null },
        { id: "pb", tenantId: TENANT, unit: "bbb", unitsPerBox: null },
      ];
      s.productUnits = Array.from({ length: 100 }, (_, i) => ({
        id: `z${i}`,
        tenantId: TENANT,
        productId: `pz${i}`,
        label: "zzz",
        tenantUnitId: null,
        factorToBase: 1,
        parentUnitId: null,
        perParent: null,
      }));
      return s;
    };
    const planned = (s: State) =>
      planTenantUnits({
        productUnits: s.productUnits.map((u) => ({ ...u })),
        products: s.products,
        existingUnits: s.tenantUnits.map((u) => ({ nameKey: u.nameKey })),
      });
    const applyIt = (s: State, f: ReturnType<typeof fake>) =>
      applyTenantUnitsPlan({
        prisma: f.db,
        tenantId: TENANT,
        plan: planned(s),
        productIdByUnit: new Map(s.productUnits.map((u) => [u.id, u.productId])),
      });
    const addTwo = (n: number, st: State) => {
      if (n !== 1) return;
      for (const k of ["mine1", "mine2"])
        st.tenantUnits.push({ id: k, tenantId: TENANT, nameKey: k, name: k });
    };

    it("the plan lists the most used first, so a shrunken room keeps zzz (100 uses), not aaa", async () => {
      const state = usageState();
      expect(planned(state).toCreate.map((c: { nameKey: string }) => c.nameKey)).toEqual([
        "zzz",
        "aaa",
        "bbb",
      ]);
      // two units added since planning: room 3 -> 1
      const r = await applyIt(state, fake(state, { beforeTx: addTwo }));
      expect(r.unitsCreated).toBe(1);
      expect(state.tenantUnits.some((u) => u.nameKey === "zzz")).toBe(true);
      expect(state.tenantUnits.some((u) => u.nameKey === "aaa")).toBe(false);
      expect(r.unitsCapped).toBe(2);
      expect(r.unitsCappedNames).toEqual(["aaa", "bbb"]);
      // zzz's 100 levels are linked; the capped names have no levels
      expect(r.linked).toBe(100);
    });

    it("a name someone created since planning does not waste a slot", async () => {
      const state = usageState();
      // 1 unit added (room 3 -> 2) and it is zzz itself: [aaa, bbb] both still fit
      const r = await applyIt(
        state,
        fake(state, {
          beforeTx: (n, st) => {
            if (n === 1)
              st.tenantUnits.push({ id: "theirs", tenantId: TENANT, nameKey: "zzz", name: "Zzz" });
          },
        }),
      );
      expect(r.unitsCreated).toBe(2);
      expect(r.unitsCapped).toBe(0);
      expect(state.tenantUnits.filter((u) => !u.archivedAt)).toHaveLength(200);
    });
  });
});
