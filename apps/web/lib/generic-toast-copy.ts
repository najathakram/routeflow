import { API_ERROR_CODES, CREDITS_PENDING_COPY, SHIPPED_ORDER_MESSAGE } from "@routeflow/types";
import { READ_ONLY_SENTENCE } from "@routeflow/types/read-only-copy";
import { regulatedAuthCopy } from "@routeflow/types/regulated-auth-copy";
import {
  CREDIT_NOTE_ERROR_COPY,
  RETURN_REFUND_OVER_LINE_HEADROOM_COPY,
  UNCONFIRMED_COPY,
  noResponse,
} from "./credit-note-error-copy";
import { creditLimitSentence } from "./credit-limit-copy";
import { COUNTER_VOID_ERROR_COPY } from "./counter-void-copy";
import { COUNTER_SALE_DAY_CLOSED_COPY, DAY_CLOSED_FOR_PAYMENT_DATE_COPY } from "./day-closed-copy";
import { KNOWN_SERVER_SENTENCES } from "./customer-form-error-copy";
import { ORDER_OVERPAY_GENERIC_COPY } from "./order-overpay";
import { parsePlanGate } from "./plan-gate";
import { safeTextErrorCopy } from "./safe-text-error-copy";
import { sellerUnavailableCopy } from "./seller-unavailable";
import { sellingRestrictedCopy } from "./selling-restricted-copy";

/**
 * B980 (owner rule: no raw strings in the UI): the app-wide mutation error toast shows FIXED copy,
 * chosen by the server's `body.code`, then a closed allow-list of server sentences that are already
 * product text, then the HTTP status class. It never renders `response.data.message`, an axios
 * "Request failed with status code …", or an array of class-validator strings. A number ("Only N
 * left") comes from a STRUCTURED body field, never parsed out of the message.
 *
 * Mutations that render their own error UI opt out with `meta: { localErrorToast: true }`
 * (see mutation-error-toast.ts).
 */

