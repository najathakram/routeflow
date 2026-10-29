import { render, screen } from "@testing-library/react";
import { invoiceDisplayLines } from "@routeflow/pricing";
import { InvoiceDisplayRows, displayQtyText, formatUnitPrice4 } from "./InvoiceDisplayRows";

const fmt = (n: number) => `$${n.toFixed(2)}`;
const item = {
  description: "Acme Mixed Box",
  qty: 30,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 15,
  unitPrice: 30.01,
  subtotal: 60.02,
};
const comps = [
  {
    componentProductId: "a1",
    name: "Acme Alpha",
    qty: 10,
    unitSku: "AL-1",
    unitBarcode: "0123456789012",
    position: 0,
  },
  { componentProductId: "a2", name: "Acme Beta", qty: 20, position: 1 },
];
const pieces = { kind: "pieces" as const, label: "Piece" };

function renderRows(lines: ReturnType<typeof invoiceDisplayLines>, variant: "staff" | "buyer") {
  if (lines.layout !== "components") throw new Error("not the components layout");
  return render(
    <table>
      <tbody>
        <InvoiceDisplayRows lines={lines} itemId="i1" fmt={fmt} variant={variant}>
          <tr data-testid="display-group-row-i1">
            <td>Acme Mixed Box own row</td>
            <td />
            <td />
            <td>$60.02</td>
          </tr>
        </InvoiceDisplayRows>
      </tbody>
    </table>,
  );
}

describe("InvoiceDisplayRows (components layout)", () => {
  it.each(["staff", "buyer"] as const)(
    "%s: component rows, then the group row, then no tax",
    (variant) => {
      renderRows(invoiceDisplayLines(item, comps, pieces), variant);
      const a1 = screen.getByTestId("display-row-i1-a1");
      expect(a1).toHaveTextContent("Acme Alpha");
      expect(a1).toHaveTextContent("10 Pieces");
      expect(a1).toHaveTextContent("$2.0010");
      expect(a1).toHaveTextContent("$20.01");
      expect(screen.getByTestId("display-row-i1-a2")).toHaveTextContent("$2.0005");
      expect(screen.getByTestId("display-row-i1-a2")).toHaveTextContent("$40.01");
      // the separate groupTotal row is gone; the caller's own row is the group row
      expect(screen.queryByTestId("display-group-total-i1")).toBeNull();
      const group = screen.getByTestId("display-group-row-i1");
      expect(group).toHaveTextContent("$60.02");
      expect(a1.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByTestId("display-category-tax-i1")).toBeNull();
    },
  );

  it("staff shows SKU and barcode text on the component row", () => {
    renderRows(invoiceDisplayLines(item, comps, pieces), "staff");
    expect(screen.getByTestId("display-row-i1-a1")).toHaveTextContent("SKU AL-1");
    expect(screen.getByTestId("display-row-i1-a1")).toHaveTextContent("0123456789012");
  });

  it("prints the category tax row under the group", () => {
    renderRows(
      invoiceDisplayLines(
        { ...item, categoryTax: { name: "Tobacco", amount: 3.5 } },
        comps,
        pieces,
      ),
      "staff",
    );
    const tax = screen.getByTestId("display-category-tax-i1");
    expect(tax).toHaveTextContent("Tobacco tax");
    expect(tax).toHaveTextContent("$3.50");
    expect(
      screen.getByTestId("display-group-row-i1").compareDocumentPosition(tax) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("display helpers", () => {
  it("pluralises the unit word and prints four decimals", () => {
    expect(displayQtyText(30, "Piece")).toBe("30 Pieces");
    expect(displayQtyText(1, "Piece")).toBe("1 Piece");
    expect(formatUnitPrice4(2.0007)).toBe("$2.0007");
  });
});
