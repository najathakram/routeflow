/**
 * SA-1547 PR-5 (SA-C): the ONE sentence for each refusal a card-first plan pick (and its checkout) can answer, shared by web
 * (`generic-toast-copy.ts`) and mobile (`lib/plan-pick-copy.ts`) so the two cannot drift. Pure; no name, amount or key. A
 * client shows the sentence chosen by `body.code` (or, for `plan_pick_off`, `body.reason`), never the server's message.
 */
export const SELF_SERVE_PLAN_NOT_ALLOWED_SENTENCE =
  "This plan can't be chosen here right now. Reload the page to see the plans you can pick, or contact us.";
export const CUSTOM_FEE_PLAN_PICK_REFUSED_SENTENCE =
  "Your account has its own price, so plan changes go through us. Contact us to change your plan.";
export const PLAN_PICK_ASK_FOR_LINK_SENTENCE = "To pay for a new plan, ask us for a payment link.";
/**
 * SA-1325 Q1 (SA-C): a `{ planKey }` pick while card-first is OFF is a 403 with this `reason` (not a code); the clients
 * map it by the reason. Goes when the owner turns card-first on.
 */
export const PLAN_PICK_OFF_REASON = "plan_pick_off";
export const PLAN_PICK_OFF_SENTENCE =
  "Choosing a different plan here isn't available yet. Contact us to change your plan.";
/**
 * The pick surface's own sentence for `CHECKOUT_PAYMENT_IN_PROGRESS`. NOT in the global toast copy: the platform-admin price
 * override raises the same code, so only the plan-pick mappers (`planPickCopy`) use it.
 */
export const CHECKOUT_PAYMENT_IN_PROGRESS_SENTENCE =
  "A payment for your plan is still going through. Try again in a few minutes.";
