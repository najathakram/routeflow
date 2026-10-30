/**
 * SA-927 PR-A parity: the StockMovement rows and the counter/average a stock event leaves, in one
 * comparable shape, so a spec can assert the exact rows master writes and the helper-based branch must
 * write the same. "The same rows" (SA-927 §2) = type, quantity, reference, effectiveAt, stockAfter and
 * avgCostAfter, per product in fold order (effectiveAt, createdAt, id), plus Product.currentStock and
 * Product.averageCost. Ids inside `reference` are replaced by the caller's tokens; an effectiveAt inside
 * the event's own time window reads "now" (a defaulted stamp), anything else is its ISO string.
 *
 * `STOCK_PARITY_DUMP=<file>` appends every captured state as one JSON line, so a master run and a branch
 * run can be diffed outside the repo (no committed snapshot). Lives under `testing/`, never in the build.
 */
import * as fs from "fs";
import type { PgQueryable } from "../../common/testing/db-spec";

export interface ParityRow {
  type: string;
  quantity: number;
  reference: string | null;
  effectiveAt: string;
  stockAfter: number | null;
  avgCostAfter: number | null;
}

export interface ParityState {
  currentStock: number;
  averageCost: number | null;
  rows: ParityRow[];
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Marks a time window: rows stamped inside it read `effectiveAt: "now"`. */
export function parityWindow(): { start: Date; end: () => Date } {
  const start = new Date(Date.now() - 2_000);
  return { start, end: () => new Date(Date.now() + 2_000) };
}

/**
 * The product's state. `tokens` maps an id (or any substring) to a stable label, e.g.
 * `{ [order.id]: "<order>" }`; longer keys are replaced first. `sinceIso` drops rows written before the
 * event (the fixture's opening rows), so a spec asserts only what the event wrote, when it wants that.
 */
export async function parityState(
  db: PgQueryable,
  productId: string,
  opts: {
    window: { start: Date; end: () => Date };
    tokens?: Record<string, string>;
    since?: Date;
    label?: string;
  },
): Promise<ParityState> {
  const p = await db.query(`SELECT "currentStock", "averageCost" FROM "Product" WHERE id = $1`, [
    productId,
  ]);
  const m = await db.query(
    // The columns are `timestamp` holding UTC (Prisma); read them as epoch ms and send the cutoff as a
    // UTC literal, so the reader is right on a host whose zone is not UTC (pg would read local time).
    `SELECT type, quantity, reference, "stockAfter", "avgCostAfter",
            (EXTRACT(EPOCH FROM "effectiveAt") * 1000)::float8 AS "effectiveMs"
       FROM "StockMovement"
      WHERE "productId" = $1 ${opts.since ? `AND "createdAt" >= $2::timestamp` : ""}
      ORDER BY "effectiveAt", "createdAt", id`,
    opts.since ? [productId, opts.since.toISOString().replace("Z", "")] : [productId],
  );
  const end = opts.window.end();
  const keys = Object.keys(opts.tokens ?? {}).sort((a, b) => b.length - a.length);
  const tokenize = (s: string | null): string | null => {
    if (s == null) return null;
    let out = s;
    for (const k of keys) out = out.split(k).join(opts.tokens![k]);
    return out;
  };
  const rows: ParityRow[] = m.rows.map((r: any) => {
    const at = new Date(Number(r.effectiveMs));
    return {
      type: String(r.type),
      quantity: Number(r.quantity),
      reference: tokenize(r.reference),
      effectiveAt: at >= opts.window.start && at <= end ? "now" : at.toISOString(),
      stockAfter: num(r.stockAfter),
      avgCostAfter: num(r.avgCostAfter),
    };
  });
  const state: ParityState = {
    currentStock: Number(p.rows[0]?.currentStock),
    averageCost: num(p.rows[0]?.averageCost),
    rows,
  };
  const dump = process.env.STOCK_PARITY_DUMP;
  if (dump) {
    fs.appendFileSync(dump, JSON.stringify({ label: opts.label ?? productId, ...state }) + "\n");
  }
  return state;
}
