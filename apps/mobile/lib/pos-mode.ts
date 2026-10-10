/**
 * POS mode (SA-763r P-2), mobile half. Pure logic (no api-client / react-query imports, so it stays
 * unit-testable in the node Jest env); mirrors `apps/web/lib/api/pos-orders.ts`, `lib/pos-copy.ts`
 * and `PosOrderActions.tsx`. The order's `fulfillPath` is the snapshot: see `isPosOrder`.
 */
import { API_ERROR_CODES } from "@routeflow/types";
import type { PickupCompleteRequest } from "@routeflow/types";
import { roundMoney } from "@routeflow/pricing";

export { isPosOrder } from "./order-status-flow";

/**
 * The per-user preference key (`GET/PATCH /users/me/preferences`), written on flip and never kept in
 * AsyncStorage. TODO(P-1a): move into `@routeflow/types` PREFERENCE_KEYS when the API allow-list lands
 * it (the parity spec pins the lists set-equal, so adding it there alone would turn that spec red).
 */
export const POS_MODE_PREF_KEY = "orders.posMode";

/** Unset = off; only the literal "true" turns the switch on. */
export function posModeFromPreferences(prefs: Record<string, string> | null | undefined): boolean {
  return prefs?.[POS_MODE_PREF_KEY] === "true";
}

export function posModePrefPatch(next: boolean): Record<string, string> {
  return { [POS_MODE_PREF_KEY]: next ? "true" : "false" };
}

/** Fixed visible copy (never an API message). Same words as web `POS_COPY`. */
export const POS_COPY = {
  switchLabel: "POS mode",
  switchHint: "A named customer, invoiced now. For walk-in, pay-now sales use Counter.",
  switchFailed: "Couldn't save your POS mode setting. Try again.",
  confirmAndInvoice: "Confirm & invoice",
  confirmOnly: "Confirm only",
  confirmedInvoiced: "Order confirmed and invoiced",
  confirmedOnly: "Order confirmed",
  confirmMissing: "Order created, but it couldn't be confirmed. Open it to confirm.",
  invoiceMissing:
    "Order confirmed, but the invoice wasn't created. Open it and choose Create invoice.",
  mergeTitle: "This customer already has an open counter order",
  mergeDescription: "Add these items to it, or start a new order?",
  mergeBackdated:
    "Adding to it files these items under that order's date, so a backdated order has to be created separately.",
  mergeAdd: "Add to it",
  mergeNew: "Start a new one",
  cutAfterHandOver:
    "Cutting items after hand-over doesn't put them back on the shelf. If the goods came back, record a return.",
  stepConfirmed: "Confirmed",
  stepInvoiceDraft: "Invoice (draft)",
  stepInvoice: "Invoice",
  stepHandedOver: "Handed over",
  readyForPickup: "Ready for pickup",
  createInvoice: "Create invoice",
  handOver: "Hand over",
  recordPayment: "Record payment",
  printInvoice: "Print invoice",
  invoiceCreated: "Invoice created",
  switchToDelivery: "Switch to delivery",
  invoiceFailed: "Couldn't create the invoice. Try again.",
} as const;

export interface PosInvoiceLike {
  id: string;
  status: string;
}

/** A VOID invoice is not an invoice for the order's purposes (no step done, nothing to pay or print). */
export function posLiveInvoices<T extends PosInvoiceLike>(
  order: { invoices?: T[] | null } | null | undefined,
): T[] {
  return (order?.invoices ?? []).filter((i) => i.status !== "VOID");
}

export interface PosStep {
  key: "confirmed" | "invoice" | "handed";
  label: string;
  done: boolean;
}

/** Confirmed -> Invoice (draft) -> Handed over. No Out-for-delivery step: hand-over IS completion. */
export function posProgressSteps(
  order: { invoices?: PosInvoiceLike[] | null },
  status: string,
): PosStep[] {
  const invoices = posLiveInvoices(order);
  const confirmed =
    status === "CONFIRMED" || status === "OUT_FOR_DELIVERY" || status === "DELIVERED";
  const hasInvoice = invoices.length > 0;
  const invoiceIsDraft = !hasInvoice || invoices.some((i) => i.status === "DRAFT");
  return [
    { key: "confirmed", label: POS_COPY.stepConfirmed, done: confirmed },
    {
      key: "invoice",
      label: invoiceIsDraft ? POS_COPY.stepInvoiceDraft : POS_COPY.stepInvoice,
      done: hasInvoice,
    },
    { key: "handed", label: POS_COPY.stepHandedOver, done: status === "DELIVERED" },
  ];
}

export type PosActionKey =
  | "createInvoice"
  | "handOver"
  | "readyForPickup"
  | "switchToDelivery"
  | "recordPayment"
  | "printInvoice";

