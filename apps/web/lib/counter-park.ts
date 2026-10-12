import {
  COUNTER_PARK_MAX_PER_REGISTER,
  COUNTER_PARK_MAX_PER_TENANT,
  COUNTER_PARK_STALE_HOURS,
  sanitizeParkedPayload,
  type ParkedCartPayload,
  type ParkedPayloadRefusal,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import { COUNTER_SALES_DISABLED_COPY } from "./counter-sale";

/**
 * Counter sale PARK / RESUME (SA-748): the pure web side. The shapes, limits and the whitelist rebuild are the shared
 * contract in @routeflow/pricing; this file only adds the fixed copy and the little helpers the Parked list needs.
 * Every refusal has FIXED copy: the server's own message is never shown.
 */

export const PARK_TENANT_LIMIT_COPY = `Too many sales are parked across the shop (${COUNTER_PARK_MAX_PER_TENANT}). Resume or discard one first.`;
export const PARK_LIMIT_COPY = `This register already has ${COUNTER_PARK_MAX_PER_REGISTER} parked sales. Resume or discard one first.`;
export const PARK_TAKEN_COPY = "That parked sale was already taken back or has expired.";
export const PARK_TOO_BIG_COPY =
  "This sale is too large to park. Complete it or remove some items.";
export const PARK_TOO_MANY_LINES_COPY = "This sale has too many items to park.";
export const PARK_ID_CONFLICT_COPY =
  "This sale was already parked and has been taken back at another till. Check before you park or complete it.";
export const PARK_FAILED_COPY = "Couldn't park this sale. Nothing was changed. Try again.";
export const PARK_INVALID_COPY =
  "This sale can't be parked as it is. Check the items and try again.";
export const RESUME_FAILED_COPY =
  "Couldn't open that parked sale. Your sale is unchanged. Try again.";
export const DISCARD_FAILED_COPY = "Couldn't discard that parked sale. Try again.";
export const PARKED_LIST_FAILED_COPY = "Couldn't load the parked sales.";
export const PARKED_EMPTY_COPY = "No parked sales.";
export const PARKED_STALE_COPY = "from earlier — prices refresh when you pay";
export const PARK_CHANGED_COPY =
  "The sale changed while it was being parked. It is saved in Parked sales as it was; check the cart before you continue.";
export const PARKED_EDITED_PRICES_COPY =
  "This sale has edited prices and you can't change prices. Remove those items, or ask your account admin to finish it.";

type ErrLike =
  { response?: { status?: number; data?: { code?: unknown; scope?: unknown } } } | null | undefined;
const statusOf = (err: unknown) => (err as ErrLike)?.response?.status;
const codeOf = (err: unknown) => (err as ErrLike)?.response?.data?.code;

/** The fixed line for a park that did not go through. The cart is untouched. */
export function parkErrorCopy(err: unknown): string {
  const status = statusOf(err);
  const code = codeOf(err);
  if (status === 403 && code === API_ERROR_CODES.COUNTER_SALES_DISABLED)
    return COUNTER_SALES_DISABLED_COPY;
  if (status === 409 && code === API_ERROR_CODES.PARK_LIMIT) {
    // `scope` says which cap was hit; a body without it (an older server) keeps the register wording.
    return (err as ErrLike)?.response?.data?.scope === "tenant"
      ? PARK_TENANT_LIMIT_COPY
      : PARK_LIMIT_COPY;
  }
  // PARK_ID_CONFLICT: the id names a row this park may not replay (it may be live at another till). Nothing was saved, and
  // "try again" would invite a second copy of a cart that is already out, so the line says to check first.
  if (status === 409 && code === API_ERROR_CODES.PARK_ID_CONFLICT) return PARK_ID_CONFLICT_COPY;
  if (status === 413) return PARK_TOO_BIG_COPY;
  if (status === 400) return PARK_INVALID_COPY;
  return PARK_FAILED_COPY;
}

function takenOr(err: unknown, fallback: string): string {
  const status = statusOf(err);
  const code = codeOf(err);
  if (status === 403 && code === API_ERROR_CODES.COUNTER_SALES_DISABLED)
    return COUNTER_SALES_DISABLED_COPY;
  if (status === 404 && code === API_ERROR_CODES.PARK_TAKEN) return PARK_TAKEN_COPY;
  return fallback;
}
export const resumeErrorCopy = (err: unknown): string => takenOr(err, RESUME_FAILED_COPY);
export const discardErrorCopy = (err: unknown): string => takenOr(err, DISCARD_FAILED_COPY);

/** What the screen holds, before it is rebuilt from the whitelist. */
export interface ParkCartInput {
  lines: readonly unknown[];
  customer: unknown;
  method: string;
  tendered: string;
  reference: string;
}

/**
 * The payload the park POST carries: the screen state run through the SAME whitelist rebuild the server applies, so an
 * email on the customer or a stray key on a line never leaves the browser. `method` is the one method the cart holds.
 */
export function buildParkPayload(
  cart: ParkCartInput,
): { ok: true; value: ParkedCartPayload } | { ok: false; reason: ParkedPayloadRefusal } {
  return sanitizeParkedPayload(cart, [cart.method]);
}

export const parkRefusalCopy = (reason: ParkedPayloadRefusal): string =>
  reason === "TOO_MANY_LINES" ? PARK_TOO_MANY_LINES_COPY : PARK_INVALID_COPY;

/** Parked more than COUNTER_PARK_STALE_HOURS ago: the row says its prices refresh when the sale is paid. */
export function isStaleParked(createdAtIso: string, nowMs: number = Date.now()): boolean {
  const t = Date.parse(createdAtIso);
  return Number.isFinite(t) && nowMs - t > COUNTER_PARK_STALE_HOURS * 3_600_000;
}

/** "2:41 PM" in the business's zone. UTC when there is none or its name is not valid, never the browser's own zone (SA-738). */
export function formatParkedTime(iso: string, timeZone?: string | null): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(
      new Date(iso),
    );
  try {
    return fmt(timeZone || "UTC");
  } catch {
    return fmt("UTC");
  }
}

/**
 * Row 368: the server's DEFAULT walk-in label is "Walk-in · HH:MM" (24 h, the time it was parked), and the row also
 * printed the 12 h time beside it, so the time read twice. A default label becomes "Walk-in · 7:26 PM" and the separate
 * time is hidden; any other label (typed, or a customer's name) is shown as it is, with its time beside it.
 */
export function parkedRowTitle(
  label: string,
  createdAt: string,
  timeZone?: string | null,
): { title: string; timeShown: boolean } {
  if (/^Walk-in · \d{2}:\d{2}$/.test(label))
    return { title: `Walk-in · ${formatParkedTime(createdAt, timeZone)}`, timeShown: true };
  return { title: label, timeShown: false };
}

export const lineCountLabel = (n: number): string => (n === 1 ? "1 line" : `${n} lines`);
