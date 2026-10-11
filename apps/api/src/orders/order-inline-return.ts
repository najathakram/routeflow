import { ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import {
  assertReplayItems,
  type InlineReturnReplayLines,
} from "../returns/inline-return-fingerprint";
import { retryStockTx } from "../common/tx-retry";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { InlineReturnLinesDto } from "../returns/dto/capture-inline-return.dto";
import { INLINE_RETURN_KEY_TAKEN } from "../returns/inline-returns.service";
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
  /** Edit path: the preflight's dry-run total (null = a replay of this return). */
  preflightTotal?: number | null;
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
 * A returnKey that is already taken is a REPLAY when this request carries an Idempotency-Key whose
 * order (this customer's) carries that returnKey: a concurrent twin (A committed after B's pre-check
 * missed) gets that order back (a 201 replay), never a false 409 that makes the operator re-enter the
 * return (Opus R1, the double-credit path). Otherwise the 409 stands. Returns the replayed order, or
 * null when the caller should go on to create.
 *
 * KNOWN, ACCEPTED (SA-261/263): every role reserves ahead; a DRIVER's over-cap return is HELD (no
 * credit note), which burns the number, and so does a return that priced above $0 in the dry-run but
 * $0 in the tx, and the LOSER of a double-submit race (its P2002 on the Idempotency-Key burns the
 * number it reserved). The credit-note sequence is not gapless today either (a failed create burns its
 * reserved number, like a burned order number) and our tenants have no gapless requirement. Pinned:
 * a DRIVER_CAP hold and a zero-total create mint no credit note and write no intent.
 *
 * KNOWN, FAILS CLOSED (Opus N1): the reverse-direction replay check (`assertReplayCarriesReturn`)
 * refuses a plain replay of an order that LATER gained a return by an edit or a standalone capture.
 */
export async function reserveInlineReturnNumber(
  p: PreparedInlineReturn | null,
  customerId: string,
  user: JwtPayload | undefined,
  idempotencyKey?: string,
  host?: {
    prisma: any;
    findReplayCandidateByKey(key: string, customerId: string): Promise<any>;
  },
): Promise<any> {
  if (!p) return null;
  let total: number;
  try {
    total = await p.svc.preflightNewOrderReturn(p.lines, customerId, user as JwtPayload);
  } catch (e) {
    const code = e instanceof ConflictException ? (e.getResponse() as any)?.code : undefined;
    const twin =
      code === INLINE_RETURN_KEY_TAKEN && idempotencyKey && host
        ? await host.findReplayCandidateByKey(idempotencyKey, customerId)
        : null;
    if (!twin || twin.customerId !== customerId) throw e;
    await assertReplayCarriesReturn(host!.prisma.forTenant(), p, twin.id);
    return twin;
  }
  if (total > 0.001) p.creditNoteNumber = await p.svc.reserveCreditNoteNumber();
  return null;
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
  if (p) return assertReplayCarriesReturnKey(db, p.lines, replayedOrderId);
  // Both directions (Opus W): a replay WITHOUT a return of an order created WITH one is refused too,
  // or an operator who removes the return after a timeout and re-enters it on another order credits
  // the customer twice, and gets a silent 201 for it.
  const row = await db.return.findFirst({
    where: { orderId: replayedOrderId, kind: "INLINE" },
    select: { id: true },
  });
  if (row) {
    throw new ConflictException(
      "Idempotency-Key reused without the return this order was created with: retry the original unchanged, or submit as a new order (new key)",
    );
  }
}

/** `assertReplayCarriesReturn`, then hands the replayed order back (create()'s two replay exits). */
export async function replayAfterCheck<T extends { id: string }>(
  db: any,
  p: PreparedInlineReturn | null,
  existing: T,
): Promise<T> {
  await assertReplayCarriesReturn(db, p, existing.id);
  return existing;
}

/**
 * The forward direction alone: the replayed order must carry THIS returnKey. Also what a merge replay
 * runs on EVERY key hit (verified or not, Opus R): a merge target legitimately holds earlier returns,
 * so only a request that carries a return is checked.
 */
export async function assertReplayCarriesReturnKey(
  db: any,
  lines: InlineReturnReplayLines | undefined,
  replayedOrderId: string,
): Promise<void> {
  const returnKey = lines?.returnKey;
  if (!returnKey) return;
  const row = await db.return.findFirst({
    where: { returnKey, orderId: replayedOrderId, kind: "INLINE" },
    select: { id: true, returnNumber: true, capturePayload: true },
  });
  if (!row) {
    throw new ConflictException(
      "Idempotency-Key reused with a different return: submit the edited return as a new order (new key), or retry the original unchanged",
    );
  }
  // #2424: the SAME returnKey must also carry the SAME items, or the edited lines are silently lost.
  assertReplayItems(row, lines);
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

/**
 * Edit path: validate the return BEFORE anything commits outside the edit's tx (the linked-invoice
 * revert). No-op without an inline return. See InlineReturnsService.preflightCapture. Records the
 * dry-run total on the handle for `reserveEditReturnNumber`.
 */
export async function preflightInlineReturn(
  p: PreparedInlineReturn | null,
  order: { id: string; customerId: string; routeRunId: string | null },
  user: JwtPayload | undefined,
  // #2178: true when this edit's linked-invoice revert runs next (an undelivered order): the dry run
  // then prices against the post-revert matching set, so it refuses before that revert commits.
  willRevert = false,
): Promise<void> {
  if (!p) return;
  p.preflightTotal = await p.svc.preflightCapture(
    { ...p.lines, customerId: order.customerId, orderId: order.id },
    user as JwtPayload,
    { routeRunId: order.routeRunId },
    willRevert ? { revertOrderId: order.id } : {},
  );
}

/**
 * Edit path: reserve the credit-note number AFTER the preflight and the license guard, so a refused
 * request burns none; skipped ONLY for a same-return replay (null). A $0 preflight still reserves
 * (SA-261/292): the preflight total is a gate, the in-tx price is authoritative, and in the stale-price
 * race (dry-run 0, in-tx > 0) an unreserved edit would take the counter ON the tx under the held Order
 * row, the lock edge SA-263/264 removed. The number is burned if the return prices to $0. (Create keeps
 * the $0 skip: `reserveInlineReturnNumber`, where the number is used in the NEW order's own tx, so
 * no existing Order row is held.)
 */
export async function reserveEditReturnNumber(p: PreparedInlineReturn | null): Promise<void> {
  if (p && p.preflightTotal !== null) p.creditNoteNumber = await p.svc.reserveCreditNoteNumber();
}

/**
 * The edit tx (`prisma.tenantTransaction(fn, opts)`) inside `retryStockTx` (SA-767 r-note 3 (b); it was
 * a conflict-only retry, for a request carrying a return alone, SA-340): EVERY edit now re-runs the whole
 * tx on a write conflict (40001 / 40P01 / P2034), a lock wait that gave up (55P03) or an expired tx budget
 * (P2028), 3 attempts at most; an exhausted retry is the coded 503 LOCK_UNAVAILABLE with nothing saved.
 * A request carrying a return re-runs with the SAME reserved credit-note number (the edit tx is
 * idempotent: its revert and its replay key see to that). One call site in orders.service.ts, so the
 * retried callback carries no wrapper of its own.
 */
export function runEditTx<T>(prisma: any, fn: (tx: any) => Promise<T>, opts?: any): Promise<T> {
  return retryStockTx("orders.updateOrderItems", () => prisma.tenantTransaction(fn, opts));
}
