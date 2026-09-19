import { PURCHASE_ORDER_STATUS_VALUES } from "@routeflow/types";
import {
  PO_FILTERS,
  formatPoMoney,
  poDisplayTotal,
  poFilterFromLabel,
  poListStatusParam,
  poStatusPill,
} from "../lib/po-list-logic";

describe("poDisplayTotal — the PO list row total", () => {
  it("REG: a server total arrives as a Decimal STRING and must not render as $0.00", () => {
    // Prisma Decimal(10,2) serializes as "123.45". The list used Number.isFinite(<string>),
    // which is false, so every PO with a stored total showed $0.00.
    expect(formatPoMoney(poDisplayTotal({ totalAmount: "123.45", items: [] }))).toBe("$123.45");
  });

  it("uses a numeric stored total as-is", () => {
    expect(poDisplayTotal({ totalAmount: 88.5, items: [] })).toBe(88.5);
  });

  it("prefers the stored total over the lines (the agreed money wins)", () => {
    expect(
      poDisplayTotal({
        totalAmount: "100.00",
        items: [{ qtyOrdered: 3, unitCost: 5 }],
      }),
    ).toBe(100);
  });

  it("falls back to the rounded sum of lines when there is no stored total", () => {
    expect(
      poDisplayTotal({
        items: [
          { qtyOrdered: "3.000", unitCost: "1.1000" },
          { qtyOrdered: 2, unitCost: "0.3333" },
        ],
      }),
    ).toBe(3.97); // 3.3 + 0.6666 = 3.9666 -> rounded to cents
  });

  it("a stored 0 or null falls back to the lines, like the detail screen", () => {
    const items = [{ qtyOrdered: 2, unitCost: 4 }];
    expect(poDisplayTotal({ totalAmount: 0, items })).toBe(8);
    expect(poDisplayTotal({ totalAmount: "0.00", items })).toBe(8);
    expect(poDisplayTotal({ totalAmount: null, items })).toBe(8);
  });

  it("never returns NaN for garbage input", () => {
    expect(poDisplayTotal({ totalAmount: "abc", items: [{ qtyOrdered: "x", unitCost: 1 }] })).toBe(
      0,
    );
    expect(poDisplayTotal({ items: [] })).toBe(0);
  });
});

describe("formatPoMoney", () => {
  it("formats to two decimals with a dollar sign and guards non-finite values", () => {
    expect(formatPoMoney(5)).toBe("$5.00");
    expect(formatPoMoney(1234.5)).toBe("$1234.50");
    expect(formatPoMoney(Number.NaN)).toBe("$0.00");
  });
});

describe("poStatusPill", () => {
  it("has an explicit pill for EVERY server status (a new enum value must not fall to the default)", () => {
    for (const status of PURCHASE_ORDER_STATUS_VALUES) {
      const pill = poStatusPill(status);
      expect(pill.label).not.toBe(status); // the default branch echoes the raw enum value
    }
  });

  it("maps the lifecycle to its badge", () => {
    expect(poStatusPill("DRAFT")).toEqual({ variant: "gray", label: "Draft" });
    expect(poStatusPill("SENT")).toEqual({ variant: "orange", label: "Sent" });
    expect(poStatusPill("PARTIAL")).toEqual({ variant: "brand", label: "Partial" });
    expect(poStatusPill("RECEIVED")).toEqual({ variant: "green", label: "Received" });
    expect(poStatusPill("CLOSED")).toEqual({ variant: "gray", label: "Closed" });
  });
});

describe("filters", () => {
  it("All / Open / Received, in that order", () => {
    expect(PO_FILTERS.map((f) => f.label)).toEqual(["All", "Open", "Received"]);
  });

  it("only the Received chip narrows the all-POs query; Open has its own query", () => {
    expect(poListStatusParam("ALL")).toBeUndefined();
    expect(poListStatusParam("OPEN")).toBeUndefined();
    expect(poListStatusParam("RECEIVED")).toBe("RECEIVED");
  });

  it("maps a chip label back to its id, defaulting to All", () => {
    expect(poFilterFromLabel("Open")).toBe("OPEN");
    expect(poFilterFromLabel("Received")).toBe("RECEIVED");
    expect(poFilterFromLabel("nonsense")).toBe("ALL");
  });
});
