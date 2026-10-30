/**
 * SA-927 §1 unit-spec wiring: the REAL `applyStockMovements` runs over a mock Prisma. It needs two things
 * the plain mock lacks: a tx `$queryRaw` that answers its locked read (id / currentStock / averageCost /
 * costingMethod, tenant-scoped, by the `ANY(ids)` list) and a `stockMovement.createManyAndReturn`.
 *
 * The locked state is whatever the spec already stubbed on `product.findUnique` / `product.findMany`
 * (the last stub wins; a `mockImplementation` is called with the id), so a spec keeps its one source of
 * product state and the helper reads it as the locked row. `stateOf` overrides that for harnesses with
 * their own in-memory stock. The movements the helper wrote are read back with `writtenMovements`.
 */
import { Prisma } from "@prisma/client";
import type { MockPrisma } from "../../testing/prisma-mock";

type Row = {
  id: string;
  currentStock?: Prisma.Decimal.Value;
  averageCost?: Prisma.Decimal.Value | null;
  costingMethod?: string;
};

export interface StockHelperMock {
  /** Every row the helper inserted, in call order (each `createManyAndReturn` call flattened). */
  written: () => Array<Record<string, any>>;
  /** For a spec that builds its own tx: add the helper's locked read to it (other raw queries keep its answer). */
  wrapTx: <T extends object>(tx: T) => T;
  /** A `$queryRaw` for a hand-built tx: answers the helper's locked read, passes other queries to `base`. */
  queryRaw: (base?: (...args: any[]) => unknown) => jest.Mock;
  /** Replace the locked-state source for the rest of the test. */
  setState: (fn: (ids: string[]) => Row[] | Promise<Row[]>) => void;
}

