/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PurchaseOrderLinesTable, type CatalogProduct } from "./PurchaseOrderLinesTable";
import { emptyEditLine, type EditLine } from "./purchase-orders-edit";
import { unitWords } from "@routeflow/pricing";

// U-3a: the cost input is labelled by the default unit words (no per-product label on a PO line yet).
const UW = unitWords();
// Per line: a boxed line is costed per box, a plain line per piece — never either-or.
const COST_PER_BOX = `Cost per ${UW.pack.lower}`;
const COST_PER_PIECE = `Cost per ${UW.base.lower}`;

const products: CatalogProduct[] = [
  { id: "p-each", name: "Napkins", sku: "NAP", unitsPerBox: 1 },
  { id: "p-box", name: "Cola", unitsPerBox: 24 },
];

/** Holds the lines like the modal does, and mirrors the latest value out for assertions. */
function Harness({
  initial,
  received = false,
  seen,
}: {
  initial: EditLine[];
  received?: boolean;
  seen: { lines: EditLine[] };
}) {
  const [lines, setLines] = React.useState(initial);
  seen.lines = lines;
  return (
    <PurchaseOrderLinesTable
      lines={lines}
      setLines={setLines}
      products={products}
      received={received}
      fallbackName={() => "Old item"}
    />
  );
}

const line = (over: Partial<EditLine>): EditLine => ({ ...emptyEditLine(), ...over });

describe("PurchaseOrderLinesTable", () => {
  it("shows Boxes + Pieces and a per-box cost for a boxed product, with the pieces total", () => {
    const seen = { lines: [] as EditLine[] };
    render(
      <Harness
        seen={seen}
        initial={[line({ id: "l1", productId: "p-box", boxes: "2", pieces: "3", unitCost: "24" })]}
      />,
    );
    expect(screen.getByLabelText("Boxes")).toHaveValue(2);
    expect(screen.getByLabelText("Extra pieces")).toHaveValue(3);
    expect(screen.getByText("per box")).toBeInTheDocument();
    expect(screen.getByText("boxes + pcs · 51 pcs total")).toBeInTheDocument();
  });

  it("totals the lines (per-piece cost x pieces for boxed, qty x cost otherwise)", () => {
    const seen = { lines: [] as EditLine[] };
    render(
      <Harness
        seen={seen}
        initial={[
          line({ id: "a", productId: "p-each", qty: "10", unitCost: "1.5" }), // 15.00
          line({ id: "b", productId: "p-box", boxes: "1", pieces: "0", unitCost: "24" }), // 24.00
        ]}
      />,
    );
    expect(screen.getAllByText("$39.00").length).toBeGreaterThan(0);
  });

  it("locks a received line's product and removal, and floors its quantity at what arrived", () => {
    const seen = { lines: [] as EditLine[] };
    render(
      <Harness
        seen={seen}
        received
        initial={[
          line({ id: "l1", productId: "p-each", qty: "10", unitCost: "1", received: 4 }),
          line({ id: "l2", productId: "p-each", qty: "5", unitCost: "1", received: 0 }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1, 3);
    const [receivedRow, openRow] = rows;
    expect(within(receivedRow).getByLabelText("Product")).toBeDisabled();
    expect(within(receivedRow).getByLabelText("Quantity")).toHaveAttribute("min", "4");
    expect(within(receivedRow).getByText("Received: 4")).toBeInTheDocument();
    expect(within(receivedRow).queryByLabelText("Remove line")).toBeNull();
    // an unreceived line on the same order stays fully editable
    expect(within(openRow).getByLabelText("Product")).toBeEnabled();
    expect(within(openRow).getByLabelText("Remove line")).toBeEnabled();
  });

  it("adds and removes lines, and never removes the last one", () => {
    const seen = { lines: [] as EditLine[] };
    render(
      <Harness
        seen={seen}
        initial={[line({ id: "l1", productId: "p-each", qty: "1", unitCost: "1" })]}
      />,
    );
    expect(screen.getByLabelText("Remove line")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /add row/i }));
    expect(seen.lines).toHaveLength(2);
    fireEvent.click(screen.getAllByLabelText("Remove line")[1]);
    expect(seen.lines.map((l) => l.id)).toEqual(["l1"]);
  });

  it("keeps an archived product selectable under its order name", () => {
    const seen = { lines: [] as EditLine[] };
    render(
      <Harness
        seen={seen}
        initial={[line({ id: "l1", productId: "gone", qty: "1", unitCost: "1" })]}
      />,
    );
    expect(screen.getByRole("option", { name: "Old item" })).toBeInTheDocument();
  });

  it("writes what the operator types back to the line", () => {
    const seen = { lines: [] as EditLine[] };
    render(
      <Harness
        seen={seen}
        initial={[line({ id: "l1", productId: "p-each", qty: "1", unitCost: "1" })]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "7.5" } });
    fireEvent.change(screen.getByLabelText(COST_PER_PIECE), { target: { value: "2.25" } });
    expect(seen.lines[0]).toMatchObject({ qty: "7.5", unitCost: "2.25" });
  });

  it("asserts the cost basis per line: a boxed line is per box, a plain line per piece", () => {
    const seen = { lines: [] as EditLine[] };
    render(
      <Harness
        seen={seen}
        initial={[
          line({ id: "l1", productId: "p-box", boxes: "1", pieces: "0", unitCost: "24" }),
          line({ id: "l2", productId: "p-each", qty: "1", unitCost: "1" }),
        ]}
      />,
    );
    const [boxedRow, plainRow] = screen.getAllByRole("row").slice(-2);
    expect(within(boxedRow).getByLabelText(COST_PER_BOX)).toBeInTheDocument();
    expect(within(boxedRow).queryByLabelText(COST_PER_PIECE)).toBeNull();
    expect(within(plainRow).getByLabelText(COST_PER_PIECE)).toBeInTheDocument();
    expect(within(plainRow).queryByLabelText(COST_PER_BOX)).toBeNull();
  });

  it("the visible cost label is the input's own name (label-in-name) and the header says per box", () => {
    const seen = { lines: [] as EditLine[] };
    render(
      <Harness
        seen={seen}
        initial={[line({ id: "l1", productId: "p-box", boxes: "1", pieces: "0", unitCost: "24" })]}
      />,
    );
    expect(screen.getAllByText(COST_PER_BOX).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("columnheader", { name: /Cost per box/ })).toBeInTheDocument();
    expect(screen.queryByText("Unit cost ($)")).toBeNull();
    expect(screen.queryByText("Cost ($)")).toBeNull();
  });
});
