import { render, screen } from "@testing-library/react";
import {
  STOCK_FILTER_CHIPS,
  ProductStatusBadge,
  getProductStatus,
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

  it("shows a negative count as it is", () => {
    render(<ProductStatusBadge status="OUT_OF_STOCK" currentStock={-3} />);
    expect(screen.getByText("-3 in stock")).toBeInTheDocument();
  });
});
