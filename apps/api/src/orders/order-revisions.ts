import { EDIT_REVISIONS } from "./ship-state-markers";
import type { Prisma } from "@prisma/client";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";

/**
 * P5-08: append one immutable OrderRevision row capturing the order's line set + money totals
 * AFTER an edit. The snapshot COPIES stored, already-rounded values verbatim — it never re-prices
 * (no `qty*unitPrice`, no re-derived discounts). The per-order `revisionNumber` (max+1) is
 * computed inside a tenant transaction so rapid autosaves can't collide on the
 * `@@unique([orderId, revisionNumber])`.
 *
 * Extracted verbatim from `OrdersService` (SA-065 size-ratchet prefactor); the service keeps a
 * thin private delegate of the same name so its callers and the guard spec's spy are unchanged.
 */
export type AppendOrderRevisionArgs = [
  orderId: string,
  user: JwtPayload | undefined,
  totals: { subtotal: number; tax: number; total: number; shippingFee?: number },
  source: string,
  reason?: string | null,
];

type RevisionLine = {
  productId: string | null;
  name: string | null;
  product?: { name: string | null } | null;
  qty: unknown;
  unitPrice: unknown;
  subtotal: unknown;
  originalPrice: unknown;
  priceType: unknown;
  boxes: unknown;
  pieces: unknown;
  unitsPerBox: unknown;
  trackedCategoryId: unknown;
  trackedSubcategoryId: unknown;
  notes: unknown;
  status: unknown;
};

const LIVE_LINES = {
  where: (orderId: string) => ({ orderId, status: { not: "CANCELLED" as const } }),
  include: { product: { select: { name: true } } },
  orderBy: { createdAt: "asc" as const },
};

function revisionSnapshot(lines: RevisionLine[], totals: AppendOrderRevisionArgs[2]) {
  return {
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    shippingFee: totals.shippingFee ?? 0,
    lineItems: lines.map((li) => ({
      productId: li.productId,
      name: li.name ?? li.product?.name ?? null,
      qty: Number(li.qty),
      unitPrice: Number(li.unitPrice),
      subtotal: Number(li.subtotal),
      originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
      priceType: li.priceType,
      boxes: li.boxes,
      pieces: li.pieces,
      unitsPerBox: li.unitsPerBox,
      trackedCategoryId: li.trackedCategoryId,
      trackedSubcategoryId: li.trackedSubcategoryId,
      notes: li.notes,
      status: li.status,
    })),
  };
}

/**
 * Row 372: the revision an editing client holds. ONE derivation, over the order's EDIT revisions (the same
 * `EDIT_REVISIONS.where` `findOne` includes: ship-state markers are not edits), so the `revisionNumber` GET
 * /orders/:id exposes and the PATCH items `expectedRevisionNumber` check always read the same number.
 */
export async function latestEditRevisionNumber(
  db: { orderRevision: { aggregate(args: any): Promise<any> } },
  orderId: string,
): Promise<number> {
  const max = await db.orderRevision.aggregate({
    where: { orderId, ...EDIT_REVISIONS.where },
    _max: { revisionNumber: true },
  });
  return max?._max?.revisionNumber ?? 0;
}

/** The insert, on a transaction client `tx`: the revision number is max+1 under that transaction. */
async function insertRevision(
  tx: Prisma.TransactionClient,
  tenantId: string | null,
  [orderId, user, , source, reason]: AppendOrderRevisionArgs,
  snapshot: ReturnType<typeof revisionSnapshot>,
): Promise<void> {
  await tx.orderRevision.create({
    data: {
      tenantId,
      orderId,
      revisionNumber:
        ((await tx.orderRevision.aggregate({ where: { orderId }, _max: { revisionNumber: true } }))
          ._max.revisionNumber ?? 0) + 1,
      editedById: user?.sub ?? null,
      editedByName: user?.username ?? null,
      editedByRole: user?.role ?? null,
      source,
      reason: reason ?? null,
      snapshot: snapshot as Prisma.InputJsonObject,
    },
  });
}

