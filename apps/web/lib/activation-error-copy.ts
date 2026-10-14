import { API_ERROR_CODES } from "@routeflow/types";

/**
 * ACTIVATION_PERIOD_ALREADY_ENDED (409 from manual activation): the activation's prepaid window ended before
 * today because an older RouteFlow invoice is still OPEN. The server body carries `invoiceNumber`, `endedOn`
 * (ISO date) and `minDays`; the copy is built HERE from those structured fields, never from the server message.
 * Every field is optional and validated: a missing or malformed one falls back to a plain phrase.
 */
const INVOICE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,39}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function activationEndedSentence(body: Record<string, unknown>): string {
  const number =
    typeof body.invoiceNumber === "string" && INVOICE_NUMBER.test(body.invoiceNumber)
      ? body.invoiceNumber
      : null;
  const endedOn =
    typeof body.endedOn === "string" && ISO_DATE.test(body.endedOn) ? body.endedOn : null;
  const minDays =
    typeof body.minDays === "number" &&
    Number.isInteger(body.minDays) &&
    body.minDays >= 1 &&
    body.minDays <= 3650
      ? body.minDays
      : null;
  const who = number ? `Invoice ${number}` : "An invoice";
  const when = endedOn ? `ended on ${endedOn}` : "has already ended";
  const fix = minDays
    ? `activate for at least ${minDays} ${minDays === 1 ? "day" : "days"}`
    : "activate for more days";
  return `${who} is still open and this payment's window ${when}. Mark it paid or void it in RouteFlow invoices, or ${fix}.`;
}

/**
 * ACTIVATION_OVERLAPS_PAID_PERIOD (409): the window would run over a RouteFlow invoice that is already PAID. Built from
 * the structured fields (invoiceNumber, paidFrom, maxDays); a missing or malformed one falls back to a phrase.
 */
export function activationOverlapsPaidSentence(body: Record<string, unknown>): string {
  const number =
    typeof body.invoiceNumber === "string" && INVOICE_NUMBER.test(body.invoiceNumber)
      ? body.invoiceNumber
      : null;
  const paidFrom =
    typeof body.paidFrom === "string" && ISO_DATE.test(body.paidFrom) ? body.paidFrom : null;
  const maxDays =
    typeof body.maxDays === "number" &&
    Number.isInteger(body.maxDays) &&
    body.maxDays >= 0 &&
    body.maxDays <= 3650
      ? body.maxDays
      : null;
  const who = number ? `Invoice ${number}` : "A RouteFlow invoice";
  const from = paidFrom ? ` (its period starts ${paidFrom})` : "";
  const fix =
    maxDays === null
      ? "Activate for fewer days."
      : maxDays >= 1
        ? `Activate for at most ${maxDays} ${maxDays === 1 ? "day" : "days"}.`
        : "Mark the older open invoices paid or void them in RouteFlow invoices instead.";
  return `${who} is already paid${from} and this window would cover it again. Nothing was recorded. ${fix}`;
}

/** The mapped sentence for an ACTIVATION_PERIOD_ALREADY_ENDED error, or null for any other failure. */
export function activationEndedCopy(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  return body.code === API_ERROR_CODES.ACTIVATION_PERIOD_ALREADY_ENDED
    ? activationEndedSentence(body)
    : null;
}

/** The mapped sentence for an ACTIVATION_OVERLAPS_PAID_PERIOD error, or null for any other failure. */
export function activationOverlapsPaidCopy(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  return body.code === API_ERROR_CODES.ACTIVATION_OVERLAPS_PAID_PERIOD
    ? activationOverlapsPaidSentence(body)
    : null;
}

/** The Manual Activation error line: the mapped sentence for the two window 409s, else the server message. */
export function activationErrorText(err: unknown): string {
  return (
    activationEndedCopy(err) ??
    activationOverlapsPaidCopy(err) ??
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    "Activation failed"
  );
}
