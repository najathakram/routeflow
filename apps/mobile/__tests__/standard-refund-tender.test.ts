import { readFileSync } from "fs";
import { join } from "path";
import {
  STANDARD_REFUND_TENDERS,
  refundTenderChoiceActions,
  resolveReturnRequest,
} from "../lib/standard-refund";

// SA-740r2 item 4 (mobile mirrors web): the STANDARD return's recorded refund takes an OPTIONAL tender. Store credit never
// sends one (the server 400s a tender with CREDIT_NOTE); a refund the clerk did not give a method for sends none either (the
// day's tenderKnown stays false).

describe("resolveReturnRequest", () => {
  it("store credit sends no tender, whatever was passed", () => {
    expect(resolveReturnRequest("r1", "CREDIT_NOTE")).toEqual({ id: "r1", method: "CREDIT_NOTE" });
    expect(resolveReturnRequest("r1", "CREDIT_NOTE", "CASH")).toEqual({
      id: "r1",
      method: "CREDIT_NOTE",
    });
  });
  it("a recorded refund carries the chosen tender", () => {
    expect(resolveReturnRequest("r1", "EXTERNAL_REFUND", "CARD")).toEqual({
      id: "r1",
      method: "EXTERNAL_REFUND",
      tender: "CARD",
    });
  });
  it("a recorded refund with no tender chosen sends none", () => {
    expect(resolveReturnRequest("r1", "EXTERNAL_REFUND")).toEqual({
      id: "r1",
      method: "EXTERNAL_REFUND",
    });
  });
});

describe("the tender choice", () => {
  it("offers Cash, Card and Check (the counter vocabulary), then 'Not recorded', then Cancel", () => {
    expect(STANDARD_REFUND_TENDERS).toEqual([
      { value: "CASH", label: "Cash" },
      { value: "CARD", label: "Card" },
      { value: "CHECK", label: "Check" },
    ]);
    const picked: Array<string | undefined> = [];
    const actions = refundTenderChoiceActions((t) => picked.push(t));
    expect(actions.map((a) => a.label)).toEqual([
      "Cash",
      "Card",
      "Check",
      "Not recorded",
      "Cancel",
    ]);
    actions[1].onPress?.();
    actions[3].onPress?.();
    expect(picked).toEqual(["CARD", undefined]);
    expect(actions[4].style).toBe("cancel");
    expect(actions[4].onPress).toBeUndefined();
  });
});

describe("the return detail screen", () => {
  const src = readFileSync(join(__dirname, "../app/(operator)/returns/[id].tsx"), "utf8");
  it("asks for the tender only on the refund path and builds the request through resolveReturnRequest", () => {
    expect(src).toContain("resolveReturnRequest(");
    expect(src).toContain("refundTenderChoiceActions(");
    expect(src).not.toMatch(/outside RouteFlow|outside app/i);
  });
});
