import { cueForOutcome } from "./scan-feedback";

describe("cueForOutcome", () => {
  it("maps an added feedback to accepted and an error feedback to rejected", () => {
    expect(cueForOutcome({ feedback: { kind: "added", text: "Added" } })).toBe("accepted");
    expect(cueForOutcome({ feedback: { kind: "error", text: "Nope" } })).toBe("rejected");
  });

  it("cues nothing when nothing observable happened (void, close-only, empty)", () => {
    expect(cueForOutcome(undefined)).toBe("none");
    expect(cueForOutcome({ close: true })).toBe("none");
    expect(cueForOutcome({})).toBe("none");
  });
});
