import { stopCompletionLine } from "./stop-completion-line";

// UX guide B22: the line must agree with the stop's status, which the header counts use.
const AT = "2026-11-12T08:15:00";

describe("stopCompletionLine (UX guide B22)", () => {
  it("a PENDING stop that carries a completedAt does not read Completed", () => {
    expect(stopCompletionLine({ status: "PENDING", completedAt: AT })).toBeNull();
  });

  it("a COMPLETED stop reads Completed with its time", () => {
    expect(stopCompletionLine({ status: "COMPLETED", completedAt: AT })?.text).toMatch(
      /^Completed \d/,
    );
  });

  it("a SKIPPED stop reads Skipped, never Completed", () => {
    expect(stopCompletionLine({ status: "SKIPPED", completedAt: AT })?.text).toMatch(/^Skipped \d/);
  });

  it("no completedAt, no line", () => {
    expect(stopCompletionLine({ status: "COMPLETED", completedAt: null })).toBeNull();
    expect(stopCompletionLine({ status: "PENDING" })).toBeNull();
  });

  it("tone: COMPLETED is success, SKIPPED is muted (the red icon is the only colour signal)", () => {
    expect(stopCompletionLine({ status: "COMPLETED", completedAt: AT })?.tone).toBe("success");
    expect(stopCompletionLine({ status: "SKIPPED", completedAt: AT })?.tone).toBe("muted");
  });
});
