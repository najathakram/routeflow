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

  it("empty copy differs for the unfiltered list and a filtered one", () => {
    expect(emptyText("ALL").title).toBe("No selling restrictions yet");
    expect(emptyText("LIFTED").title).toBe("No lifted rules");
  });
});
