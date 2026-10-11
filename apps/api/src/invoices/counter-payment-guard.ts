import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  COUNTER_DEFAULT_REGISTER,
  dbClockNow,
  lockCounterClose,
} from "../returns/counter-close-lock";
import {
  assertCounterWindowOpen,
  counterWindowClosed,
  dayClosedConflict,
} from "../returns/counter-close-window";
import {
  isCounterTenderRow,
  legGroupIds,
  type TenderRowShape,
} from "../orders/counter-sale/counter-tender-row";
import { isTillCashRow } from "../orders/counter-sale/counter-till-cash";

/**
 * SA-750r3 / SA-762r F7: the payment-edit paths (voidPayment, deletePayment, updatePayment, setCheckStatus(BOUNCED)) of a COUNTER
 * sale AND of a POS pickup order (`fulfillPath = PICKUP`, whose hand-over rows are till tender) join the end-of-day close. An
 * invoice of any other order gets `null` here and every helper below is then a no-op (no lock statement, no window read).
 *
 * Lock order: counter-close (shared) -> Invoice FOR UPDATE. The scope is read BEFORE the transaction (the order's marker, path
 * and register are immutable), so the shared lock can be the transaction's first statement. The lock is per INVOICE; the
 * closed-window refusal is per ROW (`assertOpen`): only a till-tender row of a closed window is refused.
 */
export interface CounterPaymentScope {
  tenantId: string;
  registerKey: string;
  /** The order's kind, for the one tender predicate (`isCounterTenderRow`): a counter sale, else a pickup order. */
  counterSale: boolean;
  /** The order's id: a pickup hand-over's group id (`pickupTenderGroupId`) derives from it. */
  orderId: string;
  /**
   * The sale's payment rows as the one predicate needs them as a SET: a row that carries one of the order's tender leg ids
   * on ANY invoice of the order, VOID row or voided invoice included (at most one is read: it only says "this sale's tender
   * is grouped"). Without it an ungrouped office payment on a grouped sale would read as legacy till tender here and as
   * foreign money in the day close.
   */
  saleRows: ReadonlyArray<{ paymentGroupId?: string | null; status?: string }>;
}

type ScopeReader = {
  getTenantId: () => string | null;
  forTenant: () => {
    invoicePayment: {
      findMany: (args: {
        where: {
          paymentGroupId: { in: string[] };
          invoice: { orderId: string };
        };
        select: { paymentGroupId: true; status: true };
        take: 1;
      }) => Promise<Array<{ paymentGroupId: string | null; status: string }>>;
    };
    order: {
      findFirst: (args: {
        where: { invoices: { some: { id: string } } };
        select: { id: true; counterSale: true; fulfillPath: true; registerKey: true };
      }) => Promise<{
        id?: string;
        counterSale?: boolean | null;
        fulfillPath?: string | null;
        registerKey?: string | null;
      } | null>;
    };
  };
};

/**
 * The till scope of this invoice's payments, or null (no order, no tenant, an order that is neither a counter sale nor a PICKUP
 * order, or `applies` false: no read at all). The register is the order's stamped key, else the default register (COALESCE).
 */
