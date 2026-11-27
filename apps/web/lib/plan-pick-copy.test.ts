import { API_ERROR_CODES } from "@routeflow/types";
import { genericToastCopy } from "./generic-toast-copy";
import { planPickCopy } from "./plan-pick-copy";

/** SA-1547 PR-5 (SA-C): the plan-pick surface's fixed sentences by code; the server's message is never shown. */
const RAW = "secret internal detail: row 42 violates fk_x";
const err = (code: string, status = 409) => ({
  message: "Request failed with status code " + status,
  response: { status, data: { code, message: RAW } },
});
const IN_PROGRESS_SENTENCE =
  "A payment for your plan is still going through. Try again in a few minutes.";

describe("planPickCopy", () => {
  it.each([
    [
      API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED,
      "This plan can't be chosen here right now. Reload the page to see the plans you can pick, or contact us.",
    ],
    [
      API_ERROR_CODES.CUSTOM_FEE_PLAN_PICK_REFUSED,
      "Your account has its own price, so plan changes go through us. Contact us to change your plan.",
    ],
    [API_ERROR_CODES.PLAN_PICK_ASK_FOR_LINK, "To pay for a new plan, ask us for a payment link."],
    [API_ERROR_CODES.CHECKOUT_PAYMENT_IN_PROGRESS, IN_PROGRESS_SENTENCE],
  ])("%s maps to its sentence, never the server text", (code, sentence) => {
    expect(planPickCopy(err(code))).toBe(sentence);
    expect(planPickCopy(err(code))).not.toContain(RAW);
  });

  it("returns null for any other code or shape", () => {
    expect(planPickCopy(err("SOMETHING_ELSE"))).toBeNull();
    expect(planPickCopy(err("toString"))).toBeNull();
    expect(planPickCopy(null)).toBeNull();
    expect(planPickCopy(new Error("x"))).toBeNull();
  });
});

describe("genericToastCopy is unchanged for CHECKOUT_PAYMENT_IN_PROGRESS", () => {
  // the platform-admin price override raises this code too, and the backoffice pricing card shows the generic toast
  it("does not show the plan-pick sentence", () => {
    const copy = genericToastCopy(err(API_ERROR_CODES.CHECKOUT_PAYMENT_IN_PROGRESS));
    expect(copy).not.toBe(IN_PROGRESS_SENTENCE);
    expect(copy).not.toContain(RAW);
  });
});
