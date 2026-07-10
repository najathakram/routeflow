/**
 * P10-PAR-1 pure-logic guards for the mobile estimates parity screen. Locks the
 * status→pill mapping, the action gating (esp. the ACCEPTED-only Convert that
 * mirrors the server contract), and the money-safe line amount (never
 * qty*unitPrice on a boxed line).
 */
import { estimateActionFlags, estimateLineAmount, estimatePillFor } from "../lib/estimates-logic";
import { computeLineSubtotal } from "../lib/pricing";
import type { EstimateStatus } from "../lib/api/estimates";

describe("estimatePillFor", () => {
  const cases: [EstimateStatus, string, string][] = [
    ["DRAFT", "gray", "Draft"],
    ["SENT", "brand", "Sent"],
    ["ACCEPTED", "green", "Accepted"],
    ["DECLINED", "red", "Declined"],
    ["EXPIRED", "orange", "Expired"],
    ["CONVERTED", "purple", "Converted"],
  ];
  it.each(cases)("%s → %s / %s", (status, variant, label) => {
    expect(estimatePillFor(status)).toEqual({ variant, label });
  });
});

describe("estimateActionFlags", () => {
  it("DRAFT → send only (+void)", () => {
    expect(estimateActionFlags("DRAFT")).toEqual({
      canSend: true,
      canAcceptDecline: false,
      canConvert: false,
      canVoid: true,
    });
  });

  it("SENT → accept/decline (+void)", () => {
    expect(estimateActionFlags("SENT")).toEqual({
      canSend: false,
      canAcceptDecline: true,
      canConvert: false,
      canVoid: true,
    });
  });

  it("ACCEPTED → convert (+void), never send/accept", () => {
    expect(estimateActionFlags("ACCEPTED")).toEqual({
      canSend: false,
      canAcceptDecline: false,
      canConvert: true,
      canVoid: true,
    });
  });

  it("CONVERTED → no actions (terminal, cannot void)", () => {
    expect(estimateActionFlags("CONVERTED")).toEqual({
      canSend: false,
      canAcceptDecline: false,
      canConvert: false,
      canVoid: false,
    });
  });

  it.each(["DECLINED", "EXPIRED"] as EstimateStatus[])("%s → no actions, cannot void", (status) => {
    expect(estimateActionFlags(status)).toEqual({
      canSend: false,
      canAcceptDecline: false,
      canConvert: false,
      canVoid: false,
    });
  });
});

describe("estimateLineAmount (money discipline)", () => {
  it("prefers the server-computed subtotal", () => {
    expect(estimateLineAmount({ subtotal: 42.5, unitPrice: 10, qty: 5 })).toBe(42.5);
  });

  it("falls back to computeLineSubtotal for a boxed line with no subtotal — never qty*unitPrice", () => {
    // A boxed line: 220/unit, 2 boxes of 16 = 32 units → 220*2 = 440 (per box),
    // NOT 220*32. estimateLineAmount must match computeLineSubtotal exactly.
    const boxed = { unitPrice: 220, qty: 32, boxes: 2, pieces: 0, unitsPerBox: 16 };
    expect(estimateLineAmount(boxed)).toBe(computeLineSubtotal(boxed));
    expect(estimateLineAmount(boxed)).not.toBe(220 * 32);
  });
});
