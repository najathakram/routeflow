import { render, screen } from "@testing-library/react";
import {
  STOCK_FILTER_CHIPS,
  ProductStatusBadge,
  stockCountLabel,
  getProductStatus,
  getDetailStockStatus,
  initialStockFilter,
  stockFilterParams,
} from "./product-status";

describe("getProductStatus — inactive is its own status, not 'Out of Stock' (WS7)", () => {
  it.each([
    [{ isActive: false, currentStock: 40 }, "INACTIVE"],
    [{ isActive: false, currentStock: 0 }, "INACTIVE"],
    [{ isActive: true, currentStock: 0 }, "OUT_OF_STOCK"],
    [{ isActive: true, currentStock: -3 }, "OUT_OF_STOCK"],
    [{ isActive: true, currentStock: 5 }, "LOW"],
    [{ isActive: true, currentStock: 6 }, "IN_STOCK"],
  ])("%j -> %s", (p, status) => {
    expect(getProductStatus(p)).toBe(status);
  });
});

describe("stockFilterParams — the Inactive chip asks the server for isActive=false", () => {
  it("INACTIVE -> { isActive: false } with no stockStatus (the server's stock filters force active)", () => {
    expect(stockFilterParams("INACTIVE")).toEqual({ isActive: false });
  });
  it("Out of Stock also pins isActive=true: the server's filter is isActive=false OR stock<=0, so without it inactive products leak in under the Inactive badge", () => {
    expect(stockFilterParams("OUT_OF_STOCK").isActive).toBe(true);
  });
  it("a stock chip -> { stockStatus }, and All -> {}", () => {
    expect(stockFilterParams("LOW")).toEqual({ stockStatus: "LOW" });
    expect(stockFilterParams("OUT_OF_STOCK")).toEqual({
      stockStatus: "OUT_OF_STOCK",
      isActive: true,
    });
    expect(stockFilterParams("")).toEqual({});
  });
  it("every chip has a distinct value and All is first", () => {
    expect(STOCK_FILTER_CHIPS.map((c) => c.value)).toEqual([
      "",
      "IN_STOCK",
      "LOW",
      "OUT_OF_STOCK",
      "INACTIVE",
    ]);
  });
});

describe("ProductStatusBadge", () => {
  it.each([
    ["INACTIVE", "Inactive"],
    ["LOW", "Low Stock"],
    ["IN_STOCK", "In Stock"],
  ] as const)("%s renders %s", (status, label) => {
    render(<ProductStatusBadge status={status} currentStock={3} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // Row 330b (owner ruling): an empty product shows the real count in amber, never "Out of Stock" in red.
  it("OUT_OF_STOCK renders the real count in the warning tone, not the danger one", () => {
    render(<ProductStatusBadge status="OUT_OF_STOCK" currentStock={0} />);
    const badge = screen.getByText("0 in stock").closest("span")!;
    expect(badge.className).toContain("bg-warning-bg");
    expect(badge.className).not.toContain("danger");
    expect(screen.queryByText(/out of stock/i)).toBeNull();
  });

  // UX CHANGE (330b follow-up): a negative count never shows as "-2 in stock": it clamps to 0 and says how many
  // were sold past it, in the same amber (the product stays sellable).
  it("clamps a negative count: -2 reads '0 in stock · 2 oversold'", () => {
    render(<ProductStatusBadge status="OUT_OF_STOCK" currentStock={-2} />);
    const badge = screen.getByText("0 in stock · 2 oversold").closest("span")!;
    expect(badge.className).toContain("bg-warning-bg");
    expect(screen.queryByText(/-\d/)).toBeNull();
  });

  it("one formatter feeds every badge: zero, positive and negative", () => {
    expect(stockCountLabel(0)).toBe("0 in stock");
    expect(stockCountLabel(4)).toBe("4 in stock");
    expect(stockCountLabel(-2)).toBe("0 in stock · 2 oversold");
    expect(stockCountLabel(null)).toBe("0 in stock");
  });
});

describe("SA-1002 (W-925): the badge reads the one rule's threshold (reorder point, else 5)", () => {
  it.each([
    [{ isActive: true, currentStock: 15, reorderPoint: 20 }, "LOW"],
    [{ isActive: true, currentStock: 20, reorderPoint: 20 }, "LOW"],
    [{ isActive: true, currentStock: 21, reorderPoint: 20 }, "IN_STOCK"],
    [{ isActive: true, currentStock: 3, reorderPoint: null }, "LOW"],
    [{ isActive: true, currentStock: 3, reorderPoint: 2 }, "IN_STOCK"],
    [{ isActive: true, currentStock: 0, reorderPoint: 20 }, "OUT_OF_STOCK"],
  ])("list %j -> %s", (p, status) => {
    expect(getProductStatus(p)).toBe(status);
  });
  it.each([
    [[15, true, undefined, 20], "LOW"],
    [[3, true, undefined, 2], "IN_STOCK"],
    [[3, true, undefined, null], "LOW"],
    [[15, true, "FAMILY", 20], "IN_STOCK"],
    [[0, true, undefined, 20], "OUT_OF_STOCK"],
    [[15, false, undefined, 20], "OUT_OF_STOCK"],
  ] as const)("detail %j -> %s", (a, status) => {
    expect(getDetailStockStatus(a[0], a[1], a[2], a[3])).toBe(status);
  });
  it("?lowStock=true opens the Low Stock chip; anything else leaves All", () => {
    expect(initialStockFilter("true")).toBe("LOW");
    expect(initialStockFilter("false")).toBe("");
    expect(initialStockFilter(null)).toBe("");
  });
});
