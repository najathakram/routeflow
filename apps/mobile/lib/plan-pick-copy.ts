import { API_ERROR_CODES } from "@routeflow/types";
import {
  CHECKOUT_PAYMENT_IN_PROGRESS_SENTENCE,
  CUSTOM_FEE_PLAN_PICK_REFUSED_SENTENCE,
  PLAN_PICK_ASK_FOR_LINK_SENTENCE,
  PLAN_PICK_OFF_REASON,
  PLAN_PICK_OFF_SENTENCE,
  SELF_SERVE_PLAN_NOT_ALLOWED_SENTENCE,
} from "@routeflow/types/plan-pick-copy";

/**
 * SA-1547 PR-5 (mirror of web's generic-toast-copy): a plan pick's refusals are shown as FIXED copy chosen by
 * `response.data.code`, never the server message. Null for any other code so the caller falls through.
 */
const PLAN_PICK_COPY: Record<string, string> = {
  [API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED]: SELF_SERVE_PLAN_NOT_ALLOWED_SENTENCE,
  [API_ERROR_CODES.CUSTOM_FEE_PLAN_PICK_REFUSED]: CUSTOM_FEE_PLAN_PICK_REFUSED_SENTENCE,
  [API_ERROR_CODES.PLAN_PICK_ASK_FOR_LINK]: PLAN_PICK_ASK_FOR_LINK_SENTENCE,
  [API_ERROR_CODES.CHECKOUT_PAYMENT_IN_PROGRESS]: CHECKOUT_PAYMENT_IN_PROGRESS_SENTENCE,
};

export function planPickCopy(err: unknown): string | null {
  const data = (
    err as { response?: { data?: { code?: unknown; reason?: unknown } } } | null | undefined
  )?.response?.data;
  // SA-1325 Q1: a pick while card-first is off is a 403 with a reason, no code
  if (data?.reason === PLAN_PICK_OFF_REASON) return PLAN_PICK_OFF_SENTENCE;
  const code = data?.code;
  return typeof code === "string" && Object.hasOwn(PLAN_PICK_COPY, code)
    ? PLAN_PICK_COPY[code]
    : null;
}
