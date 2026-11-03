import { ConflictException } from "@nestjs/common";
import { MovementType, Prisma } from "@prisma/client";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
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

/**
 * SA-1093 A-4: the answers a sold line still has to cross. A stored snapshot above 1 says the line was written at that pack, so
 * it's past the answer that set it, and one equal to today's pack is past them all. A split with no snapshot says nothing, so
 * that line takes every answer since its date. A pack cleared and answered again at a line's own number reads as past it, which
 * adds too little, never too much.
 */
export function introsAfterLine(
  intros: readonly BoxIntro[],
  line: { createdAt: Date; unitsPerBox?: number | null },
  todaysPack: number | null | undefined,
): BoxIntro[] {
  const after = introsAfter(intros, line.createdAt);
  const snapshot = line.unitsPerBox ?? 1;
  if (snapshot <= 1) return after;
  if (snapshot === todaysPack) return [];
  return after.slice(after.map((i) => i.to).lastIndexOf(snapshot) + 1);
}

export const packFactor = (intros: readonly BoxIntro[]): number =>
  intros.reduce((f, i) => f * i.to, 1);

/**
 * SA-1093 Rule 3: 409 before any write. A re-entry would receive the old unit's lines at the old cost, and a stored line is
 * never stamped with a pack (SA-946). A bill's way out is its void, which never refuses for this.
 */
export const receivedBeforePackError = (document: "bill" | "purchase-order") =>
  new ConflictException({
    code: API_ERROR_CODES.RECEIVED_BEFORE_PACK,
    document,
    message:
      document === "bill"
        ? "This bill was received before its units per box were set. To change it, void it and enter a new bill."
        : "This purchase order was received before its units per box were set. Save the edit without changing stock.",
  });

/**
 * SA-1093 Rule 4: the factor a return's cancel multiplies an inline item's quantity by, from the return's own restock row.
 * A return's rows are written in one transaction, so one row answers for the product. A restocked item with no row is
 * legacy, so older than every answer.
 */
export async function inlineRestockFactors(
  tx: IntroTx & {
    stockMovement: {
      findMany(args: Prisma.StockMovementFindManyArgs): Promise<unknown[]>;
    };
  },
  reference: string,
  productIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(productIds)];
  const rows = (await tx.stockMovement.findMany({
    where: {
      reference,
      type: MovementType.RETURN,
      productId: { in: ids },
      quantity: { gt: 0 },
    },
    select: { productId: true, createdAt: true },
  })) as { productId: string; createdAt: Date }[];
  const factors = new Map<string, number>();
  for (const productId of ids) {
    const intros = await boxIntrosOf(tx, productId);
    const row = rows.find((r) => r.productId === productId);
    factors.set(productId, packFactor(row ? introsAfter(intros, row.createdAt) : intros));
  }
  return factors;
}

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
