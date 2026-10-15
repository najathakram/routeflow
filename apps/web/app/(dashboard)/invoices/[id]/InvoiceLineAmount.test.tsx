import * as React from "react";
import { render, screen } from "@testing-library/react";
import { InvoiceLineAmount } from "./InvoiceLineAmount";

// The invoice detail Amount cell used to fall back to `qty * unitPrice` when a line carried no
// stored subtotal: one 24-pack at $12.90 (qty = pieces, unitPrice = BOX price) read $309.60.

function renderCell(item: Record<string, unknown>) {
  render(
    <table>
      <tbody>
        <tr>
          <InvoiceLineAmount item={item as any} />
        </tr>
      </tbody>
    </table>,
  );
  return screen.getByRole("cell");
}

describe("InvoiceLineAmount", () => {
  it("one box of 24 @ $12.90 with no stored subtotal reads $12.90, never $309.60", () => {
    const cell = renderCell({ qty: 24, unitPrice: 12.9, boxes: 1, pieces: 0, unitsPerBox: 24 });
    expect(cell).toHaveTextContent("$12.90");
    expect(cell).not.toHaveTextContent("$309.60");
  });

  it("2 boxes + 6 loose pieces of a 24-pack @ $12.90 (no stored subtotal) reads $29.03", () => {
    expect(
      renderCell({ qty: 54, unitPrice: 12.9, boxes: 2, pieces: 6, unitsPerBox: 24 }),
    ).toHaveTextContent("$29.03");
  });

  it("the line discount comes off the re-priced line", () => {
    expect(
      renderCell({
        qty: 24,
        unitPrice: 12.9,
        boxes: 1,
        pieces: 0,
        unitsPerBox: 24,
        discount: 2.9,
      }),
    ).toHaveTextContent("$10.00");
  });

  it("a stored subtotal is authoritative (Decimal string)", () => {
    expect(
      renderCell({ qty: 24, unitPrice: 12.9, boxes: 1, unitsPerBox: 24, subtotal: "11.50" }),
    ).toHaveTextContent("$11.50");
  });

  it("a non-boxed line without a stored subtotal is qty x unitPrice", () => {
    expect(renderCell({ qty: 3, unitPrice: 2.5 })).toHaveTextContent("$7.50");
  });
});
