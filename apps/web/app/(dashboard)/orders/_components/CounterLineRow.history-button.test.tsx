import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CounterLineRow } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";

/**
 * P2 (SA-1071): on the counter, History matches Change price beside it: the same secondary button, 44 px below `lg` and
 * 28 px from `lg`. The builder keeps its own label.
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

describe("CounterLineRow: History matches Change price", () => {
  it("has the same height classes at both widths", () => {
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
    const change = screen.getByRole("button", { name: /change price/i });
    expect(history).toHaveTextContent("History");
    const classes = history.className.split(/\s+/);
    for (const c of ["h-7", "min-h-[44px]", "lg:min-h-0"]) {
      expect(change.className.split(/\s+/)).toContain(c);
      expect(classes).toContain(c);
    }
    expect(classes).not.toContain("h-6");
  });
});
