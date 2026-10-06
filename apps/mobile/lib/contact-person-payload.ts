/**
 * Contact-person add / edit body that can CLEAR an optional field (#3206 follow-up; mirror of web's
 * apps/web/lib/contact-person-payload.ts). `|| undefined` made an emptied field a silent no-op, so a
 * stored last name / email / phone could never be removed. On edit, an emptied field that had a stored
 * value is an explicit null (the API stores null); one with nothing stored is left out.
 */
export interface ContactSheetForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  mobile: string;
  isPrimary: boolean;
}

type StoredContact = Partial<Record<"lastName" | "email" | "phone" | "mobile", string | null>>;

export function contactPersonPayload(form: ContactSheetForm, stored: StoredContact | null) {
  const optional = (key: keyof StoredContact): string | null | undefined => {
    const value = form[key].trim();
    if (value) return value;
    return stored?.[key] ? null : undefined;
  };
  return {
    firstName: form.firstName.trim(),
    lastName: optional("lastName"),
    email: optional("email"),
    phone: optional("phone"),
    mobile: optional("mobile"),
    isPrimary: form.isPrimary,
  };
}
