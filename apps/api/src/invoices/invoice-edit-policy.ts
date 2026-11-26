import { InvoiceStatus } from "@prisma/client";
import type {
  InvoiceEditAction,
  InvoiceEditBlocked,
  InvoiceEditBlockReason,
  InvoiceEditFields,
} from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { isAdminInTenant } from "../common/admin-in-tenant";
import { CONFIRMED_STATUS } from "./payment-predicates";
import { loadResyncInputs } from "./resync-plan";
import { shouldSkipInPlaceResync } from "../orders/merge-idempotency";
import { resolvePendingMirror } from "./pending-mirror";
import { sendFieldsFor } from "./invoice-send-state";
import { issuedRecomputeOf } from "./stored-tax-state";

/**
 * SA-1508 (A1-6 / A2-6): who may edit an invoice, and what its Edit button does. ONE decision, read by the invoice
 * detail (`editAction` / `editBlocked`, computed for the viewing user) and by the save's gate under the lock
 * (`assertEditableUnderLock`, locked-invoice-edit.ts), so the screen and the PATCH can never disagree.
 *
 * `invoiceEditDecision` is pure: every database read happens in `loadInvoiceEditInputs`, through the tenant-scoped
 * client or the tenant transaction (never the base client), and only AFTER the admin check, so a non-admin never
 * reaches the loader (A2 private nit 2).
 *
 * Precedence, first hit wins (A2-6):
 *  - non-admin: VOID, WRITTEN_OFF, NOT_ADMIN. Nothing else is judged.
 *  - admin: VOID, WRITTEN_OFF, ORDER_LINKED / PART_OF_ORDER, ISSUE_DATE, DEPOSIT; then, on a MONEY edit only:
 *    FILED, PAYING_CASH, PAYING_ONLINE, PENDING_PAYMENT, PAID, CREDIT, UNIT_LINE, TOTAL_NOT_FROM_LINES, ZERO_TOTAL.
 * A DRAFT is judged by today's rule (an order's pending mirror edits on the order), unchanged.
 */

/** What a save changes. `undefined` (the detail read) is judged as the edit screen's money edit. */
export interface InvoiceEditChange {
  /** True when the save can move money: a line, a figure, or a stored total that no line explains. */
  money: boolean;
  issueDateChanged?: boolean;
  depositChanged?: boolean;
  /** The total the save would write (ZERO_TOTAL judges it on a money edit). */
  newTotal?: number;
}

export interface InvoiceEditInputs {
  /** `isAdminInTenant(actor, tenantId)`, computed by the caller BEFORE any read. */
  admin: boolean;
  status: string;
  orderId?: string | null;
  orderNumber?: string | null;
  /** DRAFT only: the order's pending mirror (an order-linked DRAFT that edits on the order). */
  pendingMirror?: boolean;
  /** Order-linked issued invoice: does an order edit provably reach it? Set by `loadInvoiceEditInputs`. */
  orderReach?: "REACHES" | "PART";
  /** Live (non-VOID) payment rows on the invoice, and how many of them are confirmed. */
  payments?: { live: number; confirmed: number };
  /** An open buyer payment request for the invoice's customer, by kind (they are per customer). */
  openRequests?: { cash: boolean; online: boolean };
  /** A live credit note, or a return that cites one of its lines, against the invoice. */
  creditAgainst?: boolean;
  /** A line sold by a unit (units_v1): a money edit is refused until PR-8. */
  hasUnitLine?: boolean;
  /** Set by the save's gate: the filing-lock verdict (the detail read leaves it out; it refuses at save time). */
  filedBlocked?: boolean;
  /** Set by the consent step (commit 6): the stored total is not what the lines sum to. */
  totalNotFromLines?: boolean;
}

export interface InvoiceEditDecision {
  action: InvoiceEditAction | null;
  blocked: InvoiceEditBlocked | null;
}

/** The statuses an issued invoice can be edited in (SA-1508 section 7); PARTIAL and PAID wait for PR-3. */
export const EDITABLE_ISSUED_STATUSES: readonly string[] = [
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.OVERDUE,
];

const refuse = (
  reason: InvoiceEditBlockReason,
  i: Pick<InvoiceEditInputs, "orderId" | "orderNumber">,
  withOrder = false,
): InvoiceEditDecision => ({
  action: null,
  blocked: {
    reason,
    ...(withOrder && i.orderId ? { orderId: i.orderId, orderNumber: i.orderNumber ?? null } : {}),
  },
});

