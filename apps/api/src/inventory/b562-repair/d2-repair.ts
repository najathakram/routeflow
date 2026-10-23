import { createHash } from "crypto";
import { CostingMethod, MovementType, Prisma } from "@prisma/client";
import { lockProductsForStock } from "../../common/product-locks";
import { foldLedger } from "../fold-ledger";
import {
  interposeOrder,
  type LegacyLine,
  type LegacyOrder,
  type PlacedEvent,
} from "./d2-interpose";
import {
  BACKFILL_PREFIX,
  REPAIR_PREFIX,
  reconstruct,
  type Confidence,
  type LedgerRow,
} from "./d2-reconstruct";

/**
 * Row 635 PR B — B562 D2, the AVCO average repair (SA-136 §5 as AMENDED by SA-902 MUST 2), owner-run through
 * `scripts/b562-d2-average-repair.mjs`.
 *
 * PLAN (read-only, one tenant): per product that carries exactly one D1 anchor (`B562:BACKFILL:`), the reconstruction
 * (d2-reconstruct.ts) — X_c at the cutover, X_now, EXACT/APPROX with reasons. Skipped and listed: not AVCO (STANDARD /
 * LAST_COST / the retired FIFO-LIFO are out of D2's scope), no anchor, several anchors, already repaired (one repair per
 * product; the manual cost setter is the owner's later override), drift ≠ 0 (D1 first), no cost history before the
 * cutover, already correct.
 *
 * APPLY (one transaction for the tenant's plan):
 *  1. lock the plan's products (the house product lock, id-sorted) and RE-DERIVE the plan; refuse the whole apply if the
 *     hash (counter, averageCost, ledger rows and tail, anchor, X_c, X_now, confidence per product) changed;
 *  2. per product append the REPAIR input — COST_BASIS, quantity 0, unitCost X_c, effectiveAt = the anchor's (T_c), so it
 *     sorts after every row at T_c; stockAfter = the counter, avgCostAfter = X_now (the state after its insertion);
 *  3. run PR-3's own apply (`recomputeProductInTx`): it folds through the pin, appends its correction dated now and sets
 *     `Product.averageCost` (Q2) — never a second correction writer;
 *  4. assert the replay's average equals X_now within 0.0001, else roll everything back;
 *  5. write one audit row.
 * Why at T_c and not now (SA-902 MUST 2): an input dated now would pin the average at the repair instant, and every bill
 * entered later but dated before it would lose its cost. The one residual: a purchase dated BEFORE the cutover and entered
 * after the repair is folded before the pin, so the pin hides its cost.
 */
export interface D2Entry {
  productId: string;
  counter: string;
  averageCost: string | null;
  ledgerRows: number;
  /** The ledger's max (createdAt, id). */
  ledgerTail: string;
  anchorId: string;
  anchorAt: string;
  xC: string;
  xNow: string;
  confidence: Confidence;
  residual: string;
  legacyOrders: number;
  reasons: string[];
}
export type D2SkipReason =
  | "NOT_AVCO"
  | "NO_ANCHOR"
  | "SEVERAL_ANCHORS"
  | "ALREADY_REPAIRED"
  | "DRIFT"
  | "NO_COST_HISTORY"
  | "ALREADY_CORRECT";
export interface D2Plan {
  entries: D2Entry[];
  skipped: Array<{ productId: string; reason: D2SkipReason; detail?: string }>;
}

const EPSILON = new Prisma.Decimal("0.0001");
const dec = (v: Prisma.Decimal | number | string | null | undefined) =>
  v == null ? null : new Prisma.Decimal(v).toString();

/** SA-902 MUST 5: the fields the plan hash covers, per product, in product-id order. */
export function planHashOf(entries: D2Entry[]): string {
  const covered = [...entries]
    .sort((a, b) => (a.productId < b.productId ? -1 : 1))
    .map((e) => [
      e.productId,
      e.counter,
      e.averageCost,
      e.ledgerRows,
      e.ledgerTail,
      e.anchorId,
      e.xC,
      e.xNow,
      e.confidence,
    ]);
  return createHash("sha256").update(JSON.stringify(covered)).digest("hex");
}

const LINE_SELECT = {
  productId: true,
  qty: true,
  deliveredQty: true,
  status: true,
  boxes: true,
  pieces: true,
  unitsPerBox: true,
  unitLabel: true,
} as const;