/** Wire `prisma` so the helper runs for real. Call right after `createMockPrisma()`. */
export function wireStockHelper(
  prisma: MockPrisma,
  opts: {
    stateOf?: (ids: string[]) => Row[] | Promise<Row[]>;
    /** Carry the helper's own absolute `product.update` writes into the next locked read (a multi-call tx). */
    track?: boolean;
    /** A product whose stub carries no `currentStock` has ample stock (master read no counter there), not 0. */
    ample?: boolean;
  } = {},
): StockHelperMock {
  let stateOf = opts.stateOf;
  const stubbed: { unique?: unknown; many?: unknown; first?: unknown } = {};

  // findFirst is the last fallback: a spec whose service reads the product through findFirst (the sale
  // cost resolver) states the product once there and the locked read sees it too.
  for (const name of ["findUnique", "findMany", "findFirst"] as const) {
    const fn = (prisma.product as unknown as Record<string, jest.Mock>)[name];
    const key = name === "findUnique" ? "unique" : name === "findMany" ? "many" : "first";
    const rv = fn.mockResolvedValue.bind(fn);
    const rvOnce = fn.mockResolvedValueOnce.bind(fn);
    const impl = fn.mockImplementation.bind(fn);
    fn.mockResolvedValue = (v: unknown) => {
      stubbed[key] = v;
      return rv(v);
    };
    fn.mockResolvedValueOnce = (v: unknown) => {
      stubbed[key] = v;
      return rvOnce(v);
    };
    fn.mockImplementation = (f: unknown) => {
      stubbed[key] = f;
      return impl(f as never);
    };
  }

  const valueOf = async (src: unknown, arg: unknown): Promise<unknown> =>
    typeof src === "function" ? await (src as (a: unknown) => unknown)(arg) : src;

  const read = async (ids: string[]): Promise<Row[]> => {
    if (stateOf) return stateOf(ids);
    const out = new Map<string, Row>();
    const many = (await valueOf(stubbed.many, { where: { id: { in: ids } } })) as Row[] | undefined;
    // a findMany stub that only names ids (no counter) is a lookup, not the locked state: findUnique supplies it
    for (const r of Array.isArray(many) ? many : [])
      if (r && ids.includes(r.id) && r.currentStock !== undefined) out.set(r.id, r);
    for (const id of ids) {
      if (out.has(id)) continue;
      const one = (await valueOf(stubbed.unique, { where: { id } })) as Row | null | undefined;
      if (one && (one.id === undefined || one.id === id)) out.set(id, { ...one, id });
    }
    if (out.size === 0 && ids.length === 1) {
      const first = (await valueOf(stubbed.first, { where: { id: ids[0] } })) as
        Row | null | undefined;
      if (first && (first.id === undefined || first.id === ids[0]))
        out.set(ids[0], { ...first, id: ids[0] });
    }
    // last fallback: a findMany row that names the id but carries no counter (currentStock defaults to 0)
    for (const r of Array.isArray(many) ? many : [])
      if (r && ids.includes(r.id) && !out.has(r.id)) out.set(r.id, r);
    // a product the spec never stubbed (master read none of it): ample stock, so no policy check trips
    for (const id of ids) if (!out.has(id)) out.set(id, { id, currentStock: 1_000_000_000 });
    return [...out.values()];
  };

  const applied = new Map<string, { currentStock?: unknown; averageCost?: unknown }>();
  if (opts.track) {
    const up = (prisma.product as unknown as Record<string, jest.Mock>).update;
    up.mockImplementation(async ({ where, data }: any) => {
      const prev = applied.get(where.id) ?? {};
      applied.set(where.id, {
        ...prev,
        ...(data?.currentStock !== undefined ? { currentStock: data.currentStock } : {}),
        ...(data?.averageCost !== undefined ? { averageCost: data.averageCost } : {}),
      });
      return { id: where.id };
    });
  }

  const lockedRead = async (sql: any): Promise<Row[]> => {
    const ids = (sql.values as unknown[]).find(Array.isArray) as string[];
    const rows = await read(ids);
    return rows.map((r) => ({
      id: r.id,
      currentStock:
        (applied.get(r.id)?.currentStock as never) ??
        r.currentStock ??
        (opts.ample ? 1_000_000_000 : 0),
      averageCost: (applied.get(r.id)?.averageCost as never) ?? r.averageCost ?? null,
      costingMethod: r.costingMethod ?? "AVCO",
    }));
  };

  const isLockedRead = (s: any) =>
    s != null &&
    typeof s === "object" &&
    !Array.isArray(s) &&
    typeof s.sql === "string" &&
    s.sql.includes('"costingMethod"') &&
    s.sql.includes("ANY(");

  // a $queryRaw that answers the helper's locked read (and the tenant setting) and hands every other
  // raw query to `base` - for a spec that builds its own tx with its own $queryRaw
  const queryRaw = (base?: (...a: any[]) => unknown) =>
    jest.fn((s: any, ...v: unknown[]) =>
      isLockedRead(s)
        ? lockedRead(s)
        : Array.isArray(s) && s.join("").includes("current_setting('app.current_tenant_id'")
          ? Promise.resolve([{ tenantId: "tenant-1" }])
          : base
            ? base(s, ...v)
            : Promise.resolve([]),
    );

  const wrapTx = (tx: any) => {
    const wrapped = queryRaw(tx.$queryRaw);
    const smTx = tx.stockMovement;
    // a hand-rolled tx has no createManyAndReturn: give it one that feeds its own stockMovement.create
    const stockMovement =
      smTx && !smTx.createManyAndReturn ? { ...smTx, createManyAndReturn: createMany(smTx) } : smTx;
    return { ...tx, $queryRaw: wrapped, ...(stockMovement ? { stockMovement } : {}) };
  };
  // each inserted row is also fed to the spec's own `stockMovement.create` mock (when it has one), so a
  // spec that counts/inspects `create` calls (or makes them fail) still sees the same row data
  const createMany = (smObj: any) =>
    jest.fn(async ({ data }: { data: Array<Record<string, any>> }) => {
      const out: Array<Record<string, unknown>> = [];
      for (const d of data) {
        if (typeof smObj?.create === "function") await smObj.create({ data: d });
        out.push({
          id: d.id,
          productId: d.productId,
          stockAfter: d.stockAfter,
          avgCostAfter: d.avgCostAfter,
        });
      }
      return out;
    });
  // a spec that passes the mock itself as the tx (`recordSale(..., prisma)`)
  (prisma as any).$queryRaw = wrapTx(prisma).$queryRaw;
  for (const name of ["tenantTransaction", "$transaction"] as const) {
    const fn = (prisma as unknown as Record<string, jest.Mock>)[name];
    const orig = fn.getMockImplementation();
    fn.mockImplementation((cb: any, ...rest: unknown[]) =>
      orig!((tx: any) => cb(wrapTx(tx)), ...rest),
    );
  }

  const sm = prisma.stockMovement as unknown as Record<string, jest.Mock>;
  sm.createManyAndReturn = createMany(sm);

  // the service re-reads the full row it just wrote (recordPurchase / recordAdjustment / setCostBasis)
  sm.findUniqueOrThrow.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const all = sm.createManyAndReturn.mock.calls.flatMap((c) => c[0].data as Array<any>);
    return all.find((d) => d.id === where.id) ?? { id: where.id };
  });

  return {
    written: () =>
      sm.createManyAndReturn.mock.calls.flatMap((c) => c[0].data as Array<Record<string, any>>),
    wrapTx: wrapTx as StockHelperMock["wrapTx"],
    queryRaw,
    setState: (fn) => {
      stateOf = fn;
    },
  };
}
