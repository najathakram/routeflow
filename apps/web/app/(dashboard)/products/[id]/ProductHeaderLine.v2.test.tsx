import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ProductHeaderLine } from "./ProductHeaderLine";
import { UNITS_V2_TESTIDS } from "./units-v2-testids";

const base = { sku: "SKU-1", category: "Snacks", parent: null, kind: "SIMPLE" };

describe("ProductHeaderLine with pricesV2 (T36)", () => {
  it("shows a see-Inventory link instead of the stock count", () => {
    const { container } = render(<ProductHeaderLine product={base} currentStock={417} pricesV2 />);
    expect(container.textContent).not.toContain("417");
    expect(container.textContent).not.toContain("in stock");
    const link = screen.getByTestId(UNITS_V2_TESTIDS.headerStockLink);
    expect(link).toHaveAttribute("href", "/inventory");
    expect(screen.getByRole("link", { name: "Stock: see Inventory" })).toBe(link);
    expect(container.textContent).toBe("SKU-1 · Snacks · Stock: see Inventory");
  });

  it("a variant keeps its Variant of line and gets the link", () => {
    const { container } = render(
      <ProductHeaderLine
        product={{ ...base, parent: { name: "Cola" } }}
        currentStock={5}
        pricesV2
      />,
    );
    expect(container.textContent).toBe("SKU-1 · Variant of Cola · Stock: see Inventory");
  });

  it("a family reads that it cannot be sold, with no stock link", () => {
    const { container } = render(
      <ProductHeaderLine product={{ ...base, kind: "FAMILY" }} currentStock={0} pricesV2 />,
    );
    expect(screen.getByTestId(UNITS_V2_TESTIDS.familyHeader).textContent).toBe(
      "Family. Can't be sold. Choose a variant.",
    );
    expect(screen.queryByTestId(UNITS_V2_TESTIDS.headerStockLink)).toBeNull();
    expect(container.textContent).toContain("SKU-1 · Snacks");
  });

  it("with the prop false the count renders as before", () => {
    const { container } = render(
      <ProductHeaderLine product={base} currentStock={417} pricesV2={false} />,
    );
    expect(container.textContent).toBe("SKU-1 · Snacks · 417 in stock");
  });
});

describe("ProductHeaderLine price summary (W-1170 F11)", () => {
  const priced = { ...base, unit: "Case", pricePerUnit: "41.88" };

  it("shows 'Price: $41.88 / Case' as a link that opens Units and prices", () => {
    const { container } = render(<ProductHeaderLine product={priced} currentStock={5} pricesV2 />);
    const link = screen.getByTestId(UNITS_V2_TESTIDS.headerPriceLink);
    expect(link.textContent).toBe("$41.88 / Case");
    expect(link).toHaveAttribute("href", "#h-units");
    expect(container.textContent).toBe(
      "SKU-1 · Snacks · Price: $41.88 / Case · Stock: see Inventory",
    );
  });

  it("the link clicks the strip's own Units and prices link, so its scroll and focus rules apply", () => {
    const strip = jest.fn((e: React.MouseEvent) => e.preventDefault());
    render(
      <>
        <nav>
          <a href="#h-units" data-testid="strip" onClick={strip}>
            Units and prices
          </a>
        </nav>
        <ProductHeaderLine product={priced} currentStock={5} pricesV2 />
      </>,
    );
    screen.getByTestId(UNITS_V2_TESTIDS.headerPriceLink).click();
    expect(strip).toHaveBeenCalledTimes(1);
  });

  it("a family has no price segment, and flag-off renders none", () => {
    const { container, rerender } = render(
      <ProductHeaderLine product={{ ...priced, kind: "FAMILY" }} currentStock={0} pricesV2 />,
    );
    expect(container.textContent).not.toContain("Price:");
    rerender(<ProductHeaderLine product={priced} currentStock={5} pricesV2={false} />);
    expect(container.textContent).not.toContain("Price:");
  });

  it("a product with no usable price shows no price segment", () => {
    const { container } = render(
      <ProductHeaderLine product={{ ...priced, pricePerUnit: null }} currentStock={5} pricesV2 />,
    );
    expect(container.textContent).not.toContain("Price:");
  });
});
