import { randomUUID } from "crypto";
import { AdjustmentReason, CostingMethod, MovementType, Prisma } from "@prisma/client";
import { NotFoundException } from "@nestjs/common";
import { lockProductsForStock, PRODUCT_LOCK_RANK_SQL } from "../common/product-locks";
import { nextAverageCost, reverseAverageCost } from "./costing";

/**
 * SA-927 §1: the ONE StockMovement writer. Every write to `Product.currentStock` (and the average it
 * moves) appends its StockMovement rows through `applyStockMovements` - the only caller of
 * `stockMovement.create*` in src, so there is no second place that can disagree on `stockAfter`,
 * `avgCostAfter` or the lock order.
 *
 * Steps (one tx, the caller's):
 *  1. lock the distinct products (`lockProductsForStock`; re-locking in the same tx is a no-op);
 *  2. read id / currentStock / averageCost / costingMethod, tenant-scoped, in lock-rank order - a
 *     requested id missing from that read is a 404 before any write (the cross-tenant refusal);
 *  3. `rows` may be a function of that read (policy checks such as oversell throw from it);
 *  4. resolve a `target` row to `quantity = target - the running counter` (an absolute count is an
 *     input form, never a counter write of its own), drop zero-quantity rows (except COST_BASIS),
 *     order by the locked read, fold the running {stock, average} per product (Decimal math,
 *     `costing.ts` for every average);
 *  5. ONE `createManyAndReturn`, every row with `tenantId` set;
 *  6. per product ONE absolute `currentStock = stockAfter` write (never an increment);
 *  7. return the created rows in the order of the kept input rows.
 */

/** A product's counter and cost state as read under the lock. */
export interface LockedStock {
  id: string;
  currentStock: Prisma.Decimal;
  averageCost: Prisma.Decimal | null;
  costingMethod: CostingMethod;
}

/** How a row moves the product's running average (costing.ts does the math). Default "keep". */
export type StockAverage =
  | "keep"
  | { receive: Prisma.Decimal | null }
  | { reverse: Prisma.Decimal | null }
  | { set: Prisma.Decimal; standard?: boolean };

interface StockMovementRowFields {
  productId: string;
  type: MovementType;
  unitCost?: Prisma.Decimal | null;
  average?: StockAverage;
  reference?: string | null;
  notes?: string | null;
  performedById?: string | null;
  supplierId?: string | null;
  reason?: AdjustmentReason | null;
  reasonNote?: string | null;
  effectiveAt?: Date;
  createdAt?: Date;
}

export type StockMovementRow = StockMovementRowFields &
  (
    | {
        /** Signed pieces: negative = out. */
        quantity: Prisma.Decimal | number;
        target?: never;
      }
    | {
        /** An absolute counter (a stock count): the row's quantity is target - the running counter. */
        target: Prisma.Decimal | number;
        quantity?: never;
      }
  );

export interface AppliedStockMovement {
  id: string;
  productId: string;
  stockAfter: Prisma.Decimal | null;
  avgCostAfter: Prisma.Decimal | null;
}

type RowsInput =
  | StockMovementRow[]
  | ((
      locked: ReadonlyMap<string, LockedStock>,
    ) => StockMovementRow[] | Promise<StockMovementRow[]>);

/** The slice of a Prisma TransactionClient (the `any` tx of the order-stock helpers is assignable). */
type StockTx = Prisma.TransactionClient;

interface ReadRow {
  id: string;
  currentStock: Prisma.Decimal.Value;
  averageCost: Prisma.Decimal.Value | null;
  costingMethod: CostingMethod;
}

const OPTIONAL_KEYS = [
  "unitCost",
  "reference",
  "notes",
  "performedById",
  "supplierId",
  "reason",
  "reasonNote",
  "effectiveAt",
  "createdAt",
] as const;

