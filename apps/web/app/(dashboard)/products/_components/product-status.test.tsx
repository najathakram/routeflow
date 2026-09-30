import { render, screen } from "@testing-library/react";
import {
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
  it("a stock chip -> { stockStatus }, and All -> {}", () => {
    expect(stockFilterParams("LOW")).toEqual({ stockStatus: "LOW" });
    expect(stockFilterParams("OUT_OF_STOCK")).toEqual({ stockStatus: "OUT_OF_STOCK" });
    expect(stockFilterParams("")).toEqual({});
  });
});

describe("ProductStatusBadge", () => {
  it.each([
    ["INACTIVE", "Inactive"],
    ["OUT_OF_STOCK", "Out of Stock"],
    ["LOW", "Low Stock"],
    ["IN_STOCK", "In Stock"],
  ] as const)("%s renders %s", (status, label) => {
    render(<ProductStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
