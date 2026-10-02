import { API_ERROR_CODES } from "@routeflow/types";
import { safeTextErrorCopy } from "./safe-text-error-copy";

/**
 * B979 (owner rule: no raw strings in the UI): the customer form's error banner shows FIXED copy,
 * chosen by the server's `body.code`, then a closed allow-list of the two server sentences that are
 * already product text, then the HTTP status class. It never shows axios's "Request failed with
 * status code …", an unlisted server message, or a camelCase key.
 */

/** Exact server sentences (customers.service create/update) that name a fixable cause. */
const KNOWN_SERVER_SENTENCES: Record<string, string> = {
  "Email or username already taken": "That email is already in use. Use a different email.",
  "Unknown sales agent": "That sales agent is no longer available. Pick another.",
};

const CUSTOMER_CAP_COPY =
  "Your plan's customer limit has been reached. Upgrade your plan to add more customers.";
const PLAN_COPY = "This isn't included in your current plan.";
const GENERIC_COPY = "Something went wrong. Please try again.";
const NETWORK_COPY = "We couldn't reach the server. Check your connection and try again.";

function statusCopy(status: number): string {
  if (status === 400) return "Some details aren't valid. Check the form and try again.";
  if (status === 401 || status === 403) return "You don't have permission to do that.";
  if (status === 404) return "This customer no longer exists. Refresh and try again.";
  if (status === 409) return "This customer changed while you were editing. Refresh and try again.";
  if (status >= 500) return "Something went wrong on our side. Please try again.";
  return GENERIC_COPY;
}

export function customerFormErrorCopy(err: unknown): string {
  const refusal = safeTextErrorCopy(err);
  if (refusal) return refusal;
  if (!err || typeof err !== "object") return GENERIC_COPY;
  const response = (err as { response?: { status?: number; data?: unknown } }).response;
  if (!response) return NETWORK_COPY;
  const data = response.data as { code?: unknown; flag?: unknown; message?: unknown } | undefined;
  if (data?.code === "PLAN_GATE" && data.flag === "meter.customers") return CUSTOMER_CAP_COPY;
  if (data?.code === "PLAN_GATE" || data?.code === API_ERROR_CODES.ADDON_GATE) return PLAN_COPY;
  const message = data?.message;
  if (
    typeof message === "string" &&
    Object.prototype.hasOwnProperty.call(KNOWN_SERVER_SENTENCES, message)
  )
    return KNOWN_SERVER_SENTENCES[message];
  return typeof response.status === "number" ? statusCopy(response.status) : GENERIC_COPY;
}
