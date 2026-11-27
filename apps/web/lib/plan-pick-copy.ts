import { API_ERROR_CODES } from "@routeflow/types";
import {
  CHECKOUT_PAYMENT_IN_PROGRESS_SENTENCE,
  CUSTOM_FEE_PLAN_PICK_REFUSED_SENTENCE,
  PLAN_PICK_ASK_FOR_LINK_SENTENCE,
  SELF_SERVE_PLAN_NOT_ALLOWED_SENTENCE,
} from "@routeflow/types/plan-pick-copy";

/**
 * SA-1547 PR-5 (web twin of mobile's `lib/plan-pick-copy.ts`): the plan-pick surface shows FIXED copy chosen by
 * `response.data.code`, never the server message. Null for any other code so the caller falls through to the generic toast.
 *
 * `CHECKOUT_PAYMENT_IN_PROGRESS` is mapped HERE and not in `genericToastCopy`: the platform-admin price override raises the
 * same code, and the backoffice pricing card shows the generic toast.
 */
const PLAN_PICK_COPY: Record<string, string> = {
  [API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED]: SELF_SERVE_PLAN_NOT_ALLOWED_SENTENCE,
  [API_ERROR_CODES.CUSTOM_FEE_PLAN_PICK_REFUSED]: CUSTOM_FEE_PLAN_PICK_REFUSED_SENTENCE,
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