export function invoiceEditDecision(
  i: InvoiceEditInputs,
  change?: InvoiceEditChange,
): InvoiceEditDecision {
  if (i.status === InvoiceStatus.DRAFT) {
    return { action: i.orderId && i.pendingMirror ? "EDIT_ORDER" : "EDIT", blocked: null };
  }
  if (i.status === InvoiceStatus.VOID) return refuse("VOID", i);
  if (i.status === InvoiceStatus.WRITTEN_OFF) return refuse("WRITTEN_OFF", i);
  if (!i.admin) return refuse("NOT_ADMIN", i, true);

  if (i.orderId) {
    if (i.orderReach === "PART") return refuse("PART_OF_ORDER", i, true);
    return {
      action: "EDIT_ORDER",
      blocked: { reason: "ORDER_LINKED", orderId: i.orderId, orderNumber: i.orderNumber ?? null },
    };
  }
  if (change?.issueDateChanged) return refuse("ISSUE_DATE", i);
  if (change?.depositChanged) return refuse("DEPOSIT", i);

  const money = change?.money ?? true;
  // PARTIAL and PAID are PR-3's: the in-place edit is for an invoice nobody has paid.
  if (!EDITABLE_ISSUED_STATUSES.includes(i.status)) return refuse("PAID", i);
  if (money) {
    if (i.filedBlocked) return refuse("FILED", i);
    if (i.openRequests?.cash) return refuse("PAYING_CASH", i);
    if (i.openRequests?.online) return refuse("PAYING_ONLINE", i);
    const live = i.payments?.live ?? 0;
    const confirmed = i.payments?.confirmed ?? 0;
    if (live > confirmed) return refuse("PENDING_PAYMENT", i);
    if (confirmed > 0) return refuse("PAID", i);
    if (i.creditAgainst) return refuse("CREDIT", i);
    if (i.hasUnitLine) return refuse("UNIT_LINE", i);
    if (i.totalNotFromLines) return refuse("TOTAL_NOT_FROM_LINES", i);
    if (change?.newTotal !== undefined && change.newTotal <= 0) return refuse("ZERO_TOTAL", i);
  }
  return { action: "EDIT", blocked: null };
}

/** Plain server-side words for the 409 body (the clients render their own fixed copy from `reason`). */
export const INVOICE_EDIT_REFUSAL_MESSAGES: Record<InvoiceEditBlockReason, string> = {
  ORDER_LINKED: "This invoice comes from an order. Change the order and the invoice updates.",
  PART_OF_ORDER:
    "This invoice covers only part of its order, so changing the order won't update it. Void it and make a new one, or add a credit note.",
  NOT_ADMIN: "Only an admin can change an invoice that was already sent.",
  PAYING_CASH:
    "This customer has a cash payment waiting for your approval. Approve or reject it, then you can edit.",
  PAYING_ONLINE:
    "Your customer has an online payment open. You can edit once they pay, cancel it, or the link expires.",
  PENDING_PAYMENT:
    "A payment on this invoice is waiting to be confirmed. Confirm or remove it first, then edit.",
  PAID: "This invoice already has a payment, so it can't be changed yet. Make a credit note instead.",
  CREDIT: "This invoice has a credit note or a return against it, so it can't be changed yet.",
  VOID: "This invoice is void. Restore it first, then edit it.",
  WRITTEN_OFF: "This invoice was written off. It can't be changed yet.",
  FILED: "This invoice sits in a tax month that was already filed.",
  ISSUE_DATE: "The invoice date can't be changed on a sent invoice yet.",
  DEPOSIT:
    "The deposit terms stay as sent. Make a credit note or a new invoice to change what is owed.",
  ZERO_TOTAL: "A sent invoice can't go to zero. Void it or add a credit note.",
  UNIT_LINE: "A sent invoice with a line sold by a unit can't change its lines yet.",
  TOTAL_NOT_FROM_LINES: "This invoice's total is not what its lines add up to.",
};

type InvoiceForInputs = {
  id: string;
  customerId: string;
  orderId?: string | null;
  items?: ReadonlyArray<{ id: string; unitLabel?: string | null }>;
};

/**
 * Every read the decision needs, through `db` = the tenant-scoped client or the tenant transaction (never the base
 * client). The caller has already passed the admin check. `preloaded.payments` is the lock's own read, reused so a
 * save judges the rows it holds under the lock.
 */
export async function loadInvoiceEditInputs(
  db: any,
  inv: InvoiceForInputs,
  preloaded?: { payments?: ReadonlyArray<{ status?: unknown }> },
): Promise<
  Required<Pick<InvoiceEditInputs, "payments" | "openRequests" | "creditAgainst" | "hasUnitLine">> &
    Pick<InvoiceEditInputs, "orderReach" | "orderNumber">
