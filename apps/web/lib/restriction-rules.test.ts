import { dayEndToIso, dayToIso } from "./restriction-rule-form";
import {
  emptyText,
  jurisdictionText,
  ruleTarget,
  stateName,
  surfaceText,
  windowText,
} from "./restriction-rules";

describe("restriction-rules display helpers", () => {
  it("names the target: a product wins, else the category, never an id", () => {
    expect(ruleTarget({ categoryName: "Hemp", productName: null })).toEqual({
      name: "Hemp",
      kind: "Category",
    });
    expect(ruleTarget({ categoryName: null, productName: "Gummies 10ct" })).toEqual({
      name: "Gummies 10ct",
      kind: "Product",
    });
    expect(ruleTarget({ categoryName: null, productName: null }).name).toBe("Unknown item");
  });

  it("words the jurisdiction in plain language", () => {
    expect(jurisdictionText({ jurisdiction: "FEDERAL", states: [] })).toMatch(/federal/);
    expect(jurisdictionText({ jurisdiction: "STATE", states: ["TX"] })).toBe("Banned in");
    // A STATE rule with no states blocks everywhere (fail closed) — say so, don't hide it.
    expect(jurisdictionText({ jurisdiction: "STATE", states: [] })).toMatch(/everywhere/);
  });

  it("states resolve to names, unknown codes fall back to the code", () => {
    expect(stateName("TX")).toBe("Texas");
    expect(stateName("ZZ")).toBe("ZZ");
  });

  it("the channel and the window read plainly", () => {
    expect(surfaceText("ALL")).toBe("All sales");
    expect(surfaceText("BUYER_PORTAL")).toMatch(/Buyer portal only/);
    expect(windowText({ effectiveFrom: "2026-03-05T12:00:00Z", effectiveTo: null })).toMatch(
      /^From .*2026, no end date$/,
    );
    expect(
      windowText({ effectiveFrom: "2026-03-05T12:00:00Z", effectiveTo: "2026-06-05T12:00:00Z" }),
    ).toMatch(/2026 – .*2026$/);
  });

  it("an unparseable end degrades to a dash instead of crashing the render", () => {
    expect(() =>
      windowText({ effectiveFrom: "2026-03-05T12:00:00Z", effectiveTo: "not-a-date" }),
    ).not.toThrow();
    expect(
      windowText({ effectiveFrom: "2026-03-05T12:00:00Z", effectiveTo: "not-a-date" }),
    ).toMatch(/– —$/);
  });

  it("an end the admin set to Dec 31 reads Dec 31, not Jan 1 (the stored end is exclusive)", () => {
    const stored = dayEndToIso("2026-12-31"); // what the form sends: the start of Jan 1
    expect(windowText({ effectiveFrom: dayToIso("2026-12-01"), effectiveTo: stored })).toBe(
      "Dec 1, 2026 – Dec 31, 2026",
    );
    // An API rule ending mid-afternoon still shows the day it is last in force.
    const mid = new Date(2026, 11, 31, 15).toISOString();
    expect(windowText({ effectiveFrom: dayToIso("2026-12-01"), effectiveTo: mid })).toBe(
      "Dec 1, 2026 – Dec 31, 2026",
    );
  });

  it("empty copy differs for the unfiltered list and a filtered one", () => {
    expect(emptyText("ALL").title).toBe("No selling restrictions yet");
    expect(emptyText("LIFTED").title).toBe("No lifted rules");
  });
});