export interface PosAction {
  key: PosActionKey;
  label: string;
  tier: "primary" | "secondary";
  /** Set for the two invoice-opening actions of a handed-over order. */
  invoiceId?: string;
}

/**
 * ONE primary per state. PENDING: only "Switch to delivery" (the primary is the status bar's Confirm).
 * CONFIRMED: Create invoice (primary) then Hand over, or Hand over (primary) once invoiced; "Ready for
 * pickup" stays secondary on every open order until handed over. DELIVERED: Record payment / Print.
 * An order already "Ready for pickup" (OUT_FOR_DELIVERY) keeps Hand over / Create invoice but does
 * not offer the notification again.
 */
export function posOrderActions(
  order: { invoices?: PosInvoiceLike[] | null },
  status: string,
): PosAction[] {
  const invoices = posLiveInvoices(order);
  const first = invoices[0];
  const switchToDelivery: PosAction = {
    key: "switchToDelivery",
    label: POS_COPY.switchToDelivery,
    tier: "secondary",
  };
  if (status === "PENDING") return [switchToDelivery];
  if (status === "CONFIRMED" || status === "OUT_FOR_DELIVERY") {
    const out: PosAction[] = first
      ? [{ key: "handOver", label: POS_COPY.handOver, tier: "primary" }]
      : [
          { key: "createInvoice", label: POS_COPY.createInvoice, tier: "primary" },
          { key: "handOver", label: POS_COPY.handOver, tier: "secondary" },
        ];
    if (status === "CONFIRMED") {
      out.push({ key: "readyForPickup", label: POS_COPY.readyForPickup, tier: "secondary" });
    }
    out.push(switchToDelivery);
    return out;
  }
  if (status === "DELIVERED" && first) {
    const paid = invoices.every((i) => i.status === "PAID");
    return [
      paid
        ? {
            key: "printInvoice",
            label: POS_COPY.printInvoice,
            tier: "primary",
            invoiceId: first.id,
          }
        : {
            key: "recordPayment",
            label: POS_COPY.recordPayment,
            tier: "primary",
            invoiceId: first.id,
          },
    ];
  }
  return [];
}

/** "Switch to delivery" is offered until the order is delivered (open states only). */
export function posCanSwitchToDelivery(status: string): boolean {
  return status === "PENDING" || status === "CONFIRMED" || status === "OUT_FOR_DELIVERY";
}

/** The note shown while editing a handed-over POS order: a cut never restocks. */
export function posCutNote(
  order: { fulfillPath?: string | null; counterSale?: boolean | null },
  status: string,
): string | null {
  return order.fulfillPath === "PICKUP" && order.counterSale !== true && status === "DELIVERED"
    ? POS_COPY.cutAfterHandOver
    : null;
}

export type PosFinishStep = "confirm" | "invoice";

/** Which half of "Confirm & invoice" is missing, as the fixed toast copy. */
export function posFinishFailureMessage(step: PosFinishStep): string {
  return step === "invoice" ? POS_COPY.invoiceMissing : POS_COPY.confirmMissing;
}

export function posFinishSuccessMessage(invoice: boolean): string {
  return invoice ? POS_COPY.confirmedInvoiced : POS_COPY.confirmedOnly;
}

/** The merge prompt copy: POS mode uses the counter-order wording, a backdated order must stay separate. */
export function posMergePrompt(backdated: boolean) {
  return {
    title: POS_COPY.mergeTitle,
    message: backdated ? POS_COPY.mergeBackdated : POS_COPY.mergeDescription,
    addLabel: POS_COPY.mergeAdd,
    newLabel: POS_COPY.mergeNew,
  };
}

// ─── Fixed error copy (the server's own message is never shown) ─────────────────────────────────

const PICKUP_COPY = {
  generic: "Couldn't complete the pickup. Check the order and try again.",
  notReady: "This order isn't ready for pickup yet. Confirm it and mark it ready first.",
  only: "Only a pickup order can be handed over this way.",
  paymentRequired: "A balance is due on this order now. Take payment to finish.",
  tenderShort: "A walk-in customer must pay the full balance.",
  keyConflict: "Already picked up. Record any payment on the invoice.",
  invoiceMissing: "The order may be picked up, but its invoice isn't ready yet. Retry to finish.",
  walkInCredit: "This walk-in has open credit. Resolve it on the customer before handing over.",
  walkInOnAccount:
    "A walk-in customer can't be charged on account. Pick a customer or another payment method.",
  checkNumber: "Enter the check number.",
} as const;

export function posErrorCode(err: unknown): string | undefined {
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === "string" ? code : undefined;
}

