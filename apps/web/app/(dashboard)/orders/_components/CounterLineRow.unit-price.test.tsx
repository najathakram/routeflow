import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";

/** Row 71: the cart line states its per-unit price; a tier price shows was / now beside the catalogue price. */

const noop = () => undefined;
const line = (over: Partial<SaleLine>): SaleLine => ({
  tempId: "t1",
  productId: "p1",
  name: "Cola",
  unitPrice: 2.5,
  qty: 2,
  ...over,
});

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

describe("CounterLineRow per-unit price", () => {
  it("a plain line reads the price each", () => {
    renderRow(line({ unitPrice: 2.5, listPrice: 2.5 }));
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$2.50 / piece");
    expect(screen.queryByTestId("line-unit-price-was")).toBeNull();
  });

  it("row 298: the line states the product's own unit word, as Create Order does", () => {
    renderRow(line({ unit: "each" }));
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$2.50 / each");
    expect(screen.getByTestId("line-unit-price")).not.toHaveTextContent("piece");
  });

  it("row 298: any unit the product carries is lower-cased and printed", () => {
    renderRow(line({ unit: "LB" }));
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$2.50 / lb");
  });

  it("a line with no catalogue price on file still reads the price each", () => {
    renderRow(line({ unitPrice: 2.5 }));
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$2.50 / piece");
    expect(screen.queryByTestId("line-unit-price-was")).toBeNull();
  });

  it("a tier price shows was (catalogue) and now (tier)", () => {
    renderRow(line({ unitPrice: 2.1, listPrice: 2.5, priceType: "SPECIAL" }));
    expect(screen.getByTestId("line-unit-price-was")).toHaveTextContent("$2.50");
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$2.10 / piece");
  });

  it("a tier price HIGHER than the catalogue never shows the catalogue price (upsell redaction)", () => {
    renderRow(line({ unitPrice: 3, listPrice: 2.5, priceType: "SPECIAL" }));
    expect(screen.queryByTestId("line-unit-price-was")).toBeNull();
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$3.00 / piece");
    expect(screen.queryByText("$2.50")).toBeNull();
  });

  it("a boxed line reads the price per box", () => {
    renderRow(
      line({ unitPrice: 12, listPrice: 12, unitsPerBox: 12, boxes: 2, pieces: 0, qty: 24 }),
    );
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$12.00 / box");
  });
});