/** Daily-work refusals, by `body.code`. The sentences name the cause and the next step. */
const CODE_COPY: Record<string, string> = {
  // a buyer write toward a paused seller: the seller-unavailable sentence, never "You don't have permission"
  [API_ERROR_CODES.SELLER_UNAVAILABLE]: sellerUnavailableCopy(null),
  [API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM]: RETURN_REFUND_OVER_LINE_HEADROOM_COPY,
  INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED:
    "This item was already returned. Add a reason to confirm another return.",
  INLINE_RETURN_KEY_CONFLICT: "This return was already submitted. Refresh to see it.",
  INLINE_RETURN_KEY_TAKEN: "This return was already submitted. Refresh to see it.",
  INLINE_RETURN_ORDER_CANCELLED: "That order is cancelled, so it can't take a return.",
  INLINE_RETURN_ORDER_CUSTOMER_MISMATCH: "That order belongs to a different customer.",
  UNIT_AWARE_LINE:
    "A line on this order is sold by a unit such as a case, so this action isn't available for it yet.",
  MERGE_PACK_MISMATCH:
    "The pack size on this order no longer matches the product. Refresh and review the line.",
  ORDER_CHANGED_DURING_EDIT: "This order changed while you were editing it. Refresh and try again.",
  ORDER_BILLING_CHANGED:
    "This order's billing changed while you were working on it. Refresh and try again.",
  FULFIL_METHOD_NOT_OFFERED: "This business doesn't offer that way of fulfilling orders.",
  ORDER_WITH_CARRIER_NO_CANCEL:
    "This order is already with the carrier. Use a return instead of cancelling.",
  ORDER_WITH_CARRIER_NO_REDUCE:
    "This order is already with the carrier. Record a return instead of reducing or removing lines.",
  ORDER_WITH_CARRIER_NO_ADD:
    "This order is already with the carrier. Create a new order for the extra items.",
  INVOICE_WITH_CARRIER_NO_LINE_CHANGE:
    "This order is already with the carrier, so its invoice lines and quantities can't change. Price, discount and notes still can.",
  [API_ERROR_CODES.ORDER_WITH_CARRIER_NO_CHANGE_REQUEST]: SHIPPED_ORDER_MESSAGE,
  [API_ERROR_CODES.ORDER_LINE_CHANGED]:
    "A line on this order changed while it was being billed. Nothing was billed. Try again.",
  [API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW]:
    "This order's invoices don't match its lines. Add the remaining items to the draft, or void and re-split, before billing more.",
  CONCURRENT_UPDATE: "Someone else is updating this record. Try again in a moment.",
  MERGE_IN_PROGRESS: "Another change for this customer is in progress. Try again in a moment.",
  LOCK_UNAVAILABLE: "This is busy right now. Try again in a moment.",
  [API_ERROR_CODES.ORDER_SAVED_CREDITS_PENDING]: CREDITS_PENDING_COPY,
  [API_ERROR_CODES.BARCODE_TAKEN]: "Another product already uses that barcode.",
  [API_ERROR_CODES.FAMILY_NOT_PRICEABLE]:
    "A product family can't be priced or promoted. Use its variants instead.",
  [API_ERROR_CODES.PACK_SIZE_UNKNOWN]:
    "Some lines don't have a pack size yet. Set each line's pack size, or confirm them as loose pieces, then try again.",
  // B986-7 (Opus): coded refusals whose server sentence tells the user what to fix. Fixed sentences, no ids or typed text. Keys are
  // computed keys from API_ERROR_CODES (B987-A registered them); EMAIL_NOT_CONFIGURED / EMAIL_SEND_FAILED stay bare keys until
  // B987-B (#3053) registers them, then switch to the constants.
  [API_ERROR_CODES.UNIT_NOT_OFFERED]:
    "That unit isn't offered for this product any more. Choose another unit, or ask an admin to add it back.",
  // SA-770: the overdue list refuses past its id cap. The server's text is never shown.
  [API_ERROR_CODES.OVERDUE_FILTER_TOO_BROAD]:
    "Too many invoices are overdue to list at once. Filter by customer, then try again.",
  [API_ERROR_CODES.REMINDER_NO_BALANCE_DUE]:
    "This invoice has no balance due, so there is nothing to remind about.",
  [API_ERROR_CODES.REMINDER_NOT_ISSUED]:
    "A reminder can only be sent for an invoice that has been issued and is still unpaid.",
  EMAIL_NOT_CONFIGURED:
    "Email isn't set up for this workspace yet. Connect it under Settings → Email, then try again.",
  EMAIL_SEND_FAILED:
    "The email couldn't be sent. Check your email settings under Settings → Email, then try again.",
  [API_ERROR_CODES.INVALID_LINE_SPLIT]:
    "That line split isn't valid. Check the quantities and try again.",
  [API_ERROR_CODES.SOURCE_LINE_AMBIGUOUS]:
    "This product is on more than one line, so the source line can't be applied to a single one. Edit the order lines directly.",
  [API_ERROR_CODES.SOURCE_LINE_INVALID]:
    "The source line's pack size or price isn't valid. Check the pack and price, then try again.",
  [API_ERROR_CODES.LINE_PACK_UNDERIVABLE]:
    "This line has no pack size, so it can't be rolled to the next delivery. Set its pack size first.",
  [API_ERROR_CODES.RECIPE_PACK_MISMATCH]:
    "The recipe's pack size differs from the line's pack size. Make them match, then try again.",
  [API_ERROR_CODES.COMPOSITION_CORRUPT]:
    "This line's mixed-pack composition is inconsistent. Re-enter the pack split for this line.",
  [API_ERROR_CODES.ORDER_BELOW_RETURN_CREDIT]:
    "This order's total can't drop below the credit already issued or held against its returns. Raise the total, or deal with the return credit first.",
  [API_ERROR_CODES.UNIT_AWARE_LINE_UNVERIFIABLE]:
    "This invoice's lines couldn't be verified, so it can't be edited. Ask an admin.",
  [API_ERROR_CODES.CHANGE_REQUEST_PACK_CHANGED]:
    "The pack size changed, so a change request was filed. Decline it and re-add the item to the next order.",
  [API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY]:
    "The invoice changed while this was happening. Refresh and try again.",
  [API_ERROR_CODES.INVOICE_TAX_STATE_STALE]:
    "This invoice's tax no longer matches its lines. Re-save the invoice lines, then try again.",
  [API_ERROR_CODES.INVOICE_TOTAL_BELOW_PAID]:
    "That change would take the invoice total below what is already paid or credited. Remove the credit first, or change the lines or discount.",
  PO_ALREADY_BILLED: "That purchase order already has a bill.",
  BILL_EXCEEDS_PO: "That bill is more than the purchase order allows.",
  INVOICE_HAS_UNSPENT_CREDIT:
    "This invoice has unspent credit. Release or use it first, then try again.",
  [API_ERROR_CODES.INVOICE_HAS_CASH_REFUND]:
    "Part of this invoice was refunded in cash. Issue a credit note for the rest instead of voiding.",
  [API_ERROR_CODES.ORDER_HAS_CASH_REFUND]:
    "Part of this order was refunded in cash. Issue a credit note instead of cancelling.",
  // SA-762r: the counter-sale void's own refusals (the same sentences the void dialog shows).
  [API_ERROR_CODES.COUNTER_SALE_VOID_HAS_RETURN]:
    COUNTER_VOID_ERROR_COPY[API_ERROR_CODES.COUNTER_SALE_VOID_HAS_RETURN],
  [API_ERROR_CODES.COUNTER_SALE_VOID_FOREIGN_PAYMENT]:
    COUNTER_VOID_ERROR_COPY[API_ERROR_CODES.COUNTER_SALE_VOID_FOREIGN_PAYMENT],
  [API_ERROR_CODES.COUNTER_SALE_VOID_NOT_TODAY]:
    COUNTER_VOID_ERROR_COPY[API_ERROR_CODES.COUNTER_SALE_VOID_NOT_TODAY],
  [API_ERROR_CODES.COUNTER_SALE_VOID_BUSY]:
    COUNTER_VOID_ERROR_COPY[API_ERROR_CODES.COUNTER_SALE_VOID_BUSY],
  // SA-750r3: the end-of-day close refusals. The FALLBACK for any dialog with no copy of its own (a void-payment, a bookkeeping
  // payment, a refund): a surface with a better next step (Void: Return, Refund: store credit) says it itself.
  [API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED]: COUNTER_SALE_DAY_CLOSED_COPY,
  [API_ERROR_CODES.DAY_CLOSED_FOR_PAYMENT_DATE]: DAY_CLOSED_FOR_PAYMENT_DATE_COPY,
  // P-4: the one overpay copy (order-overpay.ts); a surface with the structured numbers uses orderOverpayCopy.
  [API_ERROR_CODES.ORDER_EDIT_WOULD_OVERPAY]: ORDER_OVERPAY_GENERIC_COPY,
  HANDOFF_CODE_INVALID: "This sign-in link is invalid or has expired. Sign in again.",
  // SA-733r5 (billing go-live): a manual-pay account completes card setup through its RouteFlow contact, and a card
  // checkout already in progress blocks a second one. Fixed sentences; no ids.
  [API_ERROR_CODES.EXTERNAL_PAYMENT_USE_CATCHUP]:
    "Your account is invoiced directly. Your RouteFlow contact will send you a secure link to set up card payment.",
  [API_ERROR_CODES.CATCHUP_SESSION_OPEN]:
    "A card checkout is open for this account (October catch-up), so this change isn't available yet. Wait for it to complete or expire, then try again.",
  [API_ERROR_CODES.CATCHUP_PENDING]:
    "This account's card payment is being confirmed (October catch-up). This change is available once it clears.",
  // SA-733r5 r-note: a catch-up the plan refuses because card billing would lose or change a charge. The account
  // stays on invoiced billing; fixed sentences, no ids.
  [API_ERROR_CODES.CATCHUP_ADDON_NOT_CARD_BILLABLE]:
    "This account has an add-on that card billing can't carry yet, so it stays on invoiced billing for now. Your RouteFlow contact will follow up.",
  [API_ERROR_CODES.ACTIVATION_CATCHUP_SESSION_OPEN]:
    "A card checkout is open for this account (October catch-up), so it can't be activated by hand yet. Wait for the checkout to complete or expire, then try again.",
  [API_ERROR_CODES.CATCHUP_MANUAL_PERIOD_AHEAD]:
    "This account has days already paid that end part-way through a month, so it stays on invoiced billing for now. Your RouteFlow contact will follow up.",
  [API_ERROR_CODES.CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG]:
    "This account's add-on price or quantity differs from the standard one, so it stays on invoiced billing for now. Your RouteFlow contact will follow up.",
  // SA-733r7 PR-B3 (dunning): a plan change is refused while an invoice is overdue; paying it restores everything.
  [API_ERROR_CODES.PAYMENT_OVERDUE]:
    "An invoice on this account is overdue. Pay it to continue; plan changes are available again right after.",
  [API_ERROR_CODES.PAYMENT_STATE_UNKNOWN]:
    "We couldn't confirm your open invoice just now. Please try again in a moment.",
  // B1102: a catalog add-on whose plan setting is invalid is refused instead of billed; fixed sentence, no ids.
  [API_ERROR_CODES.ADDON_CATALOG_INVALID]:
    "This add-on can't be changed right now because of a setup problem on our side. Please contact support.",
};

