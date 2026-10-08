/**
 * Test kit for the PUT /products/:id/units specs: a small in-memory Prisma stand-in with REAL
 * transaction semantics (snapshot -> restore on throw), so "a failure after the TenantUnit upsert
 * leaves no TenantUnit" is proven by end state, not by call counts. Not production code.
 */
export const TENANT = "tenant-a";

type Row = Record<string, any>;

function matchesValue(actual: unknown, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (filter === null) return actual == null;
  if (typeof filter === "object") {
    const f = filter as Record<string, any>;
    if ("equals" in f) {
      return f.mode === "insensitive"
        ? String(actual).toLowerCase() === String(f.equals).toLowerCase()
        : actual === f.equals;
    }
    if ("not" in f) return f.not === null ? actual != null : actual !== f.not;
    if ("in" in f) return (f.in ?? []).includes(actual);
    if ("notIn" in f) return !(f.notIn ?? []).includes(actual);
  }
  return actual === filter;
}

export function makeDb(seed: {
  products?: Row[];
  units?: Row[];
  tenantUnits?: Row[];
  barcodes?: Row[];
  /** Order/invoice lines: { productId, unitLabel, unitsPerBox } */
  lines?: Row[];
}) {
  const state = {
    product: (seed.products ?? []).map((r) => ({ ...r })),
    productUnit: (seed.units ?? []).map((r) => ({ ...r })),
    tenantUnit: (seed.tenantUnits ?? []).map((r) => ({ ...r })),
    productBarcode: (seed.barcodes ?? []).map((r) => ({ ...r })),
    lines: (seed.lines ?? []).map((r) => ({ ...r })),
  };
  let seq = 0;
  const calls: string[] = [];
  /** Test hook: throw from this write once (to prove rollback). */
  const failOn: { op?: string } = {};

  const matches = (row: Row, where: Row | undefined): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
      if (k === "AND") return (v as Row[]).every((w) => matches(row, w));
      if (k === "NOT") return !matches(row, v as Row);
      return matchesValue(row[k], v);
    });

  const table = (name: "product" | "productUnit" | "tenantUnit" | "productBarcode") => {
    const rows = () => state[name] as Row[];
    return {
      findMany: async ({ where, orderBy }: Row = {}) => {
        void orderBy;
        return rows()
          .filter((r) => matches(r, where))
          .map((r) => ({ ...r }));
      },
      findFirst: async ({ where }: Row = {}) => {
        const r = rows().find((x) => matches(x, where));
        return r ? { ...r } : null;
      },
      create: async ({ data }: Row) => {
        calls.push(`${name}.create`);
        if (failOn.op === `${name}.create`) throw new Error(`boom ${name}.create`);
        if (
          name === "productUnit" &&
          rows().some(
            (r) =>
              r.productId === data.productId &&
              (r.label === data.label || r.factorToBase === data.factorToBase),
          )
        ) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = { id: `${name}-${++seq}`, ...data };
        rows().push(row);
        return { ...row };
      },
      createMany: async ({ data }: Row) => {
        calls.push(`${name}.createMany`);
        for (const d of data) rows().push({ id: `${name}-${++seq}`, ...d });
        return { count: data.length };
      },
      update: async ({ where, data }: Row) => {
        calls.push(`${name}.update`);
        if (failOn.op === `${name}.update`) throw new Error(`boom ${name}.update`);
        const r = rows().find((x) => matches(x, where));
        if (!r) throw new Error("not found");
        // Prisma ignores `undefined` fields: they leave the column as it is.
        Object.assign(
          r,
          Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
        );
        return { ...r };
      },
      updateMany: async ({ where, data }: Row) => {
        calls.push(`${name}.updateMany`);
        const hit = rows().filter((x) => matches(x, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      delete: async ({ where }: Row) => {
        calls.push(`${name}.delete`);
        const i = rows().findIndex((x) => matches(x, where));
        if (i >= 0) rows().splice(i, 1);
        return {};
      },
      deleteMany: async ({ where }: Row) => {
        calls.push(`${name}.deleteMany`);
        const keep = rows().filter((x) => !matches(x, where));
        const n = rows().length - keep.length;
        (state as any)[name] = keep;
        return { count: n };
      },
    };
  };

  // Lines are read through order/invoice parents (the production query shape).
  const lineParent = () => ({
    findFirst: async ({ where }: Row) => {
      const w = (where.lineItems ?? where.items).some as Row;
      const hit = state.lines.find(
        (l) =>
          l.productId === w.productId &&
          String(l.unitLabel).toLowerCase() === String(w.unitLabel.equals).toLowerCase() &&
          (w.OR as Row[]).some((o) => matchesValue(l.unitsPerBox, o.unitsPerBox)),
      );
      return hit ? { id: "doc" } : null;
    },
  });

  const client: Row = {
    $executeRaw: async (..._a: unknown[]) => {
      calls.push("$executeRaw");
      return 1;
    },
    $queryRaw: async (..._a: unknown[]) => {
      calls.push("$queryRaw");
      return [];
    },
    product: table("product"),
    productUnit: table("productUnit"),
    tenantUnit: table("tenantUnit"),
    productBarcode: table("productBarcode"),
    order: lineParent(),
    invoice: lineParent(),
  };

  const snapshot = () => JSON.parse(JSON.stringify(state));
  const prisma = {
    getTenantId: () => TENANT,
    forTenant: () => client,
    tenantTransaction: async (fn: (tx: Row) => Promise<unknown>) => {
      const before = snapshot();
      try {
        return await fn(client);
      } catch (e) {
        Object.assign(state, before);
        throw e;
      }
    },
  };
  return { prisma, client, state: state as any, calls, failOn };
}

/** A promise-chain mutex standing in for withAdvisoryLock: serializes critical sections per key. */
export function makeFakeLock() {
  const tails = new Map<string, Promise<unknown>>();
  const taken: Array<{ family: string; key: string }> = [];
  const withAdvisoryLock = jest.fn(
    async (opts: { family: string; key: string }, fn: () => Promise<unknown>) => {
      taken.push({ family: opts.family, key: opts.key });
      const id = `${opts.family}:${opts.key}`;
      const prev = tails.get(id) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      tails.set(
        id,
        prev.then(() => mine),
      );
      await prev;
      try {
        return { acquired: true as const, value: await fn() };
      } finally {
        release();
      }
    },
  );
  return { withAdvisoryLock, taken };
}
