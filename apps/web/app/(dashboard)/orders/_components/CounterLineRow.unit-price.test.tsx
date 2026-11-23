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

function renderRow(l: SaleLine, hideOriginalPrice = false) {
  return render(
    <ul>
      <CounterLineRow
        line={l}
        hideOriginalPrice={hideOriginalPrice}
        locked={false}
        onStep={noop}
        onRemove={noop}
        onNote={noop}
        onQty={() => true}
      />
    </ul>,
  );
}

/** The price line of the row (B1373: the order row's "$X / unit" with badges; the struck list price is a line-through span). */
const priceRow = () => screen.getByTestId("line-price-row");
const struck = () => priceRow().querySelector(".line-through");

describe("CounterLineRow per-unit price", () => {
  it("a plain line with no unit word reads the price per piece (the till's word)", () => {
    renderRow(line({ unitPrice: 2.5, listPrice: 2.5 }));
    expect(priceRow()).toHaveTextContent("$2.50 / piece");
    expect(struck()).toBeNull();
  });

  it("row 298: the line states the product's own unit word, as Create Order does", () => {
    renderRow(line({ unit: "each" }));
    expect(priceRow()).toHaveTextContent("$2.50 / each");
    expect(priceRow()).not.toHaveTextContent("piece");
  });

  it("row 298: any unit the product carries is printed", () => {
    renderRow(line({ unit: "lb" }));
    expect(priceRow()).toHaveTextContent("$2.50 / lb");
  });

  it("a line with no catalogue price on file still reads the price each", () => {
    renderRow(line({ unitPrice: 2.5 }));
    expect(priceRow()).toHaveTextContent("$2.50 / piece");
    expect(struck()).toBeNull();
  });

  it("a tier price shows was (catalogue, struck) and now (tier) with the Special price badge", () => {
    renderRow(line({ unitPrice: 2.1, listPrice: 2.5, priceType: "SPECIAL" }));
    expect(struck()).toHaveTextContent("$2.50");
    expect(priceRow()).toHaveTextContent("$2.10 / piece");
    expect(priceRow()).toHaveTextContent("Special price");
  });

  it("a tier price HIGHER than the catalogue never shows the catalogue price (upsell redaction)", () => {
    renderRow(line({ unitPrice: 3, listPrice: 2.5, priceType: "SPECIAL" }));
    expect(struck()).toBeNull();
    expect(priceRow()).toHaveTextContent("$3.00 / piece");
    expect(screen.queryByText("$2.50")).toBeNull();
  });

  it("row 322d: the tenant's hideOriginalPrice (the receipt's rule) strikes no catalogue price on the cart either", () => {
    renderRow(line({ unitPrice: 2.1, listPrice: 2.5, priceType: "SPECIAL" }), true);
    expect(struck()).toBeNull();
    expect(priceRow()).toHaveTextContent("$2.10 / piece");
  });

  it("row 322d: an edited line shows its LIST price struck beside the new price (tier 10, list 12, price 8, qty 2: $16.00 net)", () => {
    // B1373: the order row strikes the unit's list price (Discounted badge); the old struck $24.00 line total is gone
    renderRow(
      line({
        unitPrice: 8,
        tierPrice: 10,
        listPrice: 12,
        qty: 2,
        priceType: "SPECIAL",
        priceEdited: true,
        override: { mode: "set", value: 8 },
      }),
    );
    expect(struck()).toHaveTextContent("$12.00");
    expect(priceRow()).toHaveTextContent("$8.00 / piece");
    expect(priceRow()).toHaveTextContent("Discounted");
    expect(screen.getByTestId("line-total")).toHaveTextContent("$16.00");
  });

  it("row 322d: ...and with hideOriginalPrice the edited line strikes nothing", () => {
    renderRow(
      line({
        unitPrice: 8,
        tierPrice: 10,
        listPrice: 12,
        qty: 2,
        priceType: "SPECIAL",
        priceEdited: true,
        override: { mode: "set", value: 8 },
      }),
      true,
    );
    expect(struck()).toBeNull();
    expect(screen.getByTestId("line-total")).toHaveTextContent("$16.00");
  });

  it("a boxed line reads the price per box", () => {
    renderRow(
      line({ unitPrice: 12, listPrice: 12, unitsPerBox: 12, boxes: 2, pieces: 0, qty: 24 }),
    );
    expect(priceRow()).toHaveTextContent("$12.00 / box");
    expect(screen.getByTestId("line-total")).toHaveTextContent("$24.00");
  });

  it("a scanned case reads the price per box and each piece, with its whole-box count and footer", () => {
    // the tenant's pack word (unitWords) is "box" until a pack label rides on the line; the shape is what is pinned
    renderRow(
      line({ unitPrice: 18, listPrice: 18, unitsPerBox: 24, boxes: 1, pieces: 0, qty: 24 }),
    );
    expect(priceRow()).toHaveTextContent("$18.00 / box");
    expect(screen.getByRole("listitem")).toHaveTextContent("$0.75 / piece");
    expect(screen.getByTitle(/^Number of whole box/)).toHaveValue(1);
    expect(screen.getByTestId("line-qty-controls")).toHaveTextContent("1 box = 24 pcs");
  });

  it("loose pieces of a case read in pcs, still naming the pack", () => {
    renderRow(line({ unitPrice: 18, listPrice: 18, unitsPerBox: 24, boxes: 0, pieces: 3, qty: 3 }));
    expect(screen.getByTitle(/^Number of whole box/)).toHaveValue(0);
    expect(screen.getByRole("spinbutton", { name: /^Extra/ })).toHaveValue(3);
    expect(screen.getByTestId("line-qty-controls")).toHaveTextContent("1 box = 24 pcs");
    expect(screen.getByTestId("line-qty-controls")).toHaveTextContent("3 pcs total");
    expect(priceRow()).toHaveTextContent("$18.00 / box");
    expect(screen.getByRole("listitem")).toHaveTextContent("$0.75 / piece");
  });

  it("B1230: unit 'each' never reads '/ piece'", () => {
    renderRow(line({ unit: "each" }));
    expect(priceRow()).toHaveTextContent("$2.50 / each");
    expect(priceRow()).not.toHaveTextContent("piece");
    expect(priceRow()).not.toHaveTextContent("each each");
  });
});
