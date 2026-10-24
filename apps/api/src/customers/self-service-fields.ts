/**
 * The ONLY customer fields the customer themself may write (PATCH /customers/me). The same contact and
 * preference set as the buyer-portal profile body (buyer/dto/update-buyer-profile.dto.ts). The account's
 * names (`businessName`, `displayName`) are staff-edited: a customer does not rename their own account
 * record from the portal (B1055). The seller-controlled commercial fields (tax status, price tier, credit limit, payment terms, deposit default, currency, tax id,
 * customer type, fulfilment path and the like) are deliberately absent, and so is everything not listed. Customer
 * `notes` are staff-internal and absent too. ONE list: it drives the buyer profile body type
 * (buyer/dto/update-buyer-profile.dto.ts derives from the staff DTO with it) AND pickSelfServiceFields.
 */
export const SELF_SERVICE_FIELDS = [
  "contactName",
  "phone",
  "email",
  "mobile",
  "salutation",
  "firstName",
  "lastName",
  "deliveryWindowStart",
  "deliveryWindowEnd",
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

/**
 * Customer fields that stay staff-internal: never returned on a customer-facing response. `notes` is the
 * operator's free text; `tagAssignments` carries the operator-applied CRM labels (CustomerTag), which have no
 * customer-facing use.
 */
export const STAFF_ONLY_CUSTOMER_FIELDS = ["notes", "tagAssignments"] as const;

/** A copy of a customer row without the staff-only fields (never mutates the input). */
export function omitStaffOnlyCustomerFields<T extends Record<string, unknown>>(
  customer: T,
): Omit<T, (typeof STAFF_ONLY_CUSTOMER_FIELDS)[number]> {
  const out: Record<string, unknown> = { ...customer };
  for (const key of STAFF_ONLY_CUSTOMER_FIELDS) delete out[key];
  return out as Omit<T, (typeof STAFF_ONLY_CUSTOMER_FIELDS)[number]>;
}
