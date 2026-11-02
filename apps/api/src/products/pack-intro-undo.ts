import { MovementType, Prisma } from "@prisma/client";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { reverseAverageCost } from "../inventory/costing";
import type { LockedStock, StockMovementRow } from "../inventory/stock-movements";
import { scaleLotShape } from "./pack-intro";

/**
 * SA-1093 Rule 1: a stored ledger row counts in the units of its own day. Its factor is the product of N over every Boxes
 * answer written after that row. A Pieces answer, an import, and a pack written without the question give factor 1.
 */
export interface BoxIntro {
  at: Date;
  to: number;
}

type IntroTx = {
  auditLog: { findMany(args: Prisma.AuditLogFindManyArgs): Promise<unknown[]> };
};

/**
 * The product's Boxes answers, oldest first. One query per product per undo, on `(entityType, entityId)`. The intro writes
 * its audit row in the same transaction, so this is its record. An unreadable `to` throws: it never falls back to 1.
 */
export async function boxIntrosOf(tx: IntroTx, productId: string): Promise<BoxIntro[]> {
  const rows = (await tx.auditLog.findMany({
    where: {
      entityType: "Product",
      entityId: productId,
      action: AUDIT_ACTIONS.PRODUCT_PACK_INTRODUCED,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, meta: true },
  })) as { id: string; createdAt: Date; meta: { reading?: unknown; to?: unknown } | null }[];
  return rows
    .filter((r) => r.meta?.reading === "box")
    .map((r) => {
      const to = r.meta?.to;
      if (typeof to !== "number" || !Number.isInteger(to) || to <= 1) {
        throw new Error(`Pack introduction ${r.id} has no readable pack size`);
      }
      return { at: r.createdAt, to };
    });
}

/** The answers written after a row, by insertion time. `effectiveAt` is never read: a backdated row was still counted in its own day. */
export const introsAfter = (intros: readonly BoxIntro[], rowCreatedAt: Date): BoxIntro[] =>
  intros.filter((i) => i.at > rowCreatedAt);

export const packFactor = (intros: readonly BoxIntro[]): number =>
  intros.reduce((f, i) => f * i.to, 1);

/** A lot's shape after these answers: each one's rounding in order, never a single division. */
export const convertedLotShape = (
  qty: Prisma.Decimal.Value,
  unitCost: Prisma.Decimal.Value | null,
  intros: readonly BoxIntro[],
) =>
  intros.reduce((s, i) => scaleLotShape(s.qty, s.unitCost, i.to), {
    qty: Number(qty),
    unitCost: Number(unitCost ?? 0),
  });

/** The lot's where: the shape it was written with, or the one the answers since gave it. A spent lot was never converted. */
export function lotShapeWhere(
  qty: Prisma.Decimal.Value,
  unitCost: Prisma.Decimal.Value | null,
  intros: readonly BoxIntro[] = [],
): Prisma.StockLotWhereInput {
  const original = { qty, ...(unitCost != null ? { unitCost } : {}) };
  if (intros.length === 0) return original;
  const scaled = convertedLotShape(qty, unitCost, intros);
  return {
    OR: [original, { qty: scaled.qty, ...(unitCost != null ? { unitCost: scaled.unitCost } : {}) }],
  };
}

/** One undone part, in today's pieces and today's cost. */
export interface TodaysPart {
  qty: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
}

/** A row's quantity and cost in today's terms: quantity x factor, cost / factor unrounded, so its whole value comes out. */
export const inTodaysPieces = (
  qty: Prisma.Decimal.Value,
  unitCost: Prisma.Decimal.Value | null,
  factor: number,
): TodaysPart => ({
  qty: new Prisma.Decimal(qty).mul(factor),
  unitCost: unitCost == null ? null : new Prisma.Decimal(unitCost).div(factor),
});

/** The average after taking these parts out of the locked stock. A null answer keeps the previous average. */
export function averageAfterUndo(
  stock: Prisma.Decimal,
  average: Prisma.Decimal,
  parts: readonly TodaysPart[],
): Prisma.Decimal {
  let running = stock;
  let avg = average;
  for (const part of parts) {
    if (part.unitCost != null) {
      avg = reverseAverageCost(running, avg, part.qty, part.unitCost) ?? avg;
    }
    running = running.sub(part.qty);
  }
  return avg;
}

/**
 * SA-1093 Rule 2: the rows a void adds after its unchanged pair rows when a Boxes answer came after the receipt: the
 * remainder, quantity only, and the average, as a cost row (none for STANDARD, or with no average). The intro's own two
 * row shapes, undoing it. `parts` opens with one entry per receipt, in order. The filing sums signed PURCHASE rows, so
 * the pair stays at the receipt's quantity and cost and the bill's filed quantity and value both net 0.
 */
export function packVoidClosingRows(
  locked: LockedStock,
  input: {
    productId: string;
    parts: readonly TodaysPart[];
    receipts: readonly { quantity: Prisma.Decimal.Value }[];
    reference: string;
    notes: string;
    performedById: string | null;
    effectiveAt: Date;
  },
): StockMovementRow[] {
  const { parts, receipts, ...row } = input;
  const remainder = receipts.reduce(
    (t, r, i) => t.add(parts[i].qty.sub(r.quantity)),
    new Prisma.Decimal(0),
  );
  const rows: StockMovementRow[] = [
    { ...row, type: MovementType.ADJUSTMENT, quantity: remainder.negated() },
  ];
  if (locked.costingMethod !== "STANDARD" && locked.averageCost != null) {
    const avg = averageAfterUndo(locked.currentStock, locked.averageCost, parts);
    rows.push({
      ...row,
      type: MovementType.COST_BASIS,
      quantity: 0,
      unitCost: avg,
      average: { set: avg },
    });
  }
  return rows;
}
