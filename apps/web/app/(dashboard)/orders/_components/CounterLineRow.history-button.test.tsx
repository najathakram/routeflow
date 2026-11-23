import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CounterLineRow } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";

/**
 * P2 (SA-1071) / B1373: on the counter, History is the order row's own button beside the price: 44 px below `lg`, compact
 * from `lg`. The price is the Change price control now (no second button).
 */
const noop = () => undefined;
const line: SaleLine = {
  tempId: "t1",
  productId: "p1",
  name: "Cola",
  unitPrice: 10,
  listPrice: 10,
  qty: 1,
};

describe("CounterLineRow: History beside Change price", () => {
  it("keeps a 44 px touch floor below lg and sits beside the price control", () => {
    renderWithProviders(
      <ul>
        <CounterLineRow
          line={line}
          hideOriginalPrice={false}
          locked={false}
          canEditPrices
          historyCustomerId="c1"
          onStep={noop}
          onRemove={noop}
          onNote={noop}
          onQty={() => true}
        />
      </ul>,
    );
    const history = screen.getByRole("button", { name: "Price history" });
    // B1373: the price itself is the Change price control (the order row's tap-to-edit price), beside History
    expect(screen.getByRole("button", { name: "Change price for Cola" })).toHaveTextContent(
      "$10.00 / piece",
    );
    expect(history).toHaveTextContent("History");
    const classes = history.className.split(/\s+/);
    for (const c of ["min-h-11", "min-w-11", "lg:min-h-0", "lg:min-w-0"]) {
      expect(classes).toContain(c);
    }
  });
});
