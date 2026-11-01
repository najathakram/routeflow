import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import { addScannedProduct, type SaleLine } from "./counter-sale-scan";
import { toSaleItem } from "./counter-sale-line-edit";

/**
 * SA-934 A-1: the till's line row speaks the product's own words, the same ones Create Order's row prints
 * (LineItemRow unitWords({ packLabel, baseUnitLabel })). A line held before this has neither label and prints Box / pcs.
 */

const noop = () => undefined;
const boxed = (over: Partial<SaleLine> = {}): SaleLine => ({
  tempId: "t1",
  productId: "p1",
  name: "Eggs",
  unitPrice: 18,
  unitsPerBox: 24,
  boxes: 1,
  pieces: 0,
  qty: 24,
  ...over,
});
const labelled = boxed({ packLabel: "Case", baseLabel: "Tray" });

function renderRow(l: SaleLine) {
  return render(
    <ul>
      <CounterLineRow
        line={l}
        locked={false}
        onStep={noop}
        onRemove={noop}
        onNote={noop}
        onQty={() => true}
      />
    </ul>,
  );
}

describe("CounterLineRow prints the product's own pack and base words (SA-934 A-1)", () => {
  it("A1: the box step reads '1 Case (24 trays)'", () => {
    renderRow(labelled);
    expect(screen.getByRole("button", { name: "Add a box to Eggs" })).toHaveTextContent(
      "+ 1 Case (24 trays)",
    );
    expect(screen.getByRole("button", { name: "Remove a box from Eggs" })).toHaveTextContent(
      "− 1 Case (24 trays)",
    );
  });

  it("A2: the piece step reads '1 tray', not '1 pc'", () => {
    renderRow(labelled);
    expect(screen.getByRole("button", { name: "Add a piece to Eggs" })).toHaveTextContent(
      "+ 1 tray",
    );
    expect(screen.getByRole("button", { name: "Remove a piece from Eggs" })).toHaveTextContent(
      "− 1 tray",
    );
  });

  it("A3: the row's quantity label reads '1 case of 24'", () => {
    renderRow(labelled);
    expect(screen.getByText(/1 case of 24/)).toBeInTheDocument();
    expect(screen.queryByText(/1 box of 24/)).not.toBeInTheDocument();
  });

  it("A4: addScannedProduct puts the product's labels on the new line", () => {
    const product = {
      id: "p-eggs",
      name: "Eggs",
      pricePerUnit: 18,
      unit: "each",
      unitsPerBox: 24,
      packLabel: "Case",
      baseUnitLabel: "Tray",
    };
    const [line] = addScannedProduct([], product, "PACK" as any, 1, 1);
    expect(line.packLabel).toBe("Case");
    expect(line.baseLabel).toBe("Tray");
  });

  it("A5: a line with no labels prints Box and pcs, as before", () => {
    renderRow(boxed());
    expect(screen.getByRole("button", { name: "Add a box to Eggs" })).toHaveTextContent(
      "+ 1 Box (24 pcs)",
    );
    expect(screen.getByRole("button", { name: "Add a piece to Eggs" })).toHaveTextContent("+ 1 pc");
    expect(screen.getByText(/1 box of 24/)).toBeInTheDocument();
  });

  it("A5: a scanned product with no labels leaves them absent on the line", () => {
    const product = { id: "p-cola", name: "Cola", pricePerUnit: 24, unit: "box", unitsPerBox: 12 };
    const [line] = addScannedProduct([], product, "PACK" as any, 1, 1);
    expect(line.packLabel).toBeUndefined();
    expect(line.baseLabel).toBeUndefined();
  });

  it("A6: toSaleItem sends no label, so the request does not change", () => {
    const withLabels = toSaleItem(labelled);
    const without = toSaleItem(boxed());
    expect(withLabels).toEqual(without);
    expect(JSON.stringify(withLabels)).not.toMatch(/Case|Tray|packLabel|baseLabel/);
  });
});
