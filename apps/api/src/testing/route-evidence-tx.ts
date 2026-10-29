/**
 * SA-842 (B209 / #1402): an in-memory transaction double for the delivery-evidence specs. Rows live in
 * plain arrays; `findMany` / `findFirst` / `count` / `updateMany` / `deleteMany` / `delete` evaluate the
 * `where` the code under test actually sent, so a spec proves what the predicate DECIDES from the rows,
 * not which call it made. Built on `createOpLogTx`, so every call (and every raw lock statement) is
 * logged IN ORDER: lock-order and "nothing written on refusal" are asserted from the one log.
 *
 * Supported `where` shapes (exactly what the predicate and the delete paths use): scalar equality,
 * `null`, `{ in }`, `{ equals }`, `{ not: null | <value> | Prisma.AnyNull }`, `{ isEmpty }`, `{ gt }`,
 * `{ startsWith }`, `OR`, `AND`, and a relation filter (`orderItem.where.order = {...}` reads the row's
 * embedded `order` object). An unsupported operator throws, so a new clause can never silently match.
 *
 * Pure data + string work: no jest globals, nothing here runs in production.
 */
import { createOpLogTx, OpLogEntry } from "./op-log-tx";

export type Row = Record<string, any>;

export const EVIDENCE_TABLES = [
  "route",
  "routeStop",
  "routeCustomer",
  "routeRun",
  "routeRunStop",
  "order",
  "orderItem",
  "deliveryMutation",
  "deliveryBatch",
  "changeRequest",
  "return",
  "advancePayment",
] as const;
export type EvidenceTable = (typeof EVIDENCE_TABLES)[number];
export type EvidenceDb = Record<EvidenceTable, Row[]>;

export function emptyEvidenceDb(seed: Partial<EvidenceDb> = {}): EvidenceDb {
  const db = {} as EvidenceDb;
  for (const t of EVIDENCE_TABLES) db[t] = (seed[t] ?? []).map((r) => ({ ...r }));
  return db;
}

const OPERATORS = new Set(["in", "equals", "not", "isEmpty", "gt", "startsWith"]);
const nullish = (v: unknown) => v === null || v === undefined;

export function matchesWhere(row: Row, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as any[]).some((w) => matchesWhere(row, w));
    if (key === "AND") return (cond as any[]).every((w) => matchesWhere(row, w));
    const val = row[key];
    if (cond === null) return nullish(val);
    if (cond instanceof Date || typeof cond !== "object") return val === cond;
    const c = cond as Record<string, any>;
    const keys = Object.keys(c);
    if (keys.length > 0 && !keys.every((k) => OPERATORS.has(k))) {
      // A relation filter: evaluate it against the row's embedded related object.
      return typeof val === "object" && val !== null && matchesWhere(val, c);
    }
    if ("in" in c && !(c.in as unknown[]).includes(val)) return false;
    if ("equals" in c && val !== c.equals) return false;
    if ("not" in c) {
      const n = c.not;
      const isNullMarker = n === null || (typeof n === "object" && !(n instanceof Date));
      if (isNullMarker ? nullish(val) : val === n) return false; // `Prisma.AnyNull` / `null` read as "is set"
    }
    if ("isEmpty" in c && (Array.isArray(val) ? val.length === 0 : true) !== c.isEmpty)
      return false;
    if ("gt" in c && !(Number(val) > c.gt)) return false;
    if ("startsWith" in c && !(typeof val === "string" && val.startsWith(c.startsWith)))
      return false;
    return true;
  });
}

export function createEvidenceTx(db: EvidenceDb): { tx: any; log: OpLogEntry[] } {
  return createOpLogTx((op, args) => {
    if (op === "$queryRaw" || op === "$executeRaw") return undefined; // a lock statement: logged, no rows
    const [model, method] = op.split(".") as [EvidenceTable, string];
    const rows = db[model];
    if (!rows) throw new Error(`route-evidence-tx: unknown model ${model}`);
    const where = args?.where;
    const hit = (r: Row) => matchesWhere(r, where);
    switch (method) {
      case "findMany": {
        const found = rows.filter(hit).map((r) => ({ ...r }));
        // The lock helper reads run ids `orderBy: { id: "asc" }`: honour it, the only ordering used.
        if (args?.orderBy?.id === "asc")
          found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return found;
      }
      case "findFirst":
      case "findUnique": {
        const r = rows.find(hit);
        return r ? { ...r } : null;
      }
      case "count":
        return rows.filter(hit).length;
      case "updateMany": {
        const targets = rows.filter(hit);
        targets.forEach((r) => Object.assign(r, args.data));
        return { count: targets.length };
      }
      case "deleteMany":
      case "delete": {
        const keep = rows.filter((r) => !hit(r));
        const count = rows.length - keep.length;
        db[model] = keep;
        return method === "delete" ? { id: where?.id } : { count };
      }
      default:
        throw new Error(`route-evidence-tx: ${op} is not supported`);
    }
  });
}

/** The ops of a log that WRITE (verbs that change rows), in call order. Raw lock statements are not writes. */
export function writeOps(log: OpLogEntry[]): string[] {
  return log
    .filter((e) => /\.(update|updateMany|delete|deleteMany|create|createMany)$/.test(e.op))
    .map((e) => e.op);
}

/** Index of the first log entry that is a raw statement whose text matches `re` (-1 when none). */
export function rawIndex(log: OpLogEntry[], re: RegExp): number {
  return log.findIndex(
    (e) => (e.op === "$queryRaw" || e.op === "$executeRaw") && re.test(e.sql ?? ""),
  );
}
