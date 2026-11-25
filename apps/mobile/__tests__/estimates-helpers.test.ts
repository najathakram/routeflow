/**
 * P10-PAR-1 pure-logic guards for the mobile estimates parity screen. Locks the
 * status→pill mapping, the action gating (esp. the ACCEPTED-only Convert that
 * mirrors the server contract), and the money-safe line amount (never
 * qty*unitPrice on a boxed line).
 */
import { estimateActionFlags, estimateLineAmount, estimatePillFor } from "../lib/estimates-logic";
import { ESTIMATE_STATUS_VALUES } from "@routeflow/types/api/enums";
import {
  canMoveEstimate,
  estimateClosedLine,
  estimateRevisionTag,
} from "@routeflow/types/api/estimate-moves";
import { computeLineSubtotal } from "@routeflow/pricing";
import type { EstimateStatus } from "../lib/api/estimates";

describe("estimatePillFor", () => {
  const cases: [EstimateStatus, string, string][] = [
    ["DRAFT", "gray", "Draft"],
    ["SENT", "brand", "Sent"],
    ["ACCEPTED", "green", "Accepted"],
    ["DECLINED", "red", "Declined"],
    ["VOID", "gray", "Void"],
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
      canRevert: false,
    });
  });

  it("SENT → accept/decline (+void)", () => {
    expect(estimateActionFlags("SENT")).toEqual({
      canSend: false,
      canAcceptDecline: true,
      canConvert: false,
      canVoid: true,
      canRevert: true,
    });
  });

  it("ACCEPTED → convert (+void), never send/accept", () => {
    expect(estimateActionFlags("ACCEPTED")).toEqual({
      canSend: false,
      canAcceptDecline: false,
      canConvert: true,
      canVoid: true,
      canRevert: true,
    });
  });

  it("CONVERTED → no actions (terminal, cannot void)", () => {
    expect(estimateActionFlags("CONVERTED")).toEqual({
      canSend: false,
      canAcceptDecline: false,
      canConvert: false,
      canVoid: false,
      canRevert: false,
    });
  });

  it("VOID → no actions, cannot void again", () => {
    expect(estimateActionFlags("VOID")).toEqual({
      canSend: false,
      canAcceptDecline: false,
      canConvert: false,
      canVoid: false,
      canRevert: false,
    });
  });

  it("DECLINED → no actions, cannot void", () => {
    expect(estimateActionFlags("DECLINED")).toEqual({
      canSend: false,
      canAcceptDecline: false,
      canConvert: false,
      canVoid: false,
      canRevert: false,
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

// SA-1263 A1 (W-1335): the screen flags read the one table the API claims with.
describe("estimate flags read ESTIMATE_MOVES", () => {
  it("U2 a VOID estimate offers no Void, Send, Accept, Convert or Back to draft", () => {
    expect(estimateActionFlags("VOID")).toEqual({
      canSend: false,
      canAcceptDecline: false,
      canConvert: false,
      canVoid: false,
      canRevert: false,
    });
  });

  it("no flag is ever on for a status the API refuses", () => {
    for (const st of ESTIMATE_STATUS_VALUES) {
      const f = estimateActionFlags(st);
      expect({ st, ...f }).toEqual({
        st,
        canSend: f.canSend && canMoveEstimate(st, "send"),
        canAcceptDecline:
          f.canAcceptDecline && canMoveEstimate(st, "accept") && canMoveEstimate(st, "decline"),
        canConvert: canMoveEstimate(st, "convert"),
        canVoid: canMoveEstimate(st, "void"),
        canRevert: canMoveEstimate(st, "revert"),
      });
    }
  });
});

describe("estimate revision tag and closed line", () => {
  it("U4 Rev is hidden at revision 1 and on a DRAFT, and shown from 2 on a sent quote", () => {
    expect(estimateRevisionTag("SENT", 1)).toBeNull();
    expect(estimateRevisionTag("SENT", undefined)).toBeNull();
    expect(estimateRevisionTag("DRAFT", 2)).toBeNull();
    expect(estimateRevisionTag("SENT", 2)).toBe("Rev 2");
    expect(estimateRevisionTag("ACCEPTED", 3)).toBe("Rev 3");
  });

  it("U3 the closed lines are fixed and never name the customer", () => {
    expect(estimateClosedLine("DECLINED")).toBe("Declined. This estimate is closed.");
    expect(estimateClosedLine("VOID")).toBe("Voided. This estimate is closed.");
    expect(estimateClosedLine("SENT")).toBeNull();
    for (const st of ["DECLINED", "VOID"]) {
      expect(estimateClosedLine(st)?.toLowerCase()).not.toContain("customer");
    }
  });
});
