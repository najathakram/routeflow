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
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$2.50 each");
    expect(screen.queryByTestId("line-unit-price-was")).toBeNull();
  });

  it("a line with no catalogue price on file still reads the price each", () => {
    renderRow(line({ unitPrice: 2.5 }));
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$2.50 each");
    expect(screen.queryByTestId("line-unit-price-was")).toBeNull();
  });

  it("a tier price shows was (catalogue) and now (tier)", () => {
    renderRow(line({ unitPrice: 2.1, listPrice: 2.5, priceType: "SPECIAL" }));
    expect(screen.getByTestId("line-unit-price-was")).toHaveTextContent("$2.50");
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$2.10 each");
  });

  it("a boxed line reads the price per box", () => {
    renderRow(
      line({ unitPrice: 12, listPrice: 12, unitsPerBox: 12, boxes: 2, pieces: 0, qty: 24 }),
    );
    expect(screen.getByTestId("line-unit-price")).toHaveTextContent("$12.00 / box");
  });
});