> {
  const rows: ReadonlyArray<{ status?: unknown }> =
    preloaded?.payments ??
    (await db.invoicePayment.findMany({ where: { invoiceId: inv.id }, select: { status: true } }));
  // scan-ok: draft-payment-not-void — existence counts on payment rows, not a money sum: a pending row blocks too.
  const live = rows.filter((p) => p.status !== "VOID");
  const payments = {
    live: live.length,
    confirmed: live.filter((p) => p.status === CONFIRMED_STATUS).length,
  };

  const requests: Array<{ kind: string }> = await db.buyerPaymentRequest.findMany({
    where: { customerId: inv.customerId, status: { in: ["PENDING", "SETTLING"] } },
    select: { kind: true },
  });
  const openRequests = {
    cash: requests.some((r) => r.kind === "CASH"),
    online: requests.some((r) => r.kind === "CARD"),
  };

  const lineIds = (inv.items ?? []).map((l) => l.id);
  const creditNotes: number = await db.creditNote.count({
    where: { invoiceId: inv.id, status: { not: "VOID" } },
  });
  const returned: number = lineIds.length
    ? await db.returnItem.count({
        where: {
          sourceInvoiceItemId: { in: lineIds },
          return: { status: { notIn: ["REJECTED", "CANCELLED"] } },
        },
      })
    : 0;

  let orderReach: "REACHES" | "PART" | undefined;
  let orderNumber: string | null | undefined;
  if (inv.orderId) {
    const order = await db.order.findUnique({
      where: { id: inv.orderId },
      select: { orderNumber: true, deliveredAt: true },
    });
    orderNumber = order?.orderNumber ?? null;
    orderReach = await orderReachOf(db, inv.orderId, !!order?.deliveredAt, payments.live);
  }

  return {
    payments,
    openRequests,
    creditAgainst: creditNotes + returned > 0,
    hasUnitLine: (inv.items ?? []).some((l) => !!(l.unitLabel ?? "").trim()),
    orderReach,
    orderNumber,
  };
}

/**
 * SA-1508 section 6: an order edit provably reaches this invoice when, after delivery, the partition of the order's
 * lines to its invoices is clean and the order is fully invoiced (the R1 in-place restatement); before delivery, when
 * the invoice carries no live payment row (the B1372 revert set and the deposit lockstep). Otherwise it does not.
 */
async function orderReachOf(
  db: any,
  orderId: string,
  delivered: boolean,
  livePayments: number,
): Promise<"REACHES" | "PART"> {
  if (!delivered) return livePayments === 0 ? "REACHES" : "PART";
  const plan = await loadResyncInputs(db, orderId);
  return plan && !shouldSkipInPlaceResync(plan.order.lineItems) ? "REACHES" : "PART";
}

/**
 * The staff-only fields of the invoice detail: the send state (#2088) and, for SA-1508, the two edit fields for the
 * viewing user. The admin check runs first, before any read: with no tenant context (or a non-admin) the loader is
 * never called, and a DRAFT reads nothing either.
 */
export async function invoiceStaffDetailFields(
  prisma: { forTenant(): any; getTenantId(): string | null | undefined },
  featureConfig: any,
  actor: JwtPayload | undefined,
  inv: InvoiceForInputs & {
    status: InvoiceStatus;
    sentAt: Date | null;
    deliveryBatchId: string | null;
    taxAmount?: unknown; // the verified-rate read (restampRate) judges the stored figures
    subtotal?: unknown;
    discount?: unknown;
    shippingFee?: unknown;
    total?: unknown;
    order?: { orderNumber?: string | null; status?: unknown; fulfillPath?: unknown } | null;
  },
): Promise<Awaited<ReturnType<typeof sendFieldsFor>> & InvoiceEditFields> {
  const send = await sendFieldsFor(
    prisma,
    featureConfig,
    { ...inv, orderId: inv.orderId ?? null },
    inv.order,
  );
  const admin = isAdminInTenant(actor, prisma.getTenantId());
  const read: Partial<Awaited<ReturnType<typeof loadInvoiceEditInputs>>> =
    admin && inv.status !== InvoiceStatus.DRAFT
      ? await loadInvoiceEditInputs(prisma.forTenant(), inv)
      : {};
  const d = invoiceEditDecision({
    admin,
    status: inv.status,
    orderId: inv.orderId ?? null,
    orderNumber: read.orderNumber ?? inv.order?.orderNumber ?? null,
    pendingMirror: await resolvePendingMirror(
      featureConfig,
      prisma.getTenantId(),
      inv as any,
      inv.order as any,
    ),
    ...read,
  });
  // A3-M1: the rate the screen shows and sends on a stored-rate-0 goods line; the lock reads the same value.
  const rate =
    admin && inv.status !== InvoiceStatus.DRAFT && !inv.orderId
      ? await issuedRecomputeOf(
          prisma.forTenant(),
          inv as any,
          (inv.items ?? []) as any[],
          !!(
            await prisma.forTenant().customer.findFirst({
              where: { id: inv.customerId },
              select: { isTaxExempt: true },
            })
          )?.isTaxExempt,
        )
      : null;
  return {
    ...send,
    editAction: d.action,
    editBlocked: d.blocked,
    restampRate: rate?.restampRate ?? null,
  };
}
