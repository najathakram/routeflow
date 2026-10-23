import type { CustomerFormValues, CustomerPayload } from "../components/CustomerForm";
import { writableFulfillPath } from "./customer-fulfill-path";
import { clearableField, optionalText } from "./clearable-field";

function parseOptionalNumber(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Mirrors web's CustomerFormModal: the username no longer depends on the (now
 * optional) email — take the email local-part when there is one, else the
 * business or contact name, slugified, with a short suffix so it stays unique.
 */
function deriveUsername(email: string, businessName: string, contactName: string): string {
  const base =
    (email ? email.split("@")[0] : businessName || contactName)
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .slice(0, 24) || "customer";
  return `${base}_${Date.now().toString(36)}`;
}

export function buildPayload(
  form: CustomerFormValues,
  initial: CustomerFormValues,
  mode: "create" | "edit",
): CustomerPayload | { error: string } {
  const businessName = form.businessName.trim();
  if (!businessName) return { error: "Business name is required." };

  // Address is optional on create (you can always add one later from the
  // Addresses screen) — but once the operator starts filling it in, require
  // the full set, same rule AddAddressForm uses on the Addresses screen.
  const street = form.street.trim();
  const city = form.city.trim();
  const state = form.state.trim();
  const zip = form.zip.trim();
  const hasAnyAddressInput = mode === "create" && !!(street || city || state || zip);
  const hasFullAddress = !!(street && city && state && zip);
  if (hasAnyAddressInput && !hasFullAddress) {
    return { error: "Street, city, state, and ZIP are all required to add an address." };
  }

  const contactName = form.contactName.trim();
  const email = form.email.trim();

  return {
    businessName,
    // Create-only — see CustomerPayload.username.
    username: mode === "create" ? deriveUsername(email, businessName, contactName) : undefined,
    // CreateCustomerDto declares contactName as a REQUIRED @IsString, so create
    // must always send a string ("" is accepted, and is what web sends when the
    // field is blank); edit keeps `undefined` = leave as-is.
    contactName: mode === "create" ? contactName : contactName || undefined,
    // Edit sends "" so a blanked field CLEARS the stored email server-side
    // (UpdateCustomerDto emptyToNull) — `|| undefined` made clearing a silent
    // no-op, so a sentinel could never be removed. Create keeps `undefined`:
    // CreateCustomerDto's @IsEmail rejects "" and the service mints its own
    // placeholder for an absent email.
    email: mode === "edit" ? email : email || undefined,
    phone: optionalText(mode, form.phone, initial.phone),
    creditLimit: parseOptionalNumber(form.creditLimit),
    pricingTier: form.pricingTier,
    currency: form.currency.trim() || undefined,
    notes: optionalText(mode, form.notes, initial.notes),
    // Edit-only: CreateCustomerDto has no delivery-window fields, and
    // `forbidNonWhitelisted` rejects the ENTIRE create payload over one unknown
    // property — a filled window would take the address bundle down with it.
    // The window is set from the edit screen instead (section below matches).
    deliveryWindowStart:
      mode === "edit"
        ? clearableField(form.deliveryWindowStart, initial.deliveryWindowStart)
        : undefined,
    deliveryWindowEnd:
      mode === "edit"
        ? clearableField(form.deliveryWindowEnd, initial.deliveryWindowEnd)
        : undefined,
    isTaxExempt: form.isTaxExempt,
    taxId: optionalText(mode, form.taxId, initial.taxId),
    fulfillPath: writableFulfillPath(form.fulfillPath),
    addresses:
      mode === "create" && hasFullAddress
        ? [{ label: "Main", line1: street, city, state, zip, isDefault: true }]
        : undefined,
  };
}
