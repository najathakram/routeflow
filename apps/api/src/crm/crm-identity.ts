import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Identity helpers for the GoHighLevel CRM connector (spec R25). Pure functions, no
 * Prisma/HTTP — used by the poll/handoff matching pipeline (WP3) to compare a GHL contact
 * against existing RouteFlow customers and to derive a new customer's username.
 */

/** Trimmed, lower-cased; `null` when empty or missing an "@" (never throws). */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  return trimmed;
}

/** E.164 via libphonenumber-js given a region; `null` when invalid or unparsable (never throws). */
export function normalizePhoneE164(raw: string, region: string): string | null {
  try {
    const phoneNumber = parsePhoneNumberFromString(raw, region as never);
    if (phoneNumber && phoneNumber.isValid()) {
      return phoneNumber.number;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * lower-case, `[^a-z0-9]+` -> `_`, trimmed of leading/trailing `_`, capped at 30 chars,
 * padded with `_crm` when the result is under 3 chars (a username needs some minimum body).
 */
export function slugUsername(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug.length > 30) {
    slug = slug.slice(0, 30).replace(/_+$/g, "");
  }
  if (slug.length === 0) {
    slug = "crm";
  }
  if (slug.length < 3) {
    slug = `${slug}_crm`;
  }
  return slug;
}
