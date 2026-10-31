import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CounterLineRow } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";

/**
 * SA-1068 T1 / M13: a line the till priced at the customer's remembered price says why, with one chip. A typed price has its
 * own chip, and a plain line has none.
 */
const noop = () => undefined;
const line = (over: Partial<SaleLine>): SaleLine => ({
  tempId: "t1",
  productId: "p1",
  name: "Cola",
  unitPrice: 15,
  listPrice: 10,
  qty: 1,
  ...over,
});

function renderRow(l: SaleLine) {
  return render(
    <ul>
      <CounterLineRow
        line={l}
        hideOriginalPrice={false}
        locked={false}
        onStep={noop}
        onRemove={noop}
        onNote={noop}
        onQty={() => true}
      />
    </ul>,
  );
}

describe("CounterLineRow: the Last price chip", () => {
  it("a remembered line shows it", () => {
    renderRow(line({ remembered: true, priceType: "MANUAL" }));
    expect(screen.getByTestId("line-last-price-chip")).toHaveTextContent("Last price");
  });

  it("a plain line does not", () => {
    renderRow(line({ unitPrice: 10 }));
    expect(screen.queryByTestId("line-last-price-chip")).toBeNull();
  });
});
