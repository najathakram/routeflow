/**
 * POS mode (SA-763r P-2), mobile half. Pure logic (no api-client / react-query imports, so it stays
 * unit-testable in the node Jest env); mirrors `apps/web/lib/api/pos-orders.ts`, `lib/pos-copy.ts`
 * and `PosOrderActions.tsx`. The order's `fulfillPath` is the snapshot: see `isPosOrder`.
 */
import { API_ERROR_CODES, PREF, staffMay } from "@routeflow/types";
import type { PickupCompleteRequest, PickupCompleteResponse } from "@routeflow/types";
import { roundMoney } from "@routeflow/pricing";
import { fmtCurrency } from "../utils/format";

import { isPosOrder } from "./order-status-flow";

export { isPosOrder };

/** The per-user preference key, from the shared `PREF` (a `PREFERENCE_KEYS` entry). */
export const POS_MODE_PREF_KEY = PREF.ordersPosMode;

/** Who may use POS mode: the shared `USE_POS_MODE` capability row. */
export function canUsePosMode(role: string | null | undefined): boolean {
  return staffMay(role, "USE_POS_MODE");
}

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
  mergedConfirmMissing: "Order merged, but it couldn't be confirmed. Open it to confirm.",
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
 * not offer the notification again, nor Switch to delivery (the server locks the fulfil path).
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
    if (posCanSwitchToDelivery(status)) out.push(switchToDelivery);
    return out;
  }
  // A written-off invoice is never a payment or print target.
  const payable = invoices.filter((i) => i.status !== "WRITTEN_OFF");
  if (status === "DELIVERED" && payable[0]) {
    const paid = payable.every((i) => i.status === "PAID");
    // Record payment opens the first invoice that is not yet PAID; Print the first payable one.
    const target = paid ? payable[0] : (payable.find((i) => i.status !== "PAID") ?? payable[0]);
    return [
      {
        key: paid ? "printInvoice" : "recordPayment",
        label: paid ? POS_COPY.printInvoice : POS_COPY.recordPayment,
        tier: "primary",
        invoiceId: target.id,
      },
    ];
  }
  return [];
}

/**
 * "Switch to delivery" is offered only while the order is open. The server refuses a fulfil-path
 * change at OUT_FOR_DELIVERY, DELIVERED and CANCELLED (order-lifecycle.ts), so a "Ready for pickup"
 * order can no longer switch.
 */
export function posCanSwitchToDelivery(status: string): boolean {
  return status === "PENDING" || status === "CONFIRMED";
}

/** The note shown while editing a handed-over POS order: a cut never restocks. */
export function posCutNote(
  order: { fulfillPath?: string | null; counterSale?: boolean | null },
  status: string,
): string | null {
  return isPosOrder(order) && status === "DELIVERED" ? POS_COPY.cutAfterHandOver : null;
}

export type PosFinishStep = "confirm" | "invoice";

/** Which half of "Confirm & invoice" is missing, as the fixed toast copy. */
export function posFinishFailureMessage(step: PosFinishStep, merged = false): string {
  if (step === "invoice") return POS_COPY.invoiceMissing;
  return merged ? POS_COPY.mergedConfirmMissing : POS_COPY.confirmMissing;
}

/**
 * The status PATCHes of "Confirm & invoice". The API has no DRAFT -> CONFIRMED edge (DRAFT goes to
 * PENDING or CANCELLED), so "Add to it" on an open DRAFT promotes it to PENDING first.
 */
export function posConfirmSteps(
  fromStatus: string | null | undefined,
): ("PENDING" | "CONFIRMED")[] {
  return fromStatus === "DRAFT" ? ["PENDING", "CONFIRMED"] : ["CONFIRMED"];
}

/**
 * The status PATCHes are NOT idempotent (PENDING -> PENDING is a 400). A refused PENDING step carries
 * on only when it was a 400/409 AND a re-read of the order shows PENDING or CONFIRMED.
 */
