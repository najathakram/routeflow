import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ProductStatusBadge, getProductStatus } from "./_components/product-status";
import { ProductHeaderLine } from "./[id]/ProductHeaderLine";

/**
 * Inventory W0 / S1 - the staff stock badge at 0, negative and fractional stock, asserted on what is
 * RENDERED. Replaces the source-scraping `stock-badge-count.static.test.ts` (L-205: a test that greps
 * source proves a string is absent from a file, not that the screen is right) - that test is listed
 * for removal in a follow-up, not edited here.
 *
 * Row 330b (owner ruling): an empty or oversold product shows the real count in the amber warning
 * tone, never "Out of Stock" and never the danger tone; the product stays sellable. A negative count
 * clamps to 0 and says how many were sold past it (330b follow-up).
 */
const CASES: Array<[number, string]> = [
  [0, "0 in stock"],
  [-2, "0 in stock · 2 oversold"],
  [0.5, "0.5 in stock"],
];

describe("S1: staff stock badge renders the count in amber, never Out of Stock", () => {
  // 0.5 is above zero, so the badge is the existing "Low Stock" (also amber); the count itself is on the
  // header line below.
  const BADGE: Array<[number, string]> = [
    [0, "0 in stock"],
    [-2, "0 in stock · 2 oversold"],
    [0.5, "Low Stock"],
  ];
  it.each(BADGE)("ProductStatusBadge at stock %s says %p", (stock, copy) => {
    const status = getProductStatus({ isActive: true, currentStock: stock });
    render(<ProductStatusBadge status={status} currentStock={stock} />);
    const badge = screen.getByText(copy).closest("span") as HTMLElement;
    expect(badge.className).toContain("bg-warning-bg");
    expect(badge.className).not.toContain("danger");
    expect(screen.queryByText(/out of stock/i)).toBeNull();
  });

  it.each(CASES)("the product header line at stock %s says %p", (stock, copy) => {
    render(
      <ProductHeaderLine product={{ sku: "ACME-1", category: "Acme" }} currentStock={stock} />,
    );
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText(/out of stock/i)).toBeNull();
  });
});
