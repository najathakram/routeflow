import { API_ERROR_CODES } from "@routeflow/types";

/**
 * B956 (owner rule: no raw server strings in the UI): a customer / tenant NAME write refused with
 * `TEXT_CELL_FORMULA_LEAD` is shown as FIXED copy with a human field label. The server `message`
 * and the camelCase `field` key are never rendered. A missing or different code returns null so the
 * caller keeps its own fallback. apps/mobile/lib/safe-text-error-copy.ts carries the SAME map (a
 * spec pins them equal).
 */
export const SAFE_TEXT_FIELD_LABELS: Record<string, string> = {
  businessName: "Business name",
  contactName: "Contact name",
  displayName: "Display name",
};

const UNKNOWN_FIELD_LABEL = "This field";

/** The copy for a refusal body `{ code, field }`, or null when the body is not that refusal. */
export function safeTextBodyCopy(body: unknown): string | null {
  const b = body as { code?: unknown; field?: unknown } | null | undefined;
  if (!b || b.code !== API_ERROR_CODES.TEXT_CELL_FORMULA_LEAD) return null;
  const label =
    typeof b.field === "string" &&
    Object.prototype.hasOwnProperty.call(SAFE_TEXT_FIELD_LABELS, b.field)
      ? SAFE_TEXT_FIELD_LABELS[b.field]
      : UNKNOWN_FIELD_LABEL;
  return `${label} can't start with =, +, -, @ or a tab/line break.`;
}

/** The same, from an axios error (`err.response.data`). */
export function safeTextErrorCopy(err: unknown): string | null {
  return safeTextBodyCopy(
    (err as { response?: { data?: unknown } } | null | undefined)?.response?.data,
  );
}
