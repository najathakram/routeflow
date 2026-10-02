import { API_ERROR_CODES } from "@routeflow/types";

/** The body `field` of a TEXT_CELL_FORMULA_LEAD refusal (the input to focus), or null for any other error. */
export function refusedTextField(err: unknown): string | null {
  const data = (err as { response?: { data?: { code?: unknown; field?: unknown } } } | null)
    ?.response?.data;
  return data?.code === API_ERROR_CODES.TEXT_CELL_FORMULA_LEAD && typeof data.field === "string"
    ? data.field
    : null;
}

const CONTACT_FIELD_IDS: Record<string, string> = {
  firstName: "contact-first-name",
  lastName: "contact-last-name",
};

/** `onError` for the contact modal's mutations: a refused formula-led name keeps the modal open and puts the cursor in that input. */
export function focusRefusedContactField(err: unknown): void {
  const id = CONTACT_FIELD_IDS[refusedTextField(err) ?? ""];
  if (id) requestAnimationFrame(() => document.getElementById(id)?.focus());
}
