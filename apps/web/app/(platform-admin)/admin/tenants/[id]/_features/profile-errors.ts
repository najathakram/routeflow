import { API_ERROR_CODES } from "@routeflow/types";

/**
 * Fixed copy for a failed business-profile / fulfilment-mode call, chosen by the API's error CODE. The server message
 * is never shown (the B986 ratchet: no raw server text on screen). Feature KEYS in the body are turned into registry
 * LABELS by the caller's lookup; an unknown key becomes a generic phrase, never the raw key.
 */
// TODO(merge with the API lane): the three profile/fleet codes below move to API_ERROR_CODES (apps/api + packages/types +
// mobile) in U-units' PR; switch these literals to the constants then (api-error-codes-parity bans bare literals).
const COPY: Record<string, string> = {
  BUSINESS_PROFILE_UNKNOWN: "That business profile does not exist.",
  BUSINESS_PROFILE_UNAVAILABLE: "That business profile is not available yet.",
};

const NEEDS_FLEET = "Delivery needs a fleet feature turned on first";
const NEEDS_FEATURE =
  "This needs a feature this tenant does not have. Enable it first, then try again.";

function labelList(keys: unknown, labelOf?: (key: string) => string | undefined): string | null {
  if (!Array.isArray(keys)) return null;
  const labels = keys
    .filter((k): k is string => typeof k === "string")
    .map((k) => labelOf?.(k))
    .filter((l): l is string => !!l);
  return labels.length > 0 ? labels.join(" or ") : null;
}

export function profileErrorCopy(
  err: unknown,
  fallback: string,
  labelOf?: (key: string) => string | undefined,
): string {
  const e = err as { response?: { status?: number; data?: { code?: unknown; missing?: unknown } } };
  const code = e?.response?.data?.code;
  const missing = e?.response?.data?.missing;
  if (code === "FULFILMENT_MODE_NEEDS_FLEET") {
    const named = labelList(missing, labelOf);
    return named ? `${NEEDS_FLEET}: ${named}. Any one is enough.` : `${NEEDS_FLEET}.`;
  }
  if (code === API_ERROR_CODES.FEATURE_MODE_REQUIRES) {
    const named = labelList(typeof missing === "string" ? [missing] : missing, labelOf);
    return named ? `This needs ${named} turned on first.` : NEEDS_FEATURE;
  }
  if (typeof code === "string" && COPY[code]) return COPY[code];
  if (e?.response?.status === 404) return "That tenant was not found.";
  return fallback;
}
