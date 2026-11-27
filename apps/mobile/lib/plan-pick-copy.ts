import { API_ERROR_CODES } from "@routeflow/types";
import {
  CHECKOUT_PAYMENT_IN_PROGRESS_SENTENCE,
  PLAN_PICK_ASK_FOR_LINK_SENTENCE,
} from "@routeflow/types/plan-pick-copy";

/**
 * SA-1547 PR-5a (mirror of web's generic-toast-copy): a plan pick's refusals are shown as FIXED copy chosen by
 * `response.data.code`, never the server message. Null for any other code so the caller falls through.
 */
const PLAN_PICK_COPY: Record<string, string> = {
  [API_ERROR_CODES.PLAN_PICK_ASK_FOR_LINK]: PLAN_PICK_ASK_FOR_LINK_SENTENCE,
  [API_ERROR_CODES.CHECKOUT_PAYMENT_IN_PROGRESS]: CHECKOUT_PAYMENT_IN_PROGRESS_SENTENCE,
};

export function planPickCopy(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data?.code;
  return typeof code === "string" && Object.hasOwn(PLAN_PICK_COPY, code)
    ? PLAN_PICK_COPY[code]
    : null;
}
