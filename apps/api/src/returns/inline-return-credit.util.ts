/**
 * Returns Inside Order Creation — PR-1c: the driver-cap cumulative sum (§4 N-5) and the
 * "carrying order is met" predicate (§6.3) both need the SAME figure — the credit already
 * committed against an order's inline returns — so it lives here once rather than being
 * re-derived at each call site (orders.service.ts's DRIVER edit-down guard,
 * InlineReturnsService.capture()'s cap check, and credit-notes.service.ts's sweep
 * exclusion all import this file).
 */
import { roundMoney } from "@routeflow/pricing";

/** Minimal shape `sumInlineReturnCredit` needs from a transaction/prisma client. */
export interface InlineReturnCreditTx {
  return: {
    findMany: (args: any) => Promise<any[]>;
  };
}

/**
 * §4 N-5: Σ = issued + approved credit of non-CANCELLED INLINE returns on `orderId`. Each
 * INLINE `Return` carries its credit as EITHER `refundAmount` (issued — the CN has been
 * minted and linked) OR `heldAmount` (captured above the driver cap, held whole for
 * approval — N-5) — never both at once — so summing whichever is set on each row gives the
 * order's total committed inline-return credit. Read under the CALLER's own carrying-order
 * lock (this never locks anything itself).
 */
export async function sumInlineReturnCredit(
  tx: InlineReturnCreditTx,
  orderId: string,
): Promise<number> {
  const rows = await tx.return.findMany({
    where: { orderId, kind: "INLINE", status: { not: "CANCELLED" } },
    select: { refundAmount: true, heldAmount: true },
  });
  return roundMoney(
    rows.reduce((sum: number, r: any) => sum + Number(r.refundAmount ?? r.heldAmount ?? 0), 0),
  );
}
