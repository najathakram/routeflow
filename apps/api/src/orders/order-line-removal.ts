import { BadRequestException, NotFoundException } from "@nestjs/common";

/** What a struck-off (CANCELLED) line is zeroed to. A zeroed line has no free units left to show. */
const STRUCK_OFF = {
  status: "CANCELLED",
  qty: 0,
  subtotal: 0,
  boxes: null,
  pieces: null,
  promoFreeUnits: null,
} as const;

/**
 * #2563 (SA-507b): a per-line diff removal (CANCEL, or DELETE's strike-off / hard delete) writes
 * ONLY a line of the order being edited — `{ id, orderId }`, never a bare line id. Before this, a
 * staff or driver diff naming ANOTHER order's line id cancelled or deleted it (tenant-scoped only),
 * leaving that order's totals, stock and invoice links stale. A miss (count 0) is a 404 thrown
 * inside the edit's transaction, so nothing else in the edit commits either.
 */
export async function writeLineRemoval(
  tx: {
    orderItem: {
      updateMany(args: unknown): Promise<{ count: number }>;
      deleteMany(args: unknown): Promise<{ count: number }>;
    };
  },
  orderId: string,
  lineId: string | null | undefined,
  mode: "strike-off" | "delete",
): Promise<void> {
  // Never a scope with a hole in it: Prisma DROPS an undefined key, so `{ id: undefined, orderId }`
  // would match EVERY line of the order (the lead's Opus FAIL on #2573). Refused before any write.
  if (!lineId || !orderId) throw new BadRequestException(REMOVAL_NEEDS_ID);
  const where = { id: lineId, orderId };
  const { count } =
    mode === "delete"
      ? await tx.orderItem.deleteMany({ where })
      : await tx.orderItem.updateMany({ where, data: STRUCK_OFF });
  if (count === 0) throw new NotFoundException("That line is not on this order");
}

const REMOVAL_NEEDS_ID = "A removal must name the line"; // SA-511c

/**
 * #2563 fold: a per-line diff CANCEL/DELETE with no line id is a 400, checked on the payload alone
 * at the top of `updateOrderItems` — before any read or write (and before any ownership answer: it
 * says nothing about the order). `writeLineRemoval` re-asserts it at the write.
 */
export function assertRemovalsNameALine(
  items:
    | ReadonlyArray<{
        id?: string | null;
        action?: string | null;
        substituteProductId?: string | null;
      }>
    | undefined,
): void {
  if ((items ?? []).some((i) => (i.action === "CANCEL" || i.action === "DELETE") && !i.id))
    throw new BadRequestException(REMOVAL_NEEDS_ID);
  // #2577: a substitute rewrites an EXISTING line — it must name that line too.
  if ((items ?? []).some((i) => i.substituteProductId != null && !i.id))
    throw new BadRequestException("A substitution must name the line it replaces");
}

/**
 * #2577 (sibling of #2563): a per-line diff that REWRITES a line (the pack substitute, the
 * unit-line edit/substitute) writes only a line of the order being edited — `{ id, orderId }`,
 * never a bare id; a miss (Prisma P2025) is a 404 inside the edit's transaction. A missing id is a 400
 * before any write (Prisma drops an undefined key, which would widen the write to the order).
 */
export async function writeLineUpdate(
  tx: { orderItem: { update(args: unknown): Promise<unknown> } },
  orderId: string,
  lineId: string | null | undefined,
  data: Record<string, unknown>,
): Promise<void> {
  if (!lineId || !orderId) throw new BadRequestException(REMOVAL_NEEDS_ID);
  try {
    // `update` with a compound where (id is unique; orderId an extra filter): a line of ANOTHER
    // order matches nothing, and Prisma raises P2025 instead of writing it.
    await tx.orderItem.update({ where: { id: lineId, orderId }, data });
  } catch (e: any) {
    if (e?.code === "P2025") throw new NotFoundException("That line is not on this order");
    throw e;
  }
}
