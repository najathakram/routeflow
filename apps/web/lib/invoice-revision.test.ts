import { overpaidText, revisedBadgeText } from "./invoice-revision";

describe("revisedBadgeText", () => {
  it("formats a revisedAt timestamp as 'Revised {date}'", () => {
    expect(revisedBadgeText("2026-10-05T15:30:00.000Z")).toMatch(/^Revised \w{3} \d{1,2}, 2026$/);
  });
  it.each([undefined, null, "", "not-a-date"])("is null for %p (no badge)", (v) => {
    expect(revisedBadgeText(v as never)).toBeNull();
  });
});

describe("overpaidText", () => {
  it("shows the rounded amount when overpaid", () => {
    expect(overpaidText(12.5)).toBe("Overpaid by $12.50");
    expect(overpaidText(0.1 + 0.2)).toBe("Overpaid by $0.30");
    expect(overpaidText(1234.567)).toBe("Overpaid by $1,234.57");
  });
  it.each([undefined, null, 0, -3, NaN, 0.004])("is null for %p", (v) => {
    expect(overpaidText(v as never)).toBeNull();
  });
});