export function pendingRefusalIsDone(
  httpStatus: number | undefined,
  rereadStatus: string | null | undefined,
): boolean {
  return (
    (httpStatus === 400 || httpStatus === 409) &&
    (rereadStatus === "PENDING" || rereadStatus === "CONFIRMED")
  );
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
 * `balanceDue`, else its total (the client never derives total minus payments); with no invoice, the order total. Display default
 * only: the server judges the real balance and never over-collects.
 */
export function posBalanceDue(
  orderTotal: number,
  invoices:
    ReadonlyArray<{ status: string; total: number; balanceDue?: number }> | null | undefined,
): number | null {
  const all = invoices ?? [];
  if (all.length === 0) return roundMoney(orderTotal); // no invoice yet: the order total
  const live = all.filter((i) => i.status !== "VOID" && i.status !== "WRITTEN_OFF");
  // The server's per-invoice balanceDue only: a missing one is unknown (null), never the gross total.
  if (live.some((i) => typeof i.balanceDue !== "number")) return null;
  return roundMoney(live.reduce((acc, i) => acc + (i.balanceDue as number), 0));
}

export type PosHandOverBalance =
  { state: "loading" } | { state: "error" } | { state: "ready"; amount: number };

/**
 * What the hand-over sheet may show as owed. Never the gross order total once an invoice exists: until
 * the per-invoice server balances are read the state is `loading`, and a failed read is `error`
 * (the sheet then offers Retry and keeps submit disabled).
 */
export function posHandOverBalance(input: {
  orderTotal: number;
  orderInvoices: ReadonlyArray<{ status: string }>;
  /** The balance the server said was still owed after a 200 whose payment was not recorded. */
  owedOverride: number | null;
  isFetching: boolean;
  isError: boolean;
  details: ReadonlyArray<{ status: string; total: number; balanceDue?: number }> | undefined;
}): PosHandOverBalance {
  if (input.owedOverride != null) return { state: "ready", amount: roundMoney(input.owedOverride) };
  if (!input.orderInvoices.some((i) => i.status !== "VOID")) {
    return { state: "ready", amount: roundMoney(input.orderTotal) };
  }
  if (input.isError) return { state: "error" };
  if (input.isFetching || !input.details) return { state: "loading" };
  const amount = posBalanceDue(input.orderTotal, input.details);
  return amount === null ? { state: "error" } : { state: "ready", amount };
}

/** After a refused PENDING step the order was re-read: a CONFIRMED order needs no CONFIRMED patch. */
export function posConfirmStepsAfterPending(
  rereadStatus: string | null | undefined,
): "CONFIRMED"[] {
  return rereadStatus === "CONFIRMED" ? [] : ["CONFIRMED"];
}

/**
 * "Hand over, no payment" is offered only when the customer is KNOWN to be named (`isWalkIn === false`,
 * read from the customer record: GET /orders/:id does not carry it). Unknown / loading is not known-named.
 */
export function posMayHandOverUnpaid(isWalkIn: boolean | null | undefined): boolean {
  return isWalkIn === false;
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
  /** true / null / undefined (unknown or loading) all require a tender; only a known `false` may skip. */
  isWalkIn: boolean | null | undefined;
  skip: boolean;
  method: PosTenderMethod;
  amountRaw: string;
  reference: string;
  balanceDue: number;
}): PosTenderPlan {
  // Nothing owed (a fully paid invoice): there is no tender to take, whoever the customer is.
  if (input.balanceDue <= 0) return { ok: true, body: {} };
  if (input.skip) {
    return posMayHandOverUnpaid(input.isWalkIn)
      ? { ok: true, body: {} }
      : { ok: false, problem: "TENDER_REQUIRED" };
  }
  const reference = input.reference.trim();
  if (input.method === "CHECK" && !reference) return { ok: false, problem: "CHECK_NUMBER" };
  if (input.method !== "CASH") {
    // Card and check pay the balance exactly (the server never over-collects): no amount is sent.
    return {
      ok: true,
      body: { payment: { method: input.method, ...(reference ? { reference } : {}) } },
    };
  }
  const raw = input.amountRaw.trim();
  const amount = raw === "" ? input.balanceDue : Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, problem: "AMOUNT" };
  return { ok: true, body: { payment: { method: "CASH", amount: roundMoney(amount) } } };
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

/** NewOrderScreen's POS merge prompt: counter-order wording; a backdated order can only start a new one. */
export function posMergeAlert(backdated: boolean, submit: (choice: "merge" | "separate") => void) {
  const copy = posMergePrompt(backdated);
  return {
    title: copy.title,
    message: copy.message,
    buttons: [
      { label: "Cancel", style: "cancel" as const },
      ...(backdated ? [] : [{ label: copy.addLabel, onPress: () => submit("merge") }]),
      { label: copy.newLabel, onPress: () => submit("separate") },
    ],
  };
}

/** The footer primary label on NewOrderScreen. */
export function posConfirmLabel(posMode: boolean, saving: boolean): string {
  if (saving) return "Saving…";
  return posMode ? POS_COPY.confirmAndInvoice : "Confirm";
}

export type PickupDecision =
  | { kind: "retry-tender"; releaseKey: false; owed: number | null; message: string }
  | { kind: "done"; releaseKey: true; message: string };

/**
 * What a 200 from pickup-complete means. The hand-over can commit while the payment is NOT recorded
 * (`paymentRecorded: false`): when the tender was required or short, go back to the tender step with the
 * SAME Idempotency-Key (so the retry adds the payment to this hand-over) owing `balanceDue`. The key is
 * released only when the payment was recorded (or none was requested). Mirrors web's PickupCompleteDialog.
 */
export function decidePickupResponse(res: PickupCompleteResponse): PickupDecision {
  const code = res.paymentRecorded ? undefined : res.paymentErrorCode;
  if (
    code === API_ERROR_CODES.PICKUP_PAYMENT_REQUIRED ||
    code === API_ERROR_CODES.COUNTER_TENDER_SHORT
  ) {
    return {
      kind: "retry-tender",
      releaseKey: false,
      owed: res.balanceDue > 0 ? res.balanceDue : null,
      message: pickupCompleteErrorCopy({ response: { data: { code } } }),
    };
  }
  return {
    kind: "done",
    releaseKey: true,
    message: res.paymentRecorded
      ? (res.change ?? 0) > 0
        ? `Handed over. Change ${fmtCurrency(res.change ?? 0)}`
        : "Handed over"
      : "Handed over, but the payment wasn't recorded. Record it on the invoice.",
  };
}