/** Exact server sentences (already product text) for refusals with no `code`; matched whole, never partially. */
const KNOWN_REFUSAL_SENTENCES: Record<string, string> = {
  "Cannot duplicate an order-linked invoice. Create a new invoice or issue a credit note instead.":
    "This invoice came from an order, so it can't be duplicated. Create a new invoice or issue a credit note instead.",
};

const PLAN_COPY = "This isn't included in your current plan.";
// SA-776: the owner's sentence, verbatim (shared with mobile); the reason line needs the subscription read.
const READ_ONLY_COPY = READ_ONLY_SENTENCE;
const GENERIC_COPY = "Something went wrong. Please try again.";

function statusCopy(status: number, refusal?: string): string {
  // A surface may say what to fix for an UNCODED refusal (400 / 409 / 422); every other status keeps its own sentence.
  if (refusal && (status === 400 || status === 409 || status === 422)) return refusal;
  if (status === 400 || status === 422)
    return "Some details aren't valid. Check what you entered and try again.";
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That item no longer exists. Refresh and try again.";
  // Most uncoded 409s are "already exists / in use": say that, not "stale data".
  if (status === 409)
    return "That conflicts with something that already exists or is in use. Check it and try again.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500) return "Something went wrong on our side. Please try again.";
  return GENERIC_COPY;
}

