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

/** The insert, on a transaction client `tx`: the revision number is max+1 under that transaction. */
async function insertRevision(
  tx: any,
  tenantId: string | null,
  [orderId, user, , source, reason]: AppendOrderRevisionArgs,
  snapshot: ReturnType<typeof revisionSnapshot>,
): Promise<void> {
  const max = await tx.orderRevision.aggregate({
    where: { orderId },
    _max: { revisionNumber: true },
  });
  await tx.orderRevision.create({
    data: {
      tenantId,
      orderId,
      revisionNumber: (max._max.revisionNumber ?? 0) + 1,
      editedById: user?.sub ?? null,
      editedByName: user?.username ?? null,
      editedByRole: user?.role ?? null,
      source,
      reason: reason ?? null,
      snapshot,
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
  tx: any,
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
