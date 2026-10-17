import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FamilyVariantsGrid } from "./FamilyVariantsGrid";
import { blankRow, MAX_FAMILY_ROWS, type GridRow } from "@/lib/family-grid";

const rows = (n = 2): GridRow[] =>
  Array.from({ length: n }, (_, i) => ({
    ...blankRow(`k${i}`),
    name: `V${i + 1}`,
    pricePerUnit: "1.00",
  }));

function setup(over: Partial<React.ComponentProps<typeof FamilyVariantsGrid>> = {}) {
  const onChange = jest.fn();
  const onCodeBlur = jest.fn();
  const props = { rows: rows(), onChange, onCodeBlur, cellMessages: {}, ...over };
  render(<FamilyVariantsGrid {...props} />);
  return { onChange, onCodeBlur };
}

describe("FamilyVariantsGrid", () => {
  it("one labelled input per cell, in rows", () => {
    setup();
    for (const f of ["name", "SKU", "barcode", "unit code", "pieces per box", "price", "cost"]) {
      expect(screen.getByLabelText(new RegExp(`^Variant 1 ${f}$`, "i"))).toBeInTheDocument();
      expect(screen.getByLabelText(new RegExp(`^Variant 2 ${f}$`, "i"))).toBeInTheDocument();
    }
  });

  it("typing changes ONLY that row's field and reports the new rows", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText("Variant 2 SKU"), { target: { value: "C-2" } });
    const next = onChange.mock.calls[0][0] as GridRow[];
    expect(next[1].sku).toBe("C-2");
    expect(next[0].sku).toBe("");
    expect(next).toHaveLength(2);
  });

  it("blank cost explains itself: the family cost is used", () => {
    setup();
    expect(screen.getByLabelText("Variant 1 cost")).toHaveAttribute("placeholder", "Family cost");
    expect(screen.getByText(/Leave cost blank to use the family cost\./)).toBeInTheDocument();
  });

  it("Add variant appends a blank row; remove drops that row", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    expect((onChange.mock.calls[0][0] as GridRow[]).length).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Remove variant 1" }));
    const next = onChange.mock.calls[1][0] as GridRow[];
    expect(next.map((r) => r.name)).toEqual(["V2"]);
  });

  it("Add variant is disabled at the 200-row cap, with the reason", () => {
    setup({ rows: rows(MAX_FAMILY_ROWS) });
    expect(screen.getByRole("button", { name: "Add variant" })).toBeDisabled();
    expect(screen.getByText("A family takes up to 200 variants at a time.")).toBeInTheDocument();
  });

  it("messages show under their cell, and a holder message links to that product", () => {
    setup({
      cellMessages: {
        "0:sku": { message: 'The SKU "X" is already used by another product.', productId: "h1" },
        "1:pricePerUnit": { message: "Enter a price like 1.50." },
      },
    });
    const sku = screen.getByLabelText("Variant 1 SKU");
    expect(sku).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText('The SKU "X" is already used by another product.')).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View product" })).toHaveAttribute(
      "href",
      "/products/h1",
    );
    expect(screen.getByText("Enter a price like 1.50.")).toBeInTheDocument();
    expect(screen.getByLabelText("Variant 1 name")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("leaving a code cell reports it so the parent can check availability; other cells do not", () => {
    const { onCodeBlur } = setup({
      rows: rows().map((r, i) => (i === 0 ? { ...r, sku: " C-1 " } : r)),
    });
    fireEvent.blur(screen.getByLabelText("Variant 1 SKU"));
    expect(onCodeBlur).toHaveBeenCalledWith(0, "sku", "C-1");
    fireEvent.blur(screen.getByLabelText("Variant 1 name"));
    fireEvent.blur(screen.getByLabelText("Variant 2 SKU")); // empty: nothing to check
    expect(onCodeBlur).toHaveBeenCalledTimes(1);
  });

  it("read-only mode shows values but no add/remove and no inputs", () => {
    setup({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Add variant" })).toBeNull();
    expect(screen.queryByLabelText("Variant 1 name")).toBeNull();
    expect(screen.getAllByText("V1").length).toBeGreaterThan(0);
  });
});

describe("FamilyVariantsGrid price column (V20)", () => {
  it("right-aligns every price cell with tabular numbers, header included", () => {
    setup();
    const priceHeader = screen.getByRole("columnheader", { name: "Price" });
    expect(priceHeader).toHaveClass("text-right");
    const inputs = [
      screen.getByLabelText("Variant 1 price"),
      screen.getByLabelText("Variant 2 price"),
    ];
    for (const input of inputs) {
      expect(input).toHaveClass("text-right", "tabular-nums");
    }
    // Other numeric-looking columns keep their existing alignment.
    expect(screen.getByLabelText("Variant 1 SKU")).not.toHaveClass("text-right");
    expect(screen.getByRole("columnheader", { name: "SKU" })).not.toHaveClass("text-right");
  });

  it("read-only prices share the same right-aligned, tabular cell", () => {
    setup({ readOnly: true });
    const priceCells = screen.getAllByText("1.00");
    expect(priceCells.length).toBe(2);
    for (const cell of priceCells) {
      expect(cell).toHaveClass("block", "text-right", "tabular-nums");
    }
  });
});
