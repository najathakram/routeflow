/**
 * The ONLY customer fields the customer themself may write (PATCH /customers/me). The same contact and
 * preference set as the buyer-portal profile body (buyer/dto/update-buyer-profile.dto.ts). The seller-controlled
 * commercial fields (tax status, price tier, credit limit, payment terms, deposit default, currency, tax id,
 * customer type, fulfilment path and the like) are deliberately absent, and so is everything not listed.
 */
export const SELF_SERVICE_FIELDS = [
  "businessName",
  "contactName",
  "phone",
  "email",
  "mobile",
  "displayName",
  "salutation",
  "firstName",
  "lastName",
  "deliveryWindowStart",
  "deliveryWindowEnd",
  "notes",
  "orderStatusEmails",
] as const;

export type SelfServiceField = (typeof SELF_SERVICE_FIELDS)[number];

/** A copy of `body` holding only the allowlisted keys that are present (never mutates the input). */
export function pickSelfServiceFields<T extends Record<string, unknown>>(
  body: T,
): Partial<Pick<T, Extract<SelfServiceField, keyof T>>> {
  const out: Record<string, unknown> = {};
  for (const key of SELF_SERVICE_FIELDS) {
    if (body && Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
      out[key] = body[key];
    }
  }
  return out as Partial<Pick<T, Extract<SelfServiceField, keyof T>>>;
}
