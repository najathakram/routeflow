/**
 * POS mode (SA-763r P-2), mobile half. Pure logic (no api-client / react-query imports, so it stays
 * unit-testable in the node Jest env); mirrors `apps/web/lib/api/pos-orders.ts`, `lib/pos-copy.ts`
 * and `PosOrderActions.tsx`. The order's `fulfillPath` is the snapshot: see `isPosOrder`.
 */
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