/** The non-DRAFT orders created before the cutover that touched the product, now or in any revision snapshot. */
async function legacyOrdersOf(
  db: any,
  tenantId: string,
  productId: string,
  cutover: Date,
): Promise<LegacyOrder[]> {
  const viaLines: Array<{ orderId: string }> = await db.orderItem.findMany({
    where: { productId, order: { createdAt: { lt: cutover }, status: { not: "DRAFT" } } },
    select: { orderId: true },
    distinct: ["orderId"],
  });
  const contains = JSON.stringify({ lineItems: [{ productId }] });
  const viaRevisions: Array<{ orderId: string }> = await db.$queryRaw`
    SELECT DISTINCT r."orderId" AS "orderId"
      FROM "OrderRevision" r
      JOIN "Order" o ON o.id = r."orderId"
     WHERE o."tenantId" = ${tenantId}
       AND o."createdAt" < ${cutover}
       AND o.status::text <> 'DRAFT'
       AND r.snapshot @> ${contains}::jsonb`;
  const ids = [...new Set([...viaLines, ...viaRevisions].map((o) => o.orderId))];
  if (ids.length === 0) return [];
  const orders = await db.order.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      lineItems: { select: LINE_SELECT },
      revisions: {
        select: { createdAt: true, snapshot: true },
        orderBy: [{ createdAt: "asc" }, { revisionNumber: "asc" }],
      },
    },
  });
  return orders.map((o: any): LegacyOrder => ({
    id: o.id,
    status: String(o.status),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    lines: o.lineItems as LegacyLine[],
    revisions: o.revisions.map((r: any) => ({
      createdAt: r.createdAt,
      lineItems: (Array.isArray(r.snapshot?.lineItems) ? r.snapshot.lineItems : []) as LegacyLine[],
    })),
  }));
}

/** Read-only: the tenant's D2 plan. `db` is a tenant-scoped client (or the apply's tenant transaction). */
export async function planD2(
  db: any,
  opts: { tenantId: string; productIds?: string[] },
): Promise<D2Plan> {
  const scope = opts.productIds?.length ? { productId: { in: opts.productIds } } : {};
  const anchorRows: Array<{ productId: string }> = await db.stockMovement.findMany({
    where: { ...scope, reference: { startsWith: BACKFILL_PREFIX } },
    select: { productId: true },
  });
  const productIds = [
    ...new Set([...(opts.productIds ?? []), ...anchorRows.map((a) => a.productId)]),
  ].sort();
  const plan: D2Plan = { entries: [], skipped: [] };
  if (productIds.length === 0) return plan;
  const products: Array<{
    id: string;
    currentStock: Prisma.Decimal;
    averageCost: Prisma.Decimal | null;
    costingMethod: CostingMethod;
    unitsPerBox: number | null;
  }> = await db.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      currentStock: true,
      averageCost: true,
      costingMethod: true,
      unitsPerBox: true,
    },
    orderBy: { id: "asc" },
  });

  for (const p of products) {
    const skip = (reason: D2SkipReason, detail?: string) =>
      plan.skipped.push({ productId: p.id, reason, ...(detail ? { detail } : {}) });
    // eslint-disable-next-line no-await-in-loop
    const ledger: LedgerRow[] = await db.stockMovement.findMany({
      where: { productId: p.id },
      orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        type: true,
        quantity: true,
        unitCost: true,
        reference: true,
        effectiveAt: true,
        createdAt: true,
      },
    });
    const anchors = ledger.filter((r) => r.reference?.startsWith(BACKFILL_PREFIX));
    if (p.costingMethod !== CostingMethod.AVCO) {
      skip("NOT_AVCO", String(p.costingMethod));
      continue;
    }
    if (ledger.some((r) => r.reference?.startsWith(REPAIR_PREFIX))) {
      skip("ALREADY_REPAIRED");
      continue;
    }
    if (anchors.length === 0) {
      skip("NO_ANCHOR");
      continue;
    }
    if (anchors.length > 1) {
      skip("SEVERAL_ANCHORS", `${anchors.length} rows`);
      continue;
    }
    const sum = ledger.reduce((s, r) => s.add(r.quantity), new Prisma.Decimal(0));
    const drift = new Prisma.Decimal(p.currentStock).sub(sum);
    if (!drift.isZero()) {
      skip("DRIFT", drift.toString());
      continue;
    }
    const anchor = anchors[0];
    // eslint-disable-next-line no-await-in-loop
    const orders = await legacyOrdersOf(db, opts.tenantId, p.id, anchor.effectiveAt);
    const events: PlacedEvent[] = [];
    const approx: string[] = [];
    for (const o of orders) {
      const r = interposeOrder(o, p.id, p.unitsPerBox, anchor.effectiveAt);
      events.push(...r.events);
      approx.push(...r.approx);
    }
    const r = reconstruct({ ledger, events, approx });
    if (r.xC == null || r.xNow == null) {
      skip("NO_COST_HISTORY");
      continue;
    }
    const live = foldLedger(ledger, { isStandard: false, averageCost: null }).avg;
    const same = (x: Prisma.Decimal | null) => x != null && r.xNow!.sub(x).abs().lt(EPSILON);
    if (same(live) && same(p.averageCost)) {
      skip("ALREADY_CORRECT", r.xNow.toString());
      continue;
    }
    const tail = ledger.reduce((t, m) =>
      m.createdAt > t.createdAt || (m.createdAt.getTime() === t.createdAt.getTime() && m.id > t.id)
        ? m
        : t,
    );
    plan.entries.push({
      productId: p.id,
      counter: dec(p.currentStock)!,
      averageCost: dec(p.averageCost),
      ledgerRows: ledger.length,
      ledgerTail: `${tail.createdAt.toISOString()}|${tail.id}`,
      anchorId: anchor.id,
      anchorAt: anchor.effectiveAt.toISOString(),
      xC: r.xC.toString(),
      xNow: r.xNow.toString(),
      confidence: r.confidence,
      residual: r.residual.toString(),
      legacyOrders: orders.length,
      reasons: r.reasons,
    });
  }
  return plan;
}