async function scope(
  prisma: ScopeReader,
  invoiceId: string,
  applies = true,
): Promise<CounterPaymentScope | null> {
  const tenantId = prisma.getTenantId();
  if (!applies || !tenantId) return null;
  const order = await prisma.forTenant().order.findFirst({
    where: { invoices: { some: { id: invoiceId } } },
    select: { id: true, counterSale: true, fulfillPath: true, registerKey: true },
  });
  const counterSale = order?.counterSale === true;
  if (!order || !(counterSale || order.fulfillPath === "PICKUP")) return null;
  const registerKey = order.registerKey ?? COUNTER_DEFAULT_REGISTER;
  const orderId = order.id ?? "";
  // Only a counter sale's tender can carry a leg id; a POS pickup order's rows are judged by its own pickup id alone.
  let saleRows: CounterPaymentScope["saleRows"] = [];
  if (counterSale) {
    saleRows = await prisma.forTenant().invoicePayment.findMany({
      where: {
        paymentGroupId: { in: legGroupIds(orderId) },
        invoice: { orderId },
      },
      select: { paymentGroupId: true, status: true },
      take: 1,
    });
  }
  return { tenantId, registerKey, counterSale, orderId, saleRows };
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

/** A stored (or about-to-be-stored) payment row, as `assertOpen` judges it: the tender shape plus the instant it is dated. */
export interface PaymentRowState extends TenderRowShape {
  paidAt?: Date | string | null;
}

/**
 * Under the shared lock: refuse 409 COUNTER_SALE_DAY_CLOSED PER ROW. A row is refused only when it is a till-TENDER row under
 * the one predicate (`isCounterTenderRow` with the order's kind: a counter sale's ungrouped tender, a pickup order's own
 * hand-over group) AND its `paidAt` falls inside a closed window of the register. Callers pass the STORED row and, for an edit,
 * the row's NEW state too. A CREDIT_NOTE / ADVANCE row, a deposited check and an office payment on a pickup order are never
 * refused here. A no-op without a scope (an order that is not a till event).
 */
async function assertOpen(
  tx: Parameters<typeof assertCounterWindowOpen>[0],
  scope: CounterPaymentScope | null,
  ...rows: Array<PaymentRowState | null | undefined>
): Promise<void> {
  if (!scope) return;
  for (const r of rows) {
    if (r?.paidAt == null || !isCounterTenderRow(scope.orderId, r, scope, scope.saleRows)) continue;
    if (await counterWindowClosed(tx, scope.tenantId, scope.registerKey, new Date(r.paidAt)))
      throw dayClosedConflict();
  }
}

/** The date-only window check (no payment row): the counter-sale void's sale time and tender dates. A no-op without a scope. */
async function assertDatesOpen(
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

/** `assertOpen` for the payment `paymentId` of `invoiceId`, read in the caller's transaction (voidPayment). No scope: no read. */
async function assertPaymentOpen(
  tx: Parameters<typeof assertCounterWindowOpen>[0] & {
    invoicePayment: {
      findFirst: (args: {
        where: { id: string; invoiceId: string };
      }) => Promise<PaymentRowState | null>;
    };
  },
  scope: CounterPaymentScope | null,
  invoiceId: string,
  paymentId: string,
): Promise<void> {
  if (!scope) return;
  await assertOpen(
    tx,
    scope,
    await tx.invoicePayment.findFirst({ where: { id: paymentId, invoiceId } }),
  );
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

type DatedTx = Parameters<typeof dbClockNow>[0] &
  Parameters<typeof assertCounterWindowOpen>[0] & {
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
 * moves no CASH total, so it keeps its true date, but a tender-method row (card / check) dated INSIDE a closed window is refused
 * COUNTER_SALE_DAY_CLOSED (`assertOpen`: it would change that window's money in). Returns the instant to store: `paidAt` as given, else "now" (for a till-cash row
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
  if (!scope) return given ?? new Date();
  if (!isTillCashRow(orderId ?? "", row, scope, scope.saleRows)) {
    // A CARD / CHECK / hand-over tender moves a close total too (moneyIn): its date may not sit inside a CLOSED window.
    // no given date: "now" is the DATABASE clock the close reads its cutoff from, as in the cash branch below
    const when = given ?? (await dbClockNow(tx));
    await assertOpen(tx, scope, { ...row, paidAt: when });
    return when;
  }
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
 * `updatePayment`, under the shared lock: first `assertOpen` (the per-row closed-window refusal, stored AND new state), then an edit that TURNS a payment into a till-CASH row (`isTillCashRow`) dated before the
 * latest standing close (moves a CASH row's `paidAt` earlier, or changes a CHECK / card to CASH while dated before it, or
 * confirms a DRAFT one) is refused 409 DAY_CLOSED_FOR_PAYMENT_DATE, `assertDatedOk`'s body. A row that already was till-CASH and
 * keeps its date is not judged here: a date inside a closed window is `assertOpen`'s refusal. A no-op without a scope.
 */
async function assertEditDated(
  tx: DatedTx,
  scope: CounterPaymentScope | null,
  orderId: string | null,
  stored: PaymentRowState & { paidAt: Date },
  dto: { method: string; status?: string | null; paidAt?: Date | string | null },
): Promise<void> {
  if (!scope) return;
  // The closed-window refusal first, per row: the STORED row, and the row as the edit would leave it (method / status / date;
  // an edit never changes the group or the check lifecycle), so turning a non-tender row into tender inside a closed window is
  // refused on its new state.
  await assertOpen(tx, scope, stored, {
    ...stored,
    method: dto.method,
    status: dto.status ?? stored.status ?? "PAID",
    paidAt: dto.paidAt ?? stored.paidAt,
  });
  if (!dto.paidAt && isTillCashRow(orderId ?? "", stored, scope, scope.saleRows)) return;
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
export const counterPay = {
  scope,
  lock,
  assertOpen,
  assertDatesOpen,
  assertPaymentOpen,
  assertDatedOk,
  assertEditDated,
};
