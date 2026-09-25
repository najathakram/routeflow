import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { OrderItem } from "@/lib/api/orders";
import { COLLAPSE_AFTER, OrderLineItemCards, lineRowProps } from "./OrderLineItemCards";

/**
 * order_ui_v2 card list. Fixtures are placeholders (`Sample …`). Pixel claims (no overflow at
 * 390, bounded row height) are proven by the Lane F Playwright pass, not here.
 */

function line(over: Record<string, unknown> = {}): OrderItem {
  return {
    id: "li-1",
    productId: "p-1",
    product: { id: "p-1", name: "Sample Cola 12oz", unit: "each", sku: "100200300" },
    qty: 8,
    unitPrice: 65,
    priceType: "STANDARD",
    status: "PENDING",
    subtotal: 520,
    deliveredQty: 0,
    ...over,
  } as unknown as OrderItem;
}

function many(n: number): OrderItem[] {
  return Array.from({ length: n }, (_, i) =>
    line({
      id: `li-${i}`,
      product: { id: `p-${i}`, name: `Sample Item ${i + 1}`, unit: "each" },
      subtotal: 10,
      unitPrice: 10,
      qty: 1,
    }),
  );
}

describe("a unit-aware line names its own unit (units_v1)", () => {
  const caseLine = (over: Record<string, unknown> = {}) =>
    line({
      qty: 36,
      boxes: 3,
      pieces: 0,
      unitsPerBox: 12,
      unitLabel: "Case",
      unitPrice: 30,
      subtotal: 90,
      ...over,
    });

  it("maps the line's unitLabel onto the row's box label", () => {
    expect(lineRowProps(caseLine(), "CONFIRMED").boxLabel).toBe("Case");
    expect(lineRowProps(line(), "CONFIRMED").boxLabel).toBeNull();
  });

  it("a 3-Case line reads '3 Cases', priced per Case — not '3 boxes'", () => {
    render(<OrderLineItemCards lineItems={[caseLine()]} orderStatus="CONFIRMED" total={90} />);
    expect(screen.getByText("3 Cases · $30.00 / Case of 12")).toBeInTheDocument();
    expect(screen.queryByText(/box/i)).not.toBeInTheDocument();
  });

  it("delivery progress uses the same noun", () => {
    render(
      <OrderLineItemCards
        lineItems={[caseLine({ deliveredQty: 12 })]}
        orderStatus="PARTIALLY_DELIVERED"
        total={90}
      />,
    );
    expect(screen.getByText("1 Case of 3 Cases delivered")).toBeInTheDocument();
  });

  it("a line with no unitLabel still reads 'boxes'", () => {
    render(
      <OrderLineItemCards
        lineItems={[caseLine({ unitLabel: null })]}
        orderStatus="CONFIRMED"
        total={90}
      />,
    );
    expect(screen.getByText("3 boxes · $30.00 / box of 12")).toBeInTheDocument();
  });
});

describe("lineRowProps — order line → read-only row", () => {
  it("maps name, sku, money fields and the derived status", () => {
    const p = lineRowProps(line({ notes: "leave at dock" }), "CONFIRMED");
    expect(p).toMatchObject({
      displayName: "Sample Cola 12oz",
      sku: "100200300",
      unitPrice: 65,
      qty: 8,
      subtotal: 520,
      note: "leave at dock",
      lineStatus: "PENDING",
    });
  });

  it("composes a variant's name at read time", () => {
    const p = lineRowProps(
      line({
        product: {
          id: "p-2",
          name: "Strawberry Banana",
          unit: "each",
          variantName: "Strawberry Banana",
          parentProductId: "p-parent",
          parent: { name: "Sample Pod" },
        },
      }),
      "CONFIRMED",
    );
    expect(p.displayName).toBe("Sample Pod - Strawberry Banana");
  });

  it("uses the line's snapshot pack size, falling back to the live product's", () => {
    expect(lineRowProps(line({ unitsPerBox: 12 }), "CONFIRMED").unitsPerBox).toBe(12);
    expect(
      lineRowProps(
        line({ product: { id: "p", name: "X", unit: "case", unitsPerBox: 24 } }),
        "CONFIRMED",
      ).unitsPerBox,
    ).toBe(24);
  });

  it("an ad-hoc line with no product falls back to its label, then 'Custom item'", () => {
    expect(
      lineRowProps(line({ product: undefined, name: "Delivery surcharge" }), "X").displayName,
    ).toBe("Delivery surcharge");
    expect(lineRowProps(line({ product: undefined, name: null }), "X").displayName).toBe(
      "Custom item",
    );
  });

  it("flags an ad-hoc line as custom, and a catalog line as not", () => {
    expect(
      lineRowProps(line({ productId: null, product: undefined, name: "Fee" }), "X").custom,
    ).toBe(true);
    expect(lineRowProps(line(), "X").custom).toBe(false);
  });

  it("delivery progress is only shown once the order is out, part-delivered or delivered", () => {
    for (const s of ["DRAFT", "PENDING", "CONFIRMED", "CANCELLED"]) {
      expect(lineRowProps(line(), s).showDeliveryProgress).toBe(false);
    }
    for (const s of ["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"]) {
      expect(lineRowProps(line(), s).showDeliveryProgress).toBe(true);
    }
  });
});

