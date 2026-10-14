/**
 * Owner issue #2088: "Email again" on an invoice that was emailed before. The server reports a `sendState` on the
 * invoice detail; this is the ONE place the confirmation copy lives, so web and mobile cannot drift (the H5 pattern:
 * a pure module here, a thin re-export in each app, a subpath import so mobile's jest can map it).
 *
 * The state is decided by the server from an exact content fingerprint of what renders on the customer's PDF / email
 * (never inferred from updatedAt). `sentBeforeTracking` is an invoice with a `sentAt` from BEFORE tracking began (or
 * emailed under another fingerprint version): it was probably emailed, but whether it changed since cannot be checked.
 * `markedSentNotEmailed` is an invoice with a `sentAt` from AFTER tracking began and no email on record: it was marked
 * sent (Mark as Sent, a counter sale, a pickup hand-over), never emailed.
 */

export const INVOICE_SEND_STATES = [
  "never",
  "unchanged",
  "changedSinceSent",
  "sentBeforeTracking",
  "markedSentNotEmailed",
] as const;
export type InvoiceSendStateName = (typeof INVOICE_SEND_STATES)[number];

/** What `GET /invoices/:id` returns as `sendState` (dates are ISO strings on the wire). */
export interface InvoiceSendState {
  state: InvoiceSendStateName;
  /** When the last tracked email went out (or the legacy `sentAt` for `sentBeforeTracking`); null for `never`. */
  lastSentAt: string | null;
  lastSentTo: string | null;
}

/** Why the Send action is locked, from the server (`sendLocked`); null/absent = not locked. */
export interface InvoiceSendLock {
  reason: "SENDS_AFTER_DELIVERY";
}

/**
 * The short label beside a locked Send action. `storeOnly` = the business has no delivery (it is "pickup"); `null` =
 * not known yet, so neither moment is named (a store-only business never flashes "delivery").
 */
export function sendsAfterLabel(storeOnly: boolean | null | undefined): string {
  if (storeOnly === true) return "Sends after pickup";
  if (storeOnly === false) return "Sends after delivery";
  return "Sends once handed over or delivered";
}

export const SENDS_AFTER_DELIVERY_COPY =
  "This invoice sends after delivery. Edit the order instead; the invoice updates automatically.";

export interface InvoiceResendCopy {
  /** The action's label: "Send" (never emailed) or "Email again". */
  action: string;
  /** The confirmation sentence shown before sending; null = no confirmation needed (a first send). */
  confirm: string | null;
  /** The primary button of the confirmation. */
  confirmButton: string;
}

const dateOf = (iso: string | null | undefined): string => {
  if (!iso) return "an earlier date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an earlier date";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

/**
 * The copy for the Send / Email again action given the server's state. `never` (or an absent state from an older
 * API) is the plain first send: no confirmation. Every other state asks first, in the owner's words.
 */
export function invoiceResendCopy(
  sendState: InvoiceSendState | null | undefined,
): InvoiceResendCopy {
  const state = sendState?.state ?? "never";
  const when = dateOf(sendState?.lastSentAt);
  switch (state) {
    case "changedSinceSent":
      return {
        action: "Email again",
        confirm: `This invoice was emailed on ${when}. It has been modified since. Email the updated invoice?`,
        confirmButton: "Email updated invoice",
      };
    case "unchanged":
      return {
        action: "Email again",
        confirm: `No changes since the last email on ${when}. Email it again?`,
        confirmButton: "Email again",
      };
    case "sentBeforeTracking":
      return {
        action: "Email again",
        confirm: `This invoice was emailed on ${when}. Changes since then can't be checked. Email it again?`,
        confirmButton: "Email again",
      };
    case "markedSentNotEmailed":
      // Never emailed: a first email, no confirmation (the detail line says it was only marked as sent).
      return { action: "Email invoice", confirm: null, confirmButton: "Email invoice" };
    default:
      return { action: "Send", confirm: null, confirmButton: "Send" };
  }
}

/**
 * The muted line on the invoice detail: what was emailed and whether it changed. Null when never emailed (nothing to
 * say). Same words on web and mobile.
 */
export function invoiceSendStateLine(
  sendState: InvoiceSendState | null | undefined,
): string | null {
  if (!sendState || sendState.state === "never") return null;
  const when = dateOf(sendState.lastSentAt);
  const to = sendState.lastSentTo ? ` to ${sendState.lastSentTo}` : "";
  switch (sendState.state) {
    case "markedSentNotEmailed":
      return `Marked as sent ${when}. No email on record.`;
    case "unchanged":
      return `Emailed ${when}${to}. No changes since.`;
    case "changedSinceSent":
      return `Emailed ${when}${to}. Modified since.`;
    default:
      return `Emailed ${when}${to}. Changes since then can't be checked.`;
  }
}

/** The invoice statuses where the action is "Email again" rather than a first send (everything but DRAFT/VOID/written off). */
export const EMAIL_AGAIN_STATUSES = ["SENT", "VIEWED", "OVERDUE", "PARTIAL", "PAID"] as const;
export const canEmailAgain = (status: string): boolean =>
  (EMAIL_AGAIN_STATUSES as readonly string[]).includes(status);
