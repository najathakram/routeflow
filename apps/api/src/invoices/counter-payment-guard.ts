import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { dbClockNow, lockCounterClose, registerKeyOfOrder } from "../returns/counter-close-lock";
import { assertCounterWindowOpen } from "../returns/counter-close-window";
import { isTillCashRow } from "../orders/counter-sale/counter-till-cash";

/**
 * SA-750r3 / SA-762r F7: the payment-edit paths (voidPayment, deletePayment, updatePayment, setCheckStatus(BOUNCED)) of a COUNTER
 * sale join the end-of-day close. Only an invoice whose order has `counterSale = true` is a till event; every other invoice gets
 * `null` here and every helper below is then a no-op (no lock statement, no window read), exactly as before.
 *
 * Lock order: counter-close (shared) -> Invoice FOR UPDATE. The scope is read BEFORE the transaction (the order's marker and
 * register are immutable), so the shared lock can be the transaction's first statement.
 */
export interface CounterPaymentScope {
  tenantId: string;
  registerKey: string;
  /** The order's kind, for the till-cash predicate (the scope exists for counter sales only today). */
  counterSale: boolean;
}

type ScopeReader = {
  getTenantId: () => string | null;
  forTenant: () => {
    order: {
      findFirst: (args: {
        where: { invoices: { some: { id: string } } };
        select: { counterSale: true; registerKey: true };
      }) => Promise<{ counterSale?: boolean | null; registerKey?: string | null } | null>;
    };
  };
};

/** The till scope of this invoice's payments, or null (non-counter, no order, no tenant, or `applies` false: no read at all). */
async function scope(
  prisma: ScopeReader,
  invoiceId: string,
  applies = true,
): Promise<CounterPaymentScope | null> {
  const tenantId = prisma.getTenantId();
  if (!applies || !tenantId) return null;
  const order = await prisma.forTenant().order.findFirst({
    where: { invoices: { some: { id: invoiceId } } },
    select: { counterSale: true, registerKey: true },
  });
  const registerKey = registerKeyOfOrder(order);
  return registerKey ? { tenantId, registerKey, counterSale: order?.counterSale === true } : null;
}

/**
 * The transaction's FIRST statement for a counter invoice (the SHARED close lock); a no-op for any other. `held` (only the
 * `TILL_LOCK_HELD` token) skips JUST this statement: the caller already holds the session-level shared lock on its pinned
 * connection, and a second shared request from this connection would queue behind a waiting EXCLUSIVE close. It never skips the
 * scope or the closed-date check.
 */
async function lock(
  tx: Parameters<typeof lockCounterClose>[0],
  scope: CounterPaymentScope | null,
  held?: TillLockHeld,
): Promise<void> {
  if (scope && !held) await lockCounterClose(tx, scope.tenantId, scope.registerKey);
}

/**
 * Under the shared lock: refuse 409 COUNTER_SALE_DAY_CLOSED when ANY of these instants (a payment's stored `paidAt`; for an edit
 * that changes the date, the new one too) falls inside a closed window of the register. A no-op for a non-counter invoice.
 */
async function assertOpen(
  tx: Parameters<typeof assertCounterWindowOpen>[0],
  scope: CounterPaymentScope | null,
  ...dates: Array<Date | string | null | undefined>
): Promise<void> {
  if (!scope) return;
  for (const d of dates) {
    if (d != null)
      await assertCounterWindowOpen(tx, scope.tenantId, scope.registerKey, new Date(d));
  }
}

declare const tillLockHeldBrand: unique symbol;
/** Type-only brand over `true`: the one value `recordPayment` accepts for "the SHARED close lock is already held". */
export type TillLockHeld = true & { readonly [tillLockHeldBrand]: never };
/** Only the counter tender and the pickup hand-over (which hold the lock on their pinned connection) may use this
 *  (`till-lock-held-callers.spec.ts` pins the importers). */
export const TILL_LOCK_HELD = true as TillLockHeld;

