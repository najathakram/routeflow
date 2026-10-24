/**
 * Edit payloads that can CLEAR an optional text field (#3206 follow-up). `|| undefined` made an emptied
 * field a silent no-op, so a stored salutation / name / email could never be removed.
 */

/** The trimmed value; an explicit `null` when a value the form LOADED was emptied (the API stores
 *  null); `undefined` (leave alone) when there was nothing to clear, so an edit never writes a column
 *  it never saw. */
export function clearableField(
  next: string | null | undefined,
  loaded: string | null | undefined,
): string | null | undefined {
  const value = next?.trim();
  if (value) return value;
  return loaded ? null : undefined;
}

export interface ContactPersonForm {
  salutation: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  mobile: string;
  isPrimary: boolean;
}

type StoredContact = Partial<
  Record<"salutation" | "lastName" | "email" | "phone" | "mobile", string | null>
>;

type OptionalKey = "salutation" | "lastName" | "email" | "phone" | "mobile";
type ContactBody<Empty> = { firstName: string; isPrimary: boolean } & Record<
  OptionalKey,
  string | Empty
>;

/** The add / edit body for a contact person. `stored` is the contact being edited (null on add):
 *  an add never carries null, an edit may (a cleared field). */
export function contactPersonPayload(form: ContactPersonForm, stored: null): ContactBody<undefined>;
export function contactPersonPayload(
  form: ContactPersonForm,
  stored: StoredContact,
): ContactBody<null | undefined>;
export function contactPersonPayload(
  form: ContactPersonForm,
  stored: StoredContact | null,
): ContactBody<null | undefined> {
  const optional = (key: OptionalKey) =>
    stored ? clearableField(form[key], stored[key]) : form[key].trim() || undefined;
  return {
    salutation: optional("salutation"),
    firstName: form.firstName.trim(),
    lastName: optional("lastName"),
    email: optional("email"),
    phone: optional("phone"),
    mobile: optional("mobile"),
    isPrimary: form.isPrimary,
  };
}