/**
 * ONE numberless sentence for every INSUFFICIENT_STOCK body shape. `available`/`requested` count
 * PIECES with no unit noun, so "Only N left" would overstate stock to a box buyer; #2871's builder
 * (which knows the unit and the product name) replaces this when it lands.
 */
const STOCK_COPY = "Some items aren't available in that quantity.";

const usd = (n: unknown): string | null =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? `$${n.toFixed(2)}` : null;

/** A payment's allocations add up to more than the payment: the two amounts come from structured body fields. */
function allocationsCopy(data: Record<string, unknown>): string {
  const allocated = usd(data.allocatedTotal);
  const total = usd(data.totalAmount);
  const lead =
    allocated && total
      ? `The allocations add up to ${allocated}, more than the ${total} payment.`
      : "The allocations add up to more than the payment.";
  return `${lead} Lower an allocation or raise the payment amount.`;
}

/**
 * A duplicate vendor bill (document identity: same supplier invoice number, or the same scanned lines): points at the EXISTING
 * bill from the structured `duplicate` payload. It never suggests changing the invoice number, which would defeat the guard.
 */
const BILL_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,39}$/;
function duplicateBillCopy(data: Record<string, unknown>): string {
  const dup = (data.duplicate ?? {}) as { billNumber?: unknown; status?: unknown };
  const number =
    typeof dup.billNumber === "string" && BILL_NUMBER.test(dup.billNumber) ? dup.billNumber : null;
  if (!number) return "This bill is already recorded. Open the existing bill instead.";
  return dup.status === "DRAFT"
    ? `This bill is already saved as draft ${number}. Open it to finish receiving instead of creating a second bill.`
    : `This bill is already recorded as ${number}. Open it instead.`;
}

/** Receiving a bill with unlinked lines (or no lines): says what to do next. The line list is the caller's dialog, not toast text. */
function unlinkedCopy(data: Record<string, unknown>): string {
  return Array.isArray(data.unlinkedItems) && data.unlinkedItems.length === 0
    ? "This bill has no line items, so receiving it won't update inventory or costs. Add the lines first."
    : "Some bill lines aren't linked to a product, so they won't update inventory or costs. Link them, or confirm to receive the bill anyway.";
}

/** The closed duplicate-name 409s ("A category named "X" already exists."): the noun is matched, the typed name is never shown. */
const DUPLICATE_NAME =
  /^A (category|subcategory|product) named ".*" already exists(?: in this section)?\.?$/;
/** Static server sentences that already tell the user what to do (B986-7: send email, delete order). */
const ACTIONABLE_REFUSALS: Record<string, string> = {
  // the unit-selling plan limit is an uncoded 403: say it is a PLAN limit, not a permission problem
  "Selling by unit is not included in this plan.":
    "Selling by unit isn't included in your current plan.",
  "No email address on file for this customer. Provide an email address.":
    "No email address on file for this customer. Provide an email address.",
  "This order has returns recorded against it. Delete those returns first.":
    "This order has returns recorded against it. Delete those returns first.",
};
const DELETE_STATUS =
  /^Only DRAFT, PENDING, or CANCELLED orders can be deleted\. This order is (?:DRAFT|PENDING|CONFIRMED|PROCESSING|READY|OUT_FOR_DELIVERY|DELIVERED|PARTIALLY_DELIVERED|COMPLETED|FULFILLED|CANCELLED|[A-Z_]{3,24})\.$/;
const DUPLICATE_FIELD: Record<string, string> = {
  "SKU already exists": "That SKU is already used by another product. Use a different SKU.",
  "Barcode already exists":
    "That barcode is already used by another product. Use a different barcode.",
};