export async function appendOrderRevision(
  prisma: PrismaService,
  ...args: AppendOrderRevisionArgs
): Promise<void> {
  const tenantId = prisma.getTenantId();
  const lines = await prisma.forTenant().orderItem.findMany({
    where: LIVE_LINES.where(args[0]),
    include: LIVE_LINES.include,
    orderBy: LIVE_LINES.orderBy,
  });
  const snapshot = revisionSnapshot(lines, args[2]);
  await prisma.tenantTransaction((tx) => insertRevision(tx, tenantId, args, snapshot));
}

/**
 * The same append, INSIDE the caller's transaction `tx` (lines and revision number read on `tx`), so the
 * revision commits or rolls back with the caller's own writes. Used by the ship-state marker, which must
 * never be lost while the status change it records is kept (SA-689).
 */
export async function appendOrderRevisionInTx(
  tx: Prisma.TransactionClient,
  tenantId: string | null,
  ...args: AppendOrderRevisionArgs
): Promise<void> {
  const lines = await tx.orderItem.findMany({
    where: LIVE_LINES.where(args[0]),
    include: LIVE_LINES.include,
    orderBy: LIVE_LINES.orderBy,
  });
  await insertRevision(tx, tenantId, args, revisionSnapshot(lines, args[2]));
}

/** Row 372 MF2: sources of a revision no operator edit produced (the order's lines changed under an editor). */
export const SYSTEM_MERGE_REVISION = "SYSTEM_MERGE";
export const SYSTEM_INVOICE_SYNC_REVISION = "SYSTEM_INVOICE_SYNC";
export const SYSTEM_REOPEN_REVISION = "SYSTEM_REOPEN";

/**
 * Row 372 MF2: the ONE in-tx bump for a writer that changes an order's LINES without an operator edit, so
 * an editor holding the earlier revision goes stale. Appended after the order's totals were written, from
 * the stored totals themselves. A system revision is an EDIT revision (`EDIT_REVISIONS` only excludes
 * ship-state markers), so it moves `revisionNumber`.
 */
async function appendSystemRevisionInTx(
  tx: Prisma.TransactionClient,
  tenantId: string | null,
  orderId: string,
  source: string,
): Promise<void> {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { subtotal: true, tax: true, total: true, shippingFee: true },
  });
  const totals = {
    subtotal: Number(o.subtotal),
    tax: Number(o.tax),
    total: Number(o.total),
    shippingFee: Number(o.shippingFee ?? 0),
  };
  await appendOrderRevisionInTx(tx, tenantId, orderId, undefined, totals, source);
}

/** A merge folded loser carts into the winner. */
export const appendMergeRevisionInTx = (
  tx: Prisma.TransactionClient,
  tenantId: string | null,
  winnerId: string,
) => appendSystemRevisionInTx(tx, tenantId, winnerId, SYSTEM_MERGE_REVISION);

/** A reopen put every item-CANCELLED line back live (a new sale of the whole order). */
export const appendReopenRevisionInTx = (
  tx: Prisma.TransactionClient,
  tenantId: string | null,
  orderId: string,
) => appendSystemRevisionInTx(tx, tenantId, orderId, SYSTEM_REOPEN_REVISION);

/** An invoice edit back-synced the order's lines or fee (`recomputeOrderFromInvoices`). */
export const appendInvoiceSyncRevisionInTx = (
  tx: Prisma.TransactionClient,
  tenantId: string | null,
  orderId: string,
) => appendSystemRevisionInTx(tx, tenantId, orderId, SYSTEM_INVOICE_SYNC_REVISION);

/** `GET /orders/:id`: `revisionNumber` from the EDIT revisions `findOne` already included (no extra read). */
export function attachRevisionNumber(order: {
  revisions?: ReadonlyArray<{ revisionNumber: number }> | null;
}): void {
  const latest = (order.revisions ?? []).reduce((m, r) => Math.max(m, r.revisionNumber), 0);
  Object.assign(order, { revisionNumber: latest });
}
