/**
 * A small in-memory stand-in for Postgres row semantics, built for "claim" specs: it applies the
 * `where` a service actually sends to stored rows, so a conditional `updateMany` returns a real
 * count (0 for the loser of a race) and a transaction that throws undoes its own writes.
 *
 * Supported `where` shapes: equality (including `null`), `{ gt }`, `{ in }`, `{ not }`, `{ none }` (a to-many
 * relation key holding an array of rows), `OR`, `AND`, and a
 * nested relation filter (a plain object on a key whose stored value is an object).
 *
 * `installFakeTables(prisma, tables)` points the listed models of a `createMockPrisma()` at the
 * tables, for plain calls AND for the `tx` handed to `$transaction` / `tenantTransaction`
 * callbacks. Every model method is async and yields once before touching state, so two
 * `Promise.all`-ed callers interleave at the statement level exactly as two connections would.
 */
export type Row = Record<string, any>;

export function rowMatches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Row[]).some((w) => rowMatches(row, w))) return false;
      continue;
    }
    if (key === "AND") {
      const parts = Array.isArray(cond) ? (cond as Row[]) : [cond as Row];
      if (!parts.every((w) => rowMatches(row, w))) return false;
      continue;
    }
    const actual = row[key] === undefined ? null : row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("gt" in cond) {
        if (!(actual != null && actual > (cond as any).gt)) return false;
      } else if ("not" in cond) {
        if (actual === (cond as any).not) return false;
      } else if ("in" in cond) {
        if (!(cond as any).in.includes(actual)) return false;
      } else if ("none" in cond) {
        // relation filter on a to-many key: no related row matches (`none: {}` = no related row)
        const related = Array.isArray(actual) ? (actual as Row[]) : [];
        if (related.some((r) => rowMatches(r, (cond as any).none))) return false;
      } else if ("is" in cond) {
        if (!rowMatches(actual ?? {}, (cond as any).is)) return false;
      } else if (!rowMatches(actual ?? {}, cond as Row)) {
        return false;
      }
    } else if (cond instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== cond.getTime()) return false;
    } else if (actual !== cond) {
      return false;
    }
  }
  return true;
}

export interface FakeCall {
  op: string;
  args: any;
  inTx: boolean;
}

export class FakeTable {
  /** Pass the same `log` to several tables to see their calls in one order. */
  constructor(
    public rows: Row[],
    private readonly name = "table",
    public readonly log: FakeCall[] = [],
  ) {}

  /** The model surface; `undo` (inside a transaction) collects inverse operations. */
  view(undo?: Array<() => void>) {
    const rows = this.rows;
    const note = (op: string, args: any) =>
      this.log.push({ op: `${this.name}.${op}`, args, inTx: undo !== undefined });
    const tick = () => Promise.resolve();
    const touch = (row: Row, data: Row) => {
      const prev: Row = {};
      for (const k of Object.keys(data)) prev[k] = row[k];
      Object.assign(row, data);
      undo?.push(() => Object.assign(row, prev));
    };
    return {
      findUnique: async (args: { where: Row }) => {
        note("findUnique", args);
        const { where } = args;
        await tick();
        return rows.find((r) => rowMatches(r, where)) ?? null;
      },
      findFirst: async (args: { where?: Row } = {}) => {
        note("findFirst", args);
        const { where } = args;
        await tick();
        return rows.find((r) => rowMatches(r, where)) ?? null;
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        note("updateMany", args);
        const { where, data } = args;
        await tick();
        const hit = rows.filter((r) => rowMatches(r, where));
        for (const r of hit) touch(r, data);
        return { count: hit.length };
      },
      update: async (args: { where: Row; data: Row }) => {
        note("update", args);
        const { where, data } = args;
        await tick();
        const row = rows.find((r) => rowMatches(r, where));
        if (!row) throw new Error("record to update not found");
        touch(row, data);
        return row;
      },
      deleteMany: async (args: { where?: Row } = {}) => {
        note("deleteMany", args);
        const { where } = args;
        await tick();
        const hit = rows.filter((r) => rowMatches(r, where));
        for (const r of hit) {
          const at = rows.indexOf(r);
          rows.splice(at, 1);
          undo?.push(() => rows.splice(at, 0, r));
        }
        return { count: hit.length };
      },
    };
  }
}

/** Wire `tables` (model name -> table) into a `createMockPrisma()` object. */
export function installFakeTables(prisma: any, tables: Record<string, FakeTable>): void {
  for (const [model, table] of Object.entries(tables)) {
    const view: Record<string, (a: any) => Promise<any>> = table.view();
    for (const [method, fn] of Object.entries(view)) {
      prisma[model][method].mockImplementation(fn);
    }
  }
  const run = async (fn: (tx: any) => Promise<any>) => {
    const undo: Array<() => void> = [];
    const tx: any = Object.create(prisma);
    for (const [model, table] of Object.entries(tables)) tx[model] = table.view(undo);
    try {
      return await fn(tx);
    } catch (e) {
      for (const u of undo.reverse()) u();
      throw e;
    }
  };
  prisma.$transaction.mockImplementation(run);
  prisma.tenantTransaction.mockImplementation(run);
}
