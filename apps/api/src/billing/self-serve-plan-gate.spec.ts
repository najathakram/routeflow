import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  isNeverActivated,
  planGateRefusal,
  selfServePlanGate,
  type PlanGateOp,
} from "./self-serve-plan-gate";

type T = Parameters<typeof selfServePlanGate>[0];
type S = Parameters<typeof selfServePlanGate>[1];

const active: T = { status: "ACTIVE", readOnlyReason: null };
const trial: T = { status: "TRIAL", readOnlyReason: null };
const trialLocked: T = { status: "READ_ONLY", readOnlyReason: "trial_expired" };
const cardSub: S = { stripeSubId: "sub_acme", externalPayment: false };
const noCardSub: S = { stripeSubId: null, externalPayment: false };
const manualSub: S = { stripeSubId: null, externalPayment: true };

const refuse = (code: string) => ({ kind: "REFUSE", code });

describe("selfServePlanGate (SA-774 r6: card first, then active)", () => {
  describe("a card payer (ACTIVE, card subscription, not manual, not link-pending)", () => {
    it("keeps the instant prorated upgrade and downgrade", () => {
      expect(selfServePlanGate(active, cardSub, false, "upgrade")).toEqual({ kind: "PROCEED" });
      expect(selfServePlanGate(active, cardSub, false, "downgrade")).toEqual({ kind: "PROCEED" });
    });
    it("is told to use Change plan when it calls subscribe", () => {
      expect(selfServePlanGate(active, cardSub, false, "subscribe")).toEqual(
        refuse(API_ERROR_CODES.USE_PLAN_CHANGE),
      );
    });
  });

  describe("a business with no card subscription (trial or locked trial)", () => {
    it.each<[string, T]>([
      ["a trial", trial],
      ["a locked trial", trialLocked],
    ])("%s is sent to Checkout for subscribe and upgrade", (_n, tenant) => {
      expect(selfServePlanGate(tenant, noCardSub, false, "subscribe")).toEqual({
        kind: "CHECKOUT",
      });
      expect(selfServePlanGate(tenant, noCardSub, false, "upgrade")).toEqual({ kind: "CHECKOUT" });
    });
    it("is never given a scheduled downgrade; it chooses the plan at checkout", () => {
      expect(selfServePlanGate(trial, noCardSub, false, "downgrade")).toEqual(
        refuse(API_ERROR_CODES.CHOOSE_PLAN_AT_CHECKOUT),
      );
    });
    it("a stale Stripe id on a TRIAL tenant (extendTrial) is still card-less", () => {
      expect(
        selfServePlanGate(
          trial,
          { stripeSubId: "sub_old", externalPayment: false },
          false,
          "upgrade",
        ),
      ).toEqual({ kind: "CHECKOUT" });
    });
  });

  describe("R13 / R14 (SA-1547): subscribe never activates a business that has no card", () => {
    it.each<[string, T]>([
      ["a TRIAL with days left", trial],
      ["a READ_ONLY trial_expired business", trialLocked],
      [
        "a READ_ONLY trial_cancelled business",
        { status: "READ_ONLY", readOnlyReason: "trial_cancelled" },
      ],
    ])("%s: subscribe is CHECKOUT, never PROCEED", (_n, tenant) => {
      expect(selfServePlanGate(tenant, noCardSub, false, "subscribe")).toEqual({
        kind: "CHECKOUT",
      });
    });
  });

  describe("an ACTIVE business with no card and no manual pay: ask us for a link", () => {
    it.each<PlanGateOp>(["subscribe", "upgrade", "downgrade"])(
      "%s is a 409 PLAN_PICK_ASK_FOR_LINK",
      (op) => {
        expect(selfServePlanGate(active, noCardSub, false, op)).toEqual(
          refuse(API_ERROR_CODES.PLAN_PICK_ASK_FOR_LINK),
        );
      },
    );
    it("the refusal says what to do", () => {
      expect(planGateRefusal(API_ERROR_CODES.PLAN_PICK_ASK_FOR_LINK).getResponse()).toEqual({
        code: API_ERROR_CODES.PLAN_PICK_ASK_FOR_LINK,
        message: "Ask us for a payment link.",
      });
    });
  });

  describe("manual (external) payment", () => {
    it.each<PlanGateOp>(["subscribe", "upgrade"])(
      "%s is a 409 EXTERNAL_PAYMENT_USE_CATCHUP",
      (op) => {
        expect(selfServePlanGate(active, manualSub, false, op)).toEqual(
          refuse(API_ERROR_CODES.EXTERNAL_PAYMENT_USE_CATCHUP),
        );
      },
    );
    it("an ACTIVE manual-pay downgrade still proceeds", () => {
      expect(selfServePlanGate(active, manualSub, false, "downgrade")).toEqual({
        kind: "PROCEED",
      });
    });
    it("a non-ACTIVE manual-pay downgrade is refused", () => {
      expect(selfServePlanGate(trialLocked, manualSub, false, "downgrade")).toEqual(
        refuse(API_ERROR_CODES.EXTERNAL_PAYMENT_USE_CATCHUP),
      );
    });
  });

  describe("link-pending (a Stripe subscription linked, payment not yet activated)", () => {
    it.each<PlanGateOp>(["subscribe", "upgrade", "downgrade"])(
      "%s is refused first with CHECKOUT_PAYMENT_PROCESSING, before every other rule",
      (op) => {
        for (const [t, s] of [
          [trial, cardSub],
          [active, cardSub],
          [active, manualSub],
          [trial, noCardSub],
        ] as [T, S][]) {
          expect(selfServePlanGate(t, s, true, op)).toEqual(
            refuse(API_ERROR_CODES.CHECKOUT_PAYMENT_PROCESSING),
          );
        }
      },
    );
  });
});

describe("isNeverActivated", () => {
  it("is true for TRIAL and for a locked trial", () => {
    expect(isNeverActivated(trial, false)).toBe(true);
    expect(isNeverActivated(trialLocked, false)).toBe(true);
  });
  it("is false for ACTIVE, SUSPENDED and a non-trial READ_ONLY lock", () => {
    expect(isNeverActivated(active, false)).toBe(false);
    expect(isNeverActivated({ status: "SUSPENDED", readOnlyReason: null }, false)).toBe(false);
    expect(isNeverActivated({ status: "READ_ONLY", readOnlyReason: "payment_failed" }, false)).toBe(
      false,
    );
  });
  it("is true for a link-pending tenant that is not ACTIVE, false for one that is", () => {
    expect(isNeverActivated({ status: "SUSPENDED", readOnlyReason: null }, true)).toBe(true);
    expect(isNeverActivated(active, true)).toBe(false);
  });
});
