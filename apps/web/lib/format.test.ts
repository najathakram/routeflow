// Pin the local timezone so formatDate's local-timezone rendering is deterministic
// regardless of the machine running the suite (formatDate is documented as
// rendering in the VIEWER'S LOCAL timezone, not UTC).
process.env.TZ = "UTC";

import { formatMoney, formatQty, formatDate, humanizeEnum } from "./format";

describe("formatMoney", () => {
  it("formats a normal value", () => {
    expect(formatMoney(1234.5)).toBe("$1,234.50");
  });

  it("formats zero", () => {
    expect(formatMoney(0)).toBe("$0.00");
  });

  it("formats a negative value with a leading minus sign", () => {
    expect(formatMoney(-50)).toBe("-$50.00");
  });

  it("treats null as zero", () => {
    expect(formatMoney(null)).toBe("$0.00");
  });

  it("treats undefined as zero", () => {
    expect(formatMoney(undefined)).toBe("$0.00");
  });
});

describe("formatQty", () => {
  it("keeps up to 2dp for a fractional value", () => {
    expect(formatQty(1234.5)).toBe("1234.5");
  });

  it("renders zero bare", () => {
    expect(formatQty(0)).toBe("0");
  });

  it("renders a whole negative number bare", () => {
    expect(formatQty(-7)).toBe("-7");
  });

  it("treats null as zero", () => {
    expect(formatQty(null)).toBe("0");
  });

  it("treats undefined as zero", () => {
    expect(formatQty(undefined)).toBe("0");
  });
});

describe("formatDate", () => {
  it("formats a normal timestamp as 'Mon D, YYYY' in the local timezone", () => {
    // Noon UTC keeps the calendar day stable once TZ is pinned to UTC above.
    expect(formatDate("2026-06-15T12:00:00.000Z")).toBe("Jun 15, 2026");
  });

  it("returns an em dash for an unparsable string", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("returns an em dash for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("returns an em dash for undefined", () => {
    expect(formatDate(undefined)).toBe("—");
  });
});

describe("humanizeEnum", () => {
  it("title-cases a snake-cased enum value", () => {
    expect(humanizeEnum("PARTIALLY_DELIVERED")).toBe("Partially Delivered");
  });

  it("title-cases a single-word value", () => {
    expect(humanizeEnum("PENDING")).toBe("Pending");
  });

  it("returns an empty string for an empty string", () => {
    expect(humanizeEnum("")).toBe("");
  });

  it("returns an empty string for null", () => {
    expect(humanizeEnum(null)).toBe("");
  });

  it("returns an empty string for undefined", () => {
    expect(humanizeEnum(undefined)).toBe("");
  });
});
