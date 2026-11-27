import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_SET_REASON,
  PAYMENT_OVERDUE_REASON,
  STRIPE_CANCELLED_REASON,
  SUBSCRIPTION_CANCELLED_REASON,
} from "./dunning-config";
import { CARD_BILLING_STATE_VALUES, cardBillingState } from "./card-billing-state";

/** SA-1545 C2.1: the stored three-state. GUARD rows (a new file); the writer walk of SA-1541 B2 is the `live` table. */
const NOW = new Date("2026-11-26T12:00:00.000Z");
const t = (o: Record<string, unknown> = {}) => ({
  status: "ACTIVE",
  deletedAt: null,
  readOnlyReason: null,
  ...o,
});
const s = (o: Record<string, unknown> = {}) => ({
  stripeSubId: null,
  stripeCustomerId: null,
  catchupState: null,
  cancelAtPeriodEnd: false,
  ...o,
});

describe("cardBillingState", () => {
  const SUB = { stripeSubId: "sub_acme" };
  const rows: Array<[string, any, any, string]> = [
    ["no subscription row", t(), null, "none"],
    ["nothing stored at all", t(), s(), "none"],
    ["an empty-string customer is nothing", t(), s({ stripeCustomerId: "" }), "none"],
    [
      "a customer only (a checkout may be open): uncertain",
      t(),
      s({ stripeCustomerId: "cus_acme" }),
      "uncertain",
    ],
    ["a catch-up claim only: uncertain", t(), s({ catchupState: "SESSION_OPEN" }), "uncertain"],
    ["live: ACTIVE with a card", t(), s(SUB), "live"],
    [
      "R-262 shape is not live: dunning-paused then deleted",
      t({ status: "READ_ONLY", readOnlyReason: SUBSCRIPTION_CANCELLED_REASON }),
      s(SUB),
      "uncertain",
    ],
    [
      "READ_ONLY stripe_cancelled is not live",
      t({ status: "READ_ONLY", readOnlyReason: STRIPE_CANCELLED_REASON }),
      s(SUB),
      "uncertain",
    ],
    [
      "READ_ONLY payment_overdue is still live (Stripe may bill)",
      t({ status: "READ_ONLY", readOnlyReason: PAYMENT_OVERDUE_REASON }),
      s(SUB),
      "live",
    ],
    [
      "READ_ONLY admin_set is still live",
      t({ status: "READ_ONLY", readOnlyReason: ADMIN_SET_REASON }),
      s(SUB),
      "live",
    ],
    ["TRIAL with a link is live (safe direction)", t({ status: "TRIAL" }), s(SUB), "live"],
    ["cancelAtPeriodEnd true: uncertain", t(), s({ ...SUB, cancelAtPeriodEnd: true }), "uncertain"],
    ["CANCELLED: uncertain", t({ status: "CANCELLED" }), s(SUB), "uncertain"],
    ["deleted: uncertain", t({ deletedAt: NOW }), s(SUB), "uncertain"],
    [
      "a cancelled reason left on an ACTIVE row never weakens it",
      t({ readOnlyReason: SUBSCRIPTION_CANCELLED_REASON }),
      s(SUB),
      "live",
    ],
  ];
  it.each(rows)("%s -> %s", (_n, tenant, sub, expected) => {
    expect(cardBillingState(tenant, sub)).toBe(expected);
  });

  it("only the three known states exist", () => {
    expect([...CARD_BILLING_STATE_VALUES]).toEqual(["none", "live", "uncertain"]);
  });

  it("source pin: pure (no import of a client, no Stripe, no prisma)", () => {
    const src = readFileSync(join(__dirname, "card-billing-state.ts"), "utf8");
    expect(src).not.toMatch(/prisma|stripe\.|StripeService|await /i);
  });
});
