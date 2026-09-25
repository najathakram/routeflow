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
 * Create only: validate the return, then reserve the credit-note number once, before the retry loop
 * (SA-221 change 1). The dry-run (pricing + the returnKey check, `preflightNewOrderReturn`) runs FIRST,
 * so a refused request burns no number (Opus N1), and a return that prices to $0 mints no credit note
 * so it reserves none.
 *
 * KNOWN, ACCEPTED (SA-261/263): every role reserves ahead; a DRIVER's over-cap return is HELD (no
 * credit note), which burns the number, and so does a return that priced above $0 in the dry-run but
 * $0 in the tx. The credit-note sequence is not gapless today either (a failed create burns its
 * reserved number, like a burned order number) and our tenants have no gapless requirement. Pinned:
 * a DRIVER_CAP hold and a zero-total create mint no credit note and write no intent.
 */
export async function reserveInlineReturnNumber(
  p: PreparedInlineReturn | null,
  customerId: string,
  user: JwtPayload | undefined,
): Promise<void> {
  if (!p) return;
  const total = await p.svc.preflightNewOrderReturn(p.lines, customerId, user as JwtPayload);
  if (total > 0.001) p.creditNoteNumber = await p.svc.reserveCreditNoteNumber();
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
  // Both directions (Opus W): a replay WITHOUT a return of an order created WITH one is refused too,
  // or an operator who removes the return after a timeout and re-enters it on another order credits
  // the customer twice, and gets a silent 201 for it.
  const row = await db.return.findFirst({
    where: {
      orderId: replayedOrderId,
      kind: "INLINE",
      ...(p ? { returnKey: p.lines.returnKey } : {}),
    },
    select: { id: true },
  });
  if (!p && row) {
    throw new ConflictException(
      "Idempotency-Key reused without the return this order was created with: retry the original unchanged, or submit as a new order (new key)",
    );
  }
  if (p && !row) {
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