export async function applyStockMovements(
  tx: StockTx,
  tenantId: string,
  rows: RowsInput,
  opts?: { productIds?: string[] },
): Promise<AppliedStockMovement[]> {
  if (!tenantId) throw new Error("applyStockMovements: tenantId is required");
  if (typeof rows === "function" && !opts?.productIds) {
    throw new Error("applyStockMovements: opts.productIds is required when rows is a function");
  }
  const ids = [
    ...new Set(typeof rows === "function" ? opts!.productIds! : rows.map((r) => r.productId)),
  ];
  if (ids.length === 0) return [];

  // 1. lock
  await lockProductsForStock(tx, tenantId, ids);

  // 2. ordered, tenant-scoped read
  const read = await tx.$queryRaw<ReadRow[]>(Prisma.sql`
    SELECT p.id, p."currentStock", p."averageCost", p."costingMethod"
    FROM "Product" p
    WHERE p."tenantId" = ${tenantId} AND p.id = ANY(${ids}::text[])
    ORDER BY ${PRODUCT_LOCK_RANK_SQL}, p.id
  `);
  const locked = new Map<string, LockedStock>();
  const order = new Map<string, number>();
  for (const r of read) {
    locked.set(r.id, {
      id: r.id,
      currentStock: new Prisma.Decimal(r.currentStock),
      averageCost: r.averageCost == null ? null : new Prisma.Decimal(r.averageCost),
      costingMethod: r.costingMethod,
    });
    order.set(r.id, order.size);
  }
  for (const id of ids) {
    if (!locked.has(id)) throw new NotFoundException("Product not found");
  }

  // 3. the plan
  const planned = typeof rows === "function" ? await rows(locked) : rows;
  for (const r of planned) {
    if (!locked.has(r.productId)) throw new NotFoundException("Product not found");
  }

  // 4. resolve targets against the running counter (per product, input order = fold order), keep,
  // order, fold
  const sim = new Map<string, Prisma.Decimal>();
  const kept = planned
    .map((row, index) => {
      const before =
        sim.get(row.productId) ?? (locked.get(row.productId) as LockedStock).currentStock;
      const qty =
        row.target !== undefined
          ? new Prisma.Decimal(row.target).minus(before)
          : new Prisma.Decimal(row.quantity as Prisma.Decimal | number);
      sim.set(row.productId, before.add(qty));
      return { row, index, qty };
    })
    .filter((k) => !k.qty.isZero() || k.row.type === MovementType.COST_BASIS)
    .sort((a, b) => {
      const d = (order.get(a.row.productId) as number) - (order.get(b.row.productId) as number);
      return d !== 0 ? d : a.index - b.index;
    });
  if (kept.length === 0) return [];

  const perProduct = new Map<string, number>();
  for (const k of kept) perProduct.set(k.row.productId, (perProduct.get(k.row.productId) ?? 0) + 1);
  const base = Date.now();

  interface Run {
    stock: Prisma.Decimal;
    avg: Prisma.Decimal | null;
    standardSet: Prisma.Decimal | null;
    anyQty: boolean;
  }
  const run = new Map<string, Run>();
  const data: Prisma.StockMovementCreateManyInput[] = [];
  kept.forEach((k, position) => {
    const { row, qty } = k;
    const lk = locked.get(row.productId) as LockedStock;
    let st = run.get(row.productId);
    if (!st) {
      st = { stock: lk.currentStock, avg: lk.averageCost, standardSet: null, anyQty: false };
      run.set(row.productId, st);
    }
    const stockBefore = st.stock;
    const stockAfter = stockBefore.add(qty);
    if (!qty.isZero()) st.anyQty = true;
    const standard = lk.costingMethod === CostingMethod.STANDARD;

    const mode = row.average ?? "keep";
    if (mode !== "keep" && "receive" in mode) {
      if (!standard && mode.receive != null) {
        st.avg = nextAverageCost(stockBefore, st.avg, qty, mode.receive);
      }
    } else if (mode !== "keep" && "reverse" in mode) {
      if (!standard && mode.reverse != null && st.avg != null) {
        const before = reverseAverageCost(stockBefore, st.avg, qty.negated(), mode.reverse);
        if (before !== null) st.avg = before;
      }
    } else if (mode !== "keep" && "set" in mode) {
      st.avg = mode.set;
      if (mode.standard && standard) st.standardSet = mode.set;
    }
    const avgCostAfter = st.avg;
    st.stock = stockAfter;

    const out: Record<string, unknown> = {
      // Our own id (the column default is a random uuid too), so the result maps back by id and never
      // depends on the order RETURNING gives.
      id: randomUUID(),
      tenantId,
      productId: row.productId,
      type: row.type,
      quantity: qty,
      stockAfter,
      avgCostAfter,
    };
    for (const key of OPTIONAL_KEYS) {
      if (key in row && row[key] !== undefined) out[key] = row[key];
    }
    // 5 (stamp). A product written more than once in a batch gets strictly increasing stamps, so
    // fold order = insertion order, not uuid order.
    if ((perProduct.get(row.productId) as number) > 1 && row.createdAt === undefined) {
      const stamp = new Date(base + position);
      out.createdAt = stamp;
      if (row.effectiveAt === undefined) out.effectiveAt = stamp;
    }
    data.push(out as unknown as Prisma.StockMovementCreateManyInput);
  });

  // 5. one insert
  const created = (await tx.stockMovement.createManyAndReturn({
    data,
    select: { id: true, productId: true, stockAfter: true, avgCostAfter: true },
  })) as AppliedStockMovement[];

  // 6. one absolute write per product, in lock order
  for (const [productId, st] of run) {
    const lk = locked.get(productId) as LockedStock;
    const avgChanged =
      st.avg == null
        ? lk.averageCost != null
        : lk.averageCost == null || !st.avg.eq(lk.averageCost);
    if (!st.anyQty && !avgChanged && st.standardSet == null) continue;
    await tx.product.update({
      where: { id: productId },
      data: {
        currentStock: st.stock,
        ...(avgChanged && st.avg != null ? { averageCost: st.avg } : {}),
        ...(st.standardSet != null ? { standardCost: st.standardSet } : {}),
      },
    });
  }

  // 7. the created rows in the kept input order (data follows the lock-ordered fold), matched by the ids sent
  const byId = new Map(created.map((c) => [c.id, c]));
  return kept
    .map((k, i) => ({ index: k.index, id: data[i].id as string }))
    .sort((a, b) => a.index - b.index)
    .map((r) => byId.get(r.id) as AppliedStockMovement);
}