export class D2Refusal extends Error {
  readonly refuse = true;
}

/** PR-3's own apply (`InventoryService.recomputeProductInTx`), injected: the only correction writer. */
export type RecomputeInTx = (
  tx: any,
  productId: string,
  opts: { throwOnGap?: boolean; trigger?: string; performedById?: string | null },
) => Promise<{
  newAvgCost: number | null;
  correctionId: string | null;
  gapDetected: boolean;
} | null>;

export interface D2Applied {
  productId: string;
  repairId: string;
  correctionId: string | null;
  averageCostBefore: string | null;
  xC: string;
  xNow: string;
  confidence: Confidence;
}

/**
 * The apply, inside ONE tenant transaction the caller opens (`prisma.tenantTransaction` under the tenant's context).
 * `assertXNow` exists only for R-D2b's forced-mismatch row; the runner never passes it.
 */
export async function applyD2InTx(
  tx: any,
  args: {
    tenantId: string;
    planHash: string;
    productIds: string[];
    recompute: RecomputeInTx;
    performedById?: string | null;
    expectXNow?: (entry: D2Entry) => string;
  },
): Promise<D2Applied[]> {
  const ids = [...new Set(args.productIds)].sort();
  await lockProductsForStock(tx, args.tenantId, ids);
  const plan = await planD2(tx, { tenantId: args.tenantId, productIds: ids });
  const planned = plan.entries.map((e) => e.productId).sort();
  if (
    JSON.stringify(planned) !== JSON.stringify(ids) ||
    planHashOf(plan.entries) !== args.planHash
  ) {
    throw new D2Refusal("the products changed since the dry run (the plan hash no longer matches)");
  }
  const reference = `${REPAIR_PREFIX}${args.planHash}`;
  const out: D2Applied[] = [];
  for (const e of plan.entries) {
    // eslint-disable-next-line no-await-in-loop
    const repair = await tx.stockMovement.create({
      data: {
        productId: e.productId,
        type: MovementType.COST_BASIS,
        quantity: new Prisma.Decimal(0),
        unitCost: new Prisma.Decimal(e.xC),
        avgCostAfter: new Prisma.Decimal(e.xNow),
        stockAfter: new Prisma.Decimal(e.counter),
        reference,
        notes: `was ${e.averageCost ?? "none"} · at cutover ${e.xC} · now ${e.xNow} · ${e.confidence}`,
        effectiveAt: new Date(e.anchorAt),
        performedById: args.performedById ?? null,
      },
      select: { id: true },
    });
    // eslint-disable-next-line no-await-in-loop
    const replay = await args.recompute(tx, e.productId, {
      trigger: `REPAIR:${args.planHash}`,
      throwOnGap: true,
      performedById: args.performedById ?? null,
    });
    const expected = new Prisma.Decimal(args.expectXNow ? args.expectXNow(e) : e.xNow);
    if (
      !replay ||
      replay.newAvgCost == null ||
      new Prisma.Decimal(replay.newAvgCost).sub(expected).abs().gte(EPSILON)
    ) {
      throw new D2Refusal(
        `product ${e.productId}: the replay's average ${replay?.newAvgCost ?? "none"} is not D2's ${expected.toString()}`,
      );
    }
    out.push({
      productId: e.productId,
      repairId: repair.id,
      correctionId: replay.correctionId,
      averageCostBefore: e.averageCost,
      xC: e.xC,
      xNow: e.xNow,
      confidence: e.confidence,
    });
  }
  await tx.auditLog.create({
    data: {
      tenantId: args.tenantId,
      userId: args.performedById ?? null,
      action: "INVENTORY_B562_D2_REPAIR_APPLY",
      entityType: "inventory",
      meta: { planHash: args.planHash, repairs: out } as unknown as Prisma.InputJsonValue,
    },
  });
  return out;
}
