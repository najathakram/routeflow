import { ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { InlineReturnLinesDto } from "../returns/dto/capture-inline-return.dto";
import type { InlineReturnsService } from "../returns/inline-returns.service";

/**
 * #2094 (SA-194 / SA-221): the order-side glue for a return taken inside an order create/edit. Lives
 * in its own file because orders.service.ts is under a size ratchet; the service only calls these.
 *
 * Lock order, everywhere: advisory (order-merge -> returns.customer) -> Return -> Order -> Invoice ->
 * rows (SA-214). The order-merge lock is the route's (taken before the service is called, when the
 * route takes it at all). `returns.customer` is the transaction-scoped xact lock and is the tx's FIRST
 * statement (`lockInlineReturnCustomer`), before the order-number counter, the stock rows or the
 * Order row. Nothing here opens a transaction, takes a session lock, or calls a tx-less recompute.
 */
export interface PreparedInlineReturn {
  svc: InlineReturnsService;
  lines: InlineReturnLinesDto;
  /** The caller's role: a DRIVER's return can be held above the cap, which issues no credit note. */
  role: string;
  /** Reserved once, before an order create's P2002 retry loop (SA-221 change 1). */
  creditNoteNumber?: string;
}

/**
 * The guard, run FIRST, before any read: no `inlineReturn` -> null (every existing caller is
 * untouched); a buyer (or a token-less call) is refused with nothing read or written; the add-on is
 * re-checked. A missing provider fails closed (never a silent skip of a money write).
 */
export async function prepareInlineReturn(
  svc: InlineReturnsService | undefined,
  lines: InlineReturnLinesDto | undefined,
  user: JwtPayload | undefined,
): Promise<PreparedInlineReturn | null> {
  if (!lines) return null;
  if (!user) throw new ForbiddenException("Inline returns need an authenticated staff caller");
  if (!svc) throw new ServiceUnavailableException("Inline returns are not available");
  await svc.assertInlineReturnAllowed(user);
  return { svc, lines, role: user.role };
}

/**
 * Create only: reserve the credit-note number once, after validation and before the retry loop.
 *
 * KNOWN, ACCEPTED (SA-261): a create whose return prices to $0 mints no credit note, so the number
 * reserved here is burned (the total is not known before the tx, and a dry-run pricing pass ahead of it
 * was ruled not worth its second pricing pass and stale-price race). The credit-note sequence is not
 * gapless today either: an order create that fails for good burns its reserved number, exactly as a
 * burned order number does, and our tenants have no gapless credit-note requirement. Pinned: a
 * zero-total create mints no credit note and writes no intent (the unit and DB pins).
 */
export async function reserveInlineReturnNumber(p: PreparedInlineReturn | null): Promise<void> {
  // A DRIVER's return may be held above the cap (no credit note), which would burn the number: a
  // driver create reserves inside the tx instead (captureAndIssueInTx), only when it issues.
  if (p && p.role !== "DRIVER") p.creditNoteNumber = await p.svc.reserveCreditNoteNumber();
}

/**
 * #2094 (Opus R1): an Idempotency-Key replay (the pre-check, or the P2002 winner) compares only the
 * cart. A replay that carries an inline return must find THAT returnKey on the order it hands back:
 * otherwise a client that edited its return (new nonce) after a timed-out-but-committed submit gets
 * the original order with a 201 and the new return is silently never captured. 409, never silence.
 */
export async function assertReplayCarriesReturn(
  db: any,
  p: PreparedInlineReturn | null,
  replayedOrderId: string,
): Promise<void> {
  if (!p) return;
  const row = await db.return.findFirst({
    where: { returnKey: p.lines.returnKey, orderId: replayedOrderId, kind: "INLINE" },
    select: { id: true },
  });
  if (!row) {
    throw new ConflictException(
      "Idempotency-Key reused with a different return: submit the edited return as a new order (new key), or retry the original unchanged",
    );
  }
}

/**
 * A deadlock (40P01) or serialization failure (P2034) in the order tx is retried, with the SAME reserved
 * credit-note number, exactly like an order-number collision (#2094 W1: the return adds a lock edge
 * Product (sale) -> Return counter -> Product (restock)).
 */
export function isRetryableTxError(e: any): boolean {
  return (
    e?.code === "P2034" ||
    e?.code === "40P01" ||
    e?.meta?.code === "40P01" ||
    /deadlock detected/i.test(String(e?.message ?? ""))
  );
}

/** The tx's FIRST statement (before any row lock). No-op without an inline return. */
export async function lockInlineReturnCustomer(
  tx: any,
  p: PreparedInlineReturn | null,
  customerId: string,
): Promise<void> {
  if (p) await p.svc.lockCustomerInTx(tx, customerId);
}

/**
 * After the order and its lines are written, still in the order's own transaction: capture the
 * return and issue its credit note (mint at the reserved number, link, orderCreditNote capped at the
 * order's remaining balance under the Order lock, settle). Returns the minted credit note (null for a
 * replay, a DRIVER_CAP hold or a zero total) for the caller to emit AFTER its commit.
 */
export async function applyInlineReturnInTx(
  tx: any,
  p: PreparedInlineReturn | null,
  ctx: {
    customerId: string;
    orderId: string;
    user: JwtPayload | undefined;
    orderRouteRunId?: string | null;
  },
): Promise<any> {
  if (!p) return null;
  const out = await p.svc.captureAndIssueInTx(
    tx,
    { ...p.lines, customerId: ctx.customerId, orderId: ctx.orderId },
    ctx.user as JwtPayload,
    { creditNoteNumber: p.creditNoteNumber, orderRouteRunId: ctx.orderRouteRunId },
  );
  return out.minted;
}

/** After the commit only: never from inside a transaction that could still roll back. */
export function emitInlineReturnCredit(
  p: PreparedInlineReturn | null,
  tenantId: string | null,
  minted: any,
): void {
  if (p && minted) p.svc.emitCreditIssued(tenantId, minted);
}