describe("OrderLineItemCards", () => {
  it("summarises active items and the total above the list, and repeats the total below", () => {
    render(
      <OrderLineItemCards
        lineItems={[line(), line({ id: "li-2", status: "CANCELLED" })]}
        orderStatus="CONFIRMED"
        total={1234.5}
      />,
    );
    expect(screen.getByTestId("order-lines-summary")).toHaveTextContent("1 item · $1,234.50");
    expect(screen.getByText("Order Total")).toBeInTheDocument();
    // the footer repeats the amount on its own (the summary carries it inside one text node)
    expect(screen.getByText("$1,234.50")).toBeInTheDocument();
  });

  it("renders one card per line with name, sku, qty × price and stored total", () => {
    render(<OrderLineItemCards lineItems={[line()]} orderStatus="CONFIRMED" total={520} />);
    expect(screen.getByText("Sample Cola 12oz")).toBeInTheDocument();
    expect(screen.getByText("SKU 100200300")).toBeInTheDocument();
    expect(screen.getByText("8 × $65.00")).toBeInTheDocument();
    expect(screen.getByRole("list").children).toHaveLength(1);
  });

  it("keeps the table's price explanations: special tag and free-units label", () => {
    render(
      <OrderLineItemCards
        lineItems={[line({ priceType: "SPECIAL", originalPrice: 80, promoFreeUnits: 2 })]}
        orderStatus="CONFIRMED"
        total={520}
      />,
    );
    expect(within(screen.getByTestId("line-price-tag")).getByText("Special")).toBeInTheDocument();
    expect(screen.getByText("$80.00")).toHaveClass("line-through");
    expect(screen.getByText("2 free")).toBeInTheDocument();
  });

  it("a cancelled line shows no dollar total and does not count as an item", () => {
    render(
      <OrderLineItemCards
        lineItems={[line({ status: "CANCELLED" })]}
        orderStatus="CONFIRMED"
        total={0}
      />,
    );
    expect(screen.getByTestId("order-lines-summary")).toHaveTextContent("0 items");
    expect(screen.getByLabelText("No charge — line cancelled")).toBeInTheDocument();
    expect(screen.queryByText("$520.00")).toBeNull();
  });

  it("shows a status pill and 'N of M delivered' for a short-picked line on an out-for-delivery order", () => {
    render(
      <OrderLineItemCards
        lineItems={[line({ deliveredQty: 3, qty: 8 })]}
        orderStatus="OUT_FOR_DELIVERY"
        total={520}
      />,
    );
    expect(screen.getByText("3 of 8 delivered")).toBeInTheDocument();
    expect(screen.getByText("Partial")).toBeInTheDocument();
  });

  it("a PARTIALLY_DELIVERED order still shows how many of a short line were delivered", () => {
    render(
      <OrderLineItemCards
        lineItems={[line({ deliveredQty: 3, qty: 8 })]}
        orderStatus="PARTIALLY_DELIVERED"
        total={520}
      />,
    );
    expect(screen.getByText("3 of 8 delivered")).toBeInTheDocument();
  });

  it("marks an ad-hoc line with the Custom pill, like the table", () => {
    render(
      <OrderLineItemCards
        lineItems={[line({ productId: null, product: undefined, name: "Delivery surcharge" })]}
        orderStatus="CONFIRMED"
        total={520}
      />,
    );
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("does not print '0 of 8 delivered' on an order that has not gone out", () => {
    render(<OrderLineItemCards lineItems={[line()]} orderStatus="CONFIRMED" total={520} />);
    expect(screen.queryByText(/delivered/i)).toBeNull();
  });

  describe("collapsing long orders", () => {
    it(`shows all lines up to ${COLLAPSE_AFTER} with no toggle`, () => {
      render(
        <OrderLineItemCards lineItems={many(COLLAPSE_AFTER)} orderStatus="CONFIRMED" total={60} />,
      );
      expect(screen.getByRole("list").children).toHaveLength(COLLAPSE_AFTER);
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("beyond that, shows the first lines and 'Show N more items', then expands and collapses", () => {
      render(
        <OrderLineItemCards
          lineItems={many(COLLAPSE_AFTER + 4)}
          orderStatus="CONFIRMED"
          total={100}
        />,
      );
      expect(screen.getByRole("list").children).toHaveLength(COLLAPSE_AFTER);
      const toggle = screen.getByRole("button", { name: "Show 4 more items" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(toggle);
      expect(screen.getByRole("list").children).toHaveLength(COLLAPSE_AFTER + 4);
      const fewer = screen.getByRole("button", { name: "Show fewer items" });
      expect(fewer).toHaveAttribute("aria-expanded", "true");

      fireEvent.click(fewer);
      expect(screen.getByRole("list").children).toHaveLength(COLLAPSE_AFTER);
    });

    it("singular wording for exactly one hidden line", () => {
      render(
        <OrderLineItemCards
          lineItems={many(COLLAPSE_AFTER + 1)}
          orderStatus="CONFIRMED"
          total={70}
        />,
      );
      expect(screen.getByRole("button", { name: "Show 1 more item" })).toBeInTheDocument();
    });
  });

  it("an order with no lines renders the summary and total only", () => {
    render(<OrderLineItemCards lineItems={[]} orderStatus="CONFIRMED" total={0} />);
    expect(screen.getByTestId("order-lines-summary")).toHaveTextContent("0 items · $0.00");
    expect(screen.getByRole("list").children).toHaveLength(0);
  });
});