/** `recordPayment`'s third parameter: the counter tender / pickup already hold the SHARED close lock on their pinned connection. */
export interface CounterPayOpts {
  tillLockHeld?: TillLockHeld;
}

type DatedTx = Parameters<typeof dbClockNow>[0] & {
  counterDayClose: {
    findFirst: (args: {
      where: { tenantId: string; registerKey: string; reopenedAt: null };
      orderBy: { windowEnd: "desc" };
      select: { windowEnd: true };
    }) => Promise<{ windowEnd: Date } | null>;
  };
};

/**
 * `recordPayment`, under the shared lock (`scope` non-null only): a till-CASH row (`isTillCashRow`) dated strictly BEFORE the
 * latest STANDING close's cutoff of the register would change that closed Z report, so it is refused 409
 * DAY_CLOSED_FOR_PAYMENT_DATE (`closedThrough` = that cutoff). A reopened close is not standing. A CHECK / card / ACH / DRAFT
 * moves no close total and keeps its true date. Returns the instant to store: `paidAt` as given, else "now" (for a till-cash row
 * on a counter invoice, the DATABASE clock the close reads its cutoff from, so a lagging app clock cannot back-date into it).
 */
async function assertDatedOk(
  tx: DatedTx,
  scope: CounterPaymentScope | null,
  orderId: string | null,
  dto: { method: string; paidAt?: Date | string | null },
  status: string,
  paymentGroupId: string | null = null, // the STORED group of an edited row (a new payment is ungrouped)
): Promise<Date> {
  const given = dto.paidAt ? new Date(dto.paidAt) : null;
  // The row recordPayment is about to store: ungrouped, and a CHECK is stored RECORDED.
  const row = {
    method: dto.method,
    status,
    paymentGroupId,
    checkStatus: dto.method === "CHECK" ? "RECORDED" : null,
  };
  if (!scope || !isTillCashRow(orderId ?? "", row, scope)) return given ?? new Date();
  const at = given ?? (await dbClockNow(tx));
  const close = await tx.counterDayClose.findFirst({
    where: { tenantId: scope.tenantId, registerKey: scope.registerKey, reopenedAt: null },
    orderBy: { windowEnd: "desc" },
    select: { windowEnd: true },
  });
  if (close && at < close.windowEnd)
    throw new ConflictException({
      code: API_ERROR_CODES.DAY_CLOSED_FOR_PAYMENT_DATE,
      message: "That day is closed. Record it with today's date.",
      closedThrough: close.windowEnd.toISOString(),
    });
  return at;
}

/**
 * `updatePayment`, under the shared lock: an edit that TURNS a payment into a till-CASH row (`isTillCashRow`) dated before the
 * latest standing close (moves a CASH row's `paidAt` earlier, or changes a CHECK / card to CASH while dated before it, or
 * confirms a DRAFT one) is refused 409 DAY_CLOSED_FOR_PAYMENT_DATE, `assertDatedOk`'s body. A row that already was till-CASH and
 * keeps its date is not judged here: a date inside a closed window is `assertOpen`'s refusal. A no-op for a non-counter invoice.
 */
async function assertEditDated(
  tx: DatedTx,
  scope: CounterPaymentScope | null,
  orderId: string | null,
  stored: {
    method: string;
    status: string;
    paymentGroupId?: string | null;
    checkStatus?: string | null;
    paidAt: Date;
  },
  dto: { method: string; status?: string | null; paidAt?: Date | string | null },
): Promise<void> {
  if (!scope) return;
  if (!dto.paidAt && isTillCashRow(orderId ?? "", stored, scope)) return;
  const status = dto.status ?? stored.status ?? "PAID";
  await assertDatedOk(
    tx,
    scope,
    orderId,
    { method: dto.method, paidAt: dto.paidAt ?? stored.paidAt },
    status,
    stored.paymentGroupId ?? null,
  );
}

/** One namespace so the 5.9k-line invoices service imports it in a single line (size ratchet). */
export const counterPay = { scope, lock, assertOpen, assertDatedOk, assertEditDated };
