import { API_ERROR_CODES } from "@routeflow/types";
import { planPickCopy } from "../lib/plan-pick-copy";

/** SA-1547 PR-5a (SA-C): a plan pick's refusals are fixed sentences by code; the server's message is never shown. */
const err = (code: string) => ({
  response: { status: 409, data: { code, message: "raw server text" } },
});

describe("planPickCopy", () => {
  it.each([
    [API_ERROR_CODES.PLAN_PICK_ASK_FOR_LINK, "To pay for a new plan, ask us for a payment link."],
    [
      API_ERROR_CODES.CHECKOUT_PAYMENT_IN_PROGRESS,
      "A payment for your plan is still going through. Try again in a few minutes.",
    ],
  ])("%s maps to its sentence, never the server text", (code, sentence) => {
    expect(planPickCopy(err(code))).toBe(sentence);
    expect(planPickCopy(err(code))).not.toContain("raw server text");
  });

  it("returns null for any other code or shape", () => {
    expect(planPickCopy(err("SOMETHING_ELSE"))).toBeNull();
    expect(planPickCopy(err("toString"))).toBeNull();
    expect(planPickCopy(null)).toBeNull();
    expect(planPickCopy(new Error("x"))).toBeNull();
  });
});