/** Hand over (pickup-complete): fixed copy by error code, mirroring web `pickupCompleteErrorCopy`. */
export function pickupCompleteErrorCopy(err: unknown): string {
  switch (posErrorCode(err)) {
    case API_ERROR_CODES.PICKUP_PAYMENT_REQUIRED:
      return PICKUP_COPY.paymentRequired;
    case API_ERROR_CODES.COUNTER_TENDER_SHORT:
      return PICKUP_COPY.tenderShort;
    case API_ERROR_CODES.PICKUP_KEY_CONFLICT:
      return PICKUP_COPY.keyConflict;
    case API_ERROR_CODES.PICKUP_INVOICE_MISSING:
      return PICKUP_COPY.invoiceMissing;
    case API_ERROR_CODES.WALK_IN_OPEN_CREDIT:
      return PICKUP_COPY.walkInCredit;
    case API_ERROR_CODES.PICKUP_NOT_READY:
      return PICKUP_COPY.notReady;
    case API_ERROR_CODES.PICKUP_ONLY:
      return PICKUP_COPY.only;
    case API_ERROR_CODES.WALK_IN_NO_ACCOUNT:
      return PICKUP_COPY.walkInOnAccount;
    case API_ERROR_CODES.COUNTER_CHECK_NUMBER_REQUIRED:
      return PICKUP_COPY.checkNumber;
    default:
      return PICKUP_COPY.generic;
  }
}

export const POS_READY_FAILED = "Couldn't mark the order ready for pickup. Try again.";
export const POS_SWITCH_FAILED = "Couldn't switch to delivery. Check the order and try again.";

// ─── Hand-over tender ───────────────────────────────────────────────────────────────────────────

export type PosTenderMethod = "CASH" | "CARD" | "CHECK";
export const POS_TENDER_METHODS: { method: PosTenderMethod; label: string }[] = [
  { method: "CASH", label: "Cash" },
  { method: "CARD", label: "Card" },
  { method: "CHECK", label: "Check" },
];

/**
 * What is left to collect at the hand-over: the sum over live (not VOID / WRITTEN_OFF) invoices of
 * `balanceDue`, else total minus recorded payments; with no invoice, the order total. Display default
 * only: the server judges the real balance and never over-collects.
 */
export function posBalanceDue(
  orderTotal: number,
  invoices:
    | ReadonlyArray<{
        status: string;
        total: number;
        balanceDue?: number;
        payments?: ReadonlyArray<{ amount: number | string }>;
      }>
    | null
    | undefined,
): number {
  const live = (invoices ?? []).filter((i) => i.status !== "VOID" && i.status !== "WRITTEN_OFF");
  if (live.length === 0) return roundMoney(orderTotal);
  const sum = live.reduce((acc, i) => {
    if (typeof i.balanceDue === "number") return acc + i.balanceDue;
    const paid = (i.payments ?? []).reduce((p, x) => p + Number(x.amount || 0), 0);
    return acc + Math.max(0, i.total - paid);
  }, 0);
  return roundMoney(sum);
}

export type PosTenderPlan =
  | { ok: true; body: PickupCompleteRequest }
  | { ok: false; problem: "AMOUNT" | "CHECK_NUMBER" | "TENDER_REQUIRED" };

/**
 * The hand-over body. A named customer may hand over with no payment (`skip`, an open invoice on
 * account); a walk-in must pay (the server 400s WALK_IN_NO_ACCOUNT on an empty body). A blank
 * amount means the exact balance; a check needs its number.
 */
export function planPosTender(input: {
  isWalkIn: boolean;
  skip: boolean;
  method: PosTenderMethod;
  amountRaw: string;
  reference: string;
  balanceDue: number;
}): PosTenderPlan {
  if (input.skip) {
    return input.isWalkIn ? { ok: false, problem: "TENDER_REQUIRED" } : { ok: true, body: {} };
  }
  const raw = input.amountRaw.trim();
  const amount = raw === "" ? input.balanceDue : Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, problem: "AMOUNT" };
  const reference = input.reference.trim();
  if (input.method === "CHECK" && !reference) return { ok: false, problem: "CHECK_NUMBER" };
  return {
    ok: true,
    body: {
      payment: {
        method: input.method,
        amount: roundMoney(amount),
        ...(reference ? { reference } : {}),
      },
    },
  };
}

export const POS_TENDER_PROBLEM_COPY = {
  AMOUNT: "Enter an amount greater than zero.",
  CHECK_NUMBER: "Enter the check number.",
  TENDER_REQUIRED: "A walk-in customer must pay to take the order.",
} as const;

/** Cart-sheet primary label: the footer says what the sheet will actually do. */
export function posCartSaveLabel(posMode: boolean, saving: boolean): string {
  if (saving) return "Saving…";
  return posMode ? POS_COPY.confirmAndInvoice : "Save order";
}
