import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ProductHeaderLine } from "./ProductHeaderLine";

const base = { sku: "SKU-1", category: "Snacks", parent: null, kind: "SIMPLE" };

describe("ProductHeaderLine (P-04)", () => {
  it("appends the on-hand count to the SKU and category", () => {
    const { container } = render(<ProductHeaderLine product={base} currentStock={417} />);
    expect(container.querySelector("p")?.textContent).toBe("SKU-1 · Snacks · 417 in stock");
    expect(screen.getByText("417 in stock").className).toMatch(/font-medium/);
    expect(screen.getByText("417 in stock").className).toMatch(/tabular-nums/);
  });

  it("an empty product reads 0 in stock; a negative one says oversold", () => {
    const a = render(<ProductHeaderLine product={base} currentStock={0} />);
    expect(a.container.textContent).toContain("0 in stock");
    a.unmount();
    const b = render(<ProductHeaderLine product={base} currentStock={-2} />);
    expect(b.container.textContent).toContain("0 in stock · 2 oversold");
  });

  it("a variant keeps its Variant of line", () => {
    const { container } = render(
      <ProductHeaderLine product={{ ...base, parent: { name: "Cola" } }} currentStock={5} />,
    );
    expect(container.textContent).toBe("SKU-1 · Variant of Cola · 5 in stock");
  });

  it("a family is not stocked: no count", () => {
    const { container } = render(
      <ProductHeaderLine product={{ ...base, kind: "FAMILY" }} currentStock={0} />,
    );
    expect(container.textContent).toBe("SKU-1 · Snacks");
  });
});
