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
    const priceCells = screen.getAllByText("$1.00");
    expect(priceCells.length).toBe(2);
    for (const cell of priceCells) {
      expect(cell).toHaveClass("block", "text-right", "tabular-nums");
    }
  });
});

describe("FamilyVariantsGrid read-only reads like a product list (K11-24)", () => {
  const saved = (): GridRow[] => [
    {
      ...blankRow("a"),
      id: "v-1",
      name: "Strawberry",
      sku: "AW-STR",
      barcode: "0123",
      unitSku: "AW-STR-U",
      unitsPerBox: "12",
      pricePerUnit: "1.25",
      standardCost: "0.8",
    },
    { ...blankRow("b"), id: "v-2", name: "Vanilla", pricePerUnit: "1800", standardCost: "" },
  ];

  it("prints Price and Cost as money, never the raw text", () => {
    setup({ readOnly: true, rows: saved() });
    expect(screen.getByText("$1.25")).toBeInTheDocument();
    expect(screen.getByText("$1,800.00")).toBeInTheDocument();
    expect(screen.getByText("$0.80")).toBeInTheDocument();
    expect(screen.queryByText("1.25")).toBeNull();
    // a blank cost still means "the family cost", so it stays a dash, not $0.00
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("each saved variant's name goes to its own page", () => {
    setup({ readOnly: true, rows: saved() });
    expect(screen.getByRole("link", { name: "Strawberry" })).toHaveAttribute(
      "href",
      "/products/v-1",
    );
    expect(screen.getByRole("link", { name: "Vanilla" })).toHaveAttribute("href", "/products/v-2");
  });

  it("K12 F18: the name link stretches over its whole row, so any tap on the row opens it", () => {
    setup({ readOnly: true, rows: saved() });
    const link = screen.getByRole("link", { name: "Strawberry" });
    expect(link).toHaveClass("after:absolute", "after:inset-0");
    expect(link.closest("tr")).toHaveClass("relative");
    // the keyboard ring is drawn on the overlay, inside the row
    expect(link).toHaveClass("focus-visible:after:ring-2", "focus-visible:after:ring-inset");
  });

  it("K12 A5: read-only hides the SKU, Barcode and Unit code columns when every row is empty", () => {
    const bare: GridRow[] = [
      { ...blankRow("a"), id: "v-1", name: "Strawberry", pricePerUnit: "1.25" },
      { ...blankRow("b"), id: "v-2", name: "Vanilla", pricePerUnit: "1.5", sku: "AW-VAN" },
    ];
    setup({ readOnly: true, rows: bare });
    expect(screen.getByRole("columnheader", { name: "SKU" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Barcode" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Unit code" })).toBeNull();
    // one cell fewer per row than the full grid: # + Name, SKU, Pieces/box, Price, Cost
    expect(within(screen.getAllByRole("row")[1]).getAllByRole("cell")).toHaveLength(6);
  });

  it("K12 A5: edit mode keeps every code column even when empty", () => {
    setup({ readOnly: false, rows: [{ ...blankRow("a"), name: "X" }] });
    expect(screen.getByRole("columnheader", { name: "Barcode" })).toBeInTheDocument();
  });

  it("K12 P24: a read-only price never wraps or shrinks below its figures", () => {
    setup({ readOnly: true, rows: saved() });
    expect(screen.getByRole("columnheader", { name: "Price" })).toHaveClass("whitespace-nowrap");
    expect(screen.getByText("$1.25").closest("td")).toHaveClass("whitespace-nowrap");
  });

  it("a row with no id (not saved yet) keeps a plain name", () => {
    setup({ readOnly: true, rows: [{ ...blankRow("n"), name: "Unsaved", pricePerUnit: "2" }] });
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Unsaved" })).toBeNull();
  });

  it("below sm only #, Name and Price show; every other column is in the DOM and returns from sm up", () => {
    setup({ readOnly: true, rows: saved() });
    const keep = ["#", "Name", "Price"];
    const drop = ["SKU", "Barcode", "Unit code", "Pieces per box", "Cost"];
    for (const h of keep) {
      expect(screen.getByRole("columnheader", { name: h }).className).not.toMatch(/max-sm:hidden/);
    }
    for (const h of drop) {
      expect(screen.getByRole("columnheader", { name: h }).className).toMatch(/max-sm:hidden/);
    }
    const row = screen.getAllByRole("row")[1];
    const cells = within(row).getAllByRole("cell");
    // # + 7 data columns: the five dropped ones carry the class, # / Name / Price do not
    expect(cells.filter((c) => /max-sm:hidden/.test(c.className))).toHaveLength(5);
  });

  it("the read-only Cost cell and header are right-aligned in tabular figures, like Price", () => {
    setup({ readOnly: true, rows: saved() });
    expect(screen.getByRole("columnheader", { name: "Cost" })).toHaveClass("text-right");
    const cost = screen.getByText("$0.80");
    expect(cost).toHaveClass("block", "text-right", "tabular-nums");
  });

  it("edit mode keeps the Cost input as it was (left-aligned)", () => {
    setup({ readOnly: false, rows: saved() });
    expect(screen.getByRole("columnheader", { name: "Cost" })).not.toHaveClass("text-right");
    expect(screen.getByLabelText("Variant 1 cost")).not.toHaveClass("text-right");
  });

  it("edit mode is unchanged: every column and every input, nothing hidden", () => {
    setup({ readOnly: false, rows: saved() });
    for (const f of ["name", "SKU", "barcode", "unit code", "pieces per box", "price", "cost"]) {
      expect(screen.getByLabelText(new RegExp(`^Variant 1 ${f}$`, "i"))).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Variant 1 price")).toHaveValue("1.25");
    for (const th of screen.getAllByRole("columnheader")) {
      expect(th.className).not.toMatch(/max-sm:hidden/);
    }
    expect(screen.queryByRole("link", { name: "Strawberry" })).toBeNull();
  });
});

describe("FamilyVariantsGrid focusId (K13 F18)", () => {
  const saved = (): GridRow[] => rows(3).map((r, i) => ({ ...r, id: `v${i + 1}` }) as GridRow);

  it("scrolls the target variant row into view, focuses its link and marks it for a moment", () => {
    const scroll = jest.fn();
    Element.prototype.scrollIntoView = scroll;
    setup({ readOnly: true, rows: saved(), focusId: "v2" });
    const link = screen.getByRole("link", { name: "V2" });
    expect(document.activeElement).toBe(link);
    expect(scroll).toHaveBeenCalled();
    expect(link.closest("tr")).toHaveAttribute("data-focused-variant", "true");
    expect(screen.getByRole("link", { name: "V1" }).closest("tr")).not.toHaveAttribute(
      "data-focused-variant",
    );
  });

  it("does nothing when no row matches", () => {
    setup({ readOnly: true, rows: saved(), focusId: "nope" });
    expect(document.querySelector("[data-focused-variant]")).toBeNull();
  });
});