/** A server sentence that is already product text, matched WHOLE against the two closed tables. */
function sentenceForMessage(data: Record<string, unknown>): string | null {
  const message = data.message;
  if (typeof message !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(KNOWN_SERVER_SENTENCES, message))
    return KNOWN_SERVER_SENTENCES[message];
  if (Object.prototype.hasOwnProperty.call(KNOWN_REFUSAL_SENTENCES, message))
    return KNOWN_REFUSAL_SENTENCES[message];
  if (Object.prototype.hasOwnProperty.call(DUPLICATE_FIELD, message))
    return DUPLICATE_FIELD[message];
  if (Object.prototype.hasOwnProperty.call(ACTIONABLE_REFUSALS, message))
    return ACTIONABLE_REFUSALS[message];
  if (DELETE_STATUS.test(message))
    return "Only draft, pending or cancelled orders can be deleted. Cancel this order first if it's still open.";
  const dup = DUPLICATE_NAME.exec(message);
  if (dup) return `A ${dup[1]} with that name already exists. Choose a different name.`;
  return null;
}

/**
 * The fixed sentence a generic mutation toast shows for `err`. `surfaceRefusal` (optional) is the surface's own actionable
 * sentence for an UNCODED 400 / 409 / 422; coded refusals, known sentences and every other status are unchanged.
 */
/**
 * The fixed sentence for a refusal the client RECOGNISES (a safe-text refusal, a plan gate, a mapped `code`, a closed known
 * sentence), or null when the failure is uncoded / unknown / has no HTTP response. A surface whose uncoded server sentence
 * already tells the user what to fix uses `codedToastCopy(err) ?? <today's text>` so it never gets LESS actionable.
 */
export function codedToastCopy(err: unknown): string | null {
  const refusal = safeTextErrorCopy(err);
  if (refusal) return refusal;
  if (!err || typeof err !== "object") return null;
  const response = (err as { response?: { status?: number; data?: unknown } }).response;
  if (!response) return null;
  const data = (response.data && typeof response.data === "object" ? response.data : {}) as Record<
    string,
    unknown
  >;
  const gate = parsePlanGate(err);
  if (gate && gate.code !== API_ERROR_CODES.PLAN_GATE_UNAVAILABLE) return PLAN_COPY;
  const code = typeof data.code === "string" ? data.code : "";
  if (code === API_ERROR_CODES.ADDON_GATE) return PLAN_COPY;
  if (code === API_ERROR_CODES.READ_ONLY) return READ_ONLY_COPY;
  if (code === API_ERROR_CODES.INSUFFICIENT_STOCK) return STOCK_COPY;
  // B986: coded refusals whose server sentence tells the user what to fix; the numbers come from STRUCTURED fields.
  if (code === API_ERROR_CODES.ALLOCATIONS_EXCEED_PAYMENT) return allocationsCopy(data);
  if (code === API_ERROR_CODES.UNLINKED_ITEMS) return unlinkedCopy(data);
  if (code === API_ERROR_CODES.DUPLICATE_VENDOR_BILL) return duplicateBillCopy(data);
  if (code === API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED)
    return creditLimitSentence(data.limit, data.exposure);
  // CQ-06 review: a selling-restriction refusal with no dialog of its own says what is wrong and the next step.
  if (code === API_ERROR_CODES.SELLING_RESTRICTED) return sellingRestrictedCopy(data.blockedLines);
  // CQ-06: the license refusal says what is wrong (expired / none on file) and where to fix it (shared with mobile).
  if (code === API_ERROR_CODES.REGULATED_AUTH_REQUIRED)
    return regulatedAuthCopy(data.blockedCategories);
  if (Object.prototype.hasOwnProperty.call(CREDIT_NOTE_ERROR_COPY, code))
    return CREDIT_NOTE_ERROR_COPY[code as keyof typeof CREDIT_NOTE_ERROR_COPY];
  if (Object.prototype.hasOwnProperty.call(CODE_COPY, code)) return CODE_COPY[code];
  return sentenceForMessage(data);
}

export function genericToastCopy(err: unknown, surfaceRefusal?: string): string {
  const coded = codedToastCopy(err);
  if (coded) return coded;
  if (!err || typeof err !== "object") return GENERIC_COPY;
  const response = (err as { response?: { status?: number } }).response;
  // No HTTP response: a timeout or dropped connection may have committed; a plain client Error did not.
  if (!response) return noResponse(err) ? UNCONFIRMED_COPY : GENERIC_COPY;
  return typeof response.status === "number"
    ? statusCopy(response.status, surfaceRefusal)
    : GENERIC_COPY;
}
