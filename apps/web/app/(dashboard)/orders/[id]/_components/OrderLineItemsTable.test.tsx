import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import type { OrderItem } from "@/lib/api/orders";
import { OrderLineItemsTable } from "./OrderLineItemsTable";

/**
 * Characterization of the order-detail line table, written against the block as it was when it
 * lived inline in `orders/[id]/page.tsx` (moved verbatim — token-identical, see the PR). These
 * pin TODAY'S behaviour so the card-list redesign that replaces it can be diffed against them.
 * Fixtures are placeholders (`Sample …`); no live-client names.
 */

function line(over: Record<string, unknown>): OrderItem {
  return {
    id: "li-1",
    productId: "p-1",
    product: { id: "p-1", name: "Sample Cola 12oz", unit: "each" },
    qty: 8,
    unitPrice: 65,
    priceType: "STANDARD",
    status: "PENDING",
    subtotal: 520,
    ...over,
  } as unknown as OrderItem;
}

function renderTable(lineItems: OrderItem[], orderStatus = "CONFIRMED", total = 520) {
  return render(
    <OrderLineItemsTable lineItems={lineItems} orderStatus={orderStatus} total={total} />,
  );
}

const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

describe("OrderLineItemsTable — columns and a plain line", () => {
  it("renders the five column headers and the order-total footer", () => {
    renderTable([line({})], "CONFIRMED", 1234.5);
    for (const h of ["Product", "Qty", "Unit Price", "Line Total", "Status"]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
    expect(screen.getByText("Order Total")).toBeInTheDocument();
    expect(screen.getByText("$1,234.50")).toBeInTheDocument();
  });

  it("a plain line: name, whole qty, unit price, stored subtotal", () => {
    renderTable([line({})]);
    const row = within(rowFor("Sample Cola 12oz"));
    expect(row.getByText("8")).toBeInTheDocument();
    expect(row.getAllByText("$65.00").length).toBeGreaterThan(0);
    expect(row.getByText("$520.00")).toBeInTheDocument();
  });

  it("falls back to the line name, then 'Custom item', and flags an unlisted line", () => {
    renderTable([
      line({ id: "a", productId: null, product: undefined, name: "Delivery surcharge" }),
      line({ id: "b", productId: null, product: undefined, name: null }),
    ]);
    expect(screen.getByText("Delivery surcharge")).toBeInTheDocument();
    expect(screen.getByText("Custom item")).toBeInTheDocument();
    expect(screen.getAllByText("Custom")).toHaveLength(2);
  });

  it("shows the per-line note", () => {
    renderTable([line({ notes: "leave at dock" })]);
    expect(screen.getByText("leave at dock")).toBeInTheDocument();
  });
});

describe("OrderLineItemsTable — quantity", () => {
  it("a boxed line renders the boxes + pieces split with a total-pcs tooltip", () => {
    renderTable([
      line({ qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12, unitPrice: 30, subtotal: 67.5 }),
    ]);
    const split = screen.getByText("2 boxes + 3 pcs");
    expect(split).toHaveAttribute("title", "27 pcs total");
  });

  it("names BUY_N_GET_M free units so the reduced total does not read as a pricing error", () => {
    renderTable([line({ promoFreeUnits: 2 })]);
    expect(screen.getByText("2 free")).toBeInTheDocument();
  });
});

describe("OrderLineItemsTable — unit price variants", () => {
  it("SPECIAL: strikes the original, shows the special price and a Special badge", () => {
    renderTable([line({ priceType: "SPECIAL", originalPrice: 80, unitPrice: 65 })]);
    const row = within(rowFor("Sample Cola 12oz"));
    expect(row.getByText("$80.00")).toBeInTheDocument();
    expect(row.getByText("Special")).toBeInTheDocument();
  });

  it("MANUAL above the original is an Upsell with no strikethrough of the base", () => {
    renderTable([line({ priceType: "MANUAL", originalPrice: 50, unitPrice: 65 })]);
    const row = within(rowFor("Sample Cola 12oz"));
    expect(row.getByText("Upsell")).toBeInTheDocument();
    expect(row.queryByText("$50.00")).toBeNull();
  });

  it.each([
    ["DISCOUNTED", "Discounted"],
    ["PROMO", "Promo"],
    ["MANUAL", "Adjusted"],
  ])("%s below the original strikes it and shows the %s badge", (priceType, label) => {
    renderTable([line({ priceType, originalPrice: 80, unitPrice: 65 })]);
    const row = within(rowFor("Sample Cola 12oz"));
    expect(row.getByText("$80.00")).toBeInTheDocument();
    expect(row.getByText(label)).toBeInTheDocument();
  });
});

describe("OrderLineItemsTable — line total and status", () => {
  it("prefers the server-stored subtotal over a recompute", () => {
    renderTable([
      line({ subtotal: 60, qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12, unitPrice: 30 }),
    ]);
    expect(screen.getByText("$60.00")).toBeInTheDocument();
    expect(screen.queryByText("$90.00")).toBeNull();
  });

  it("with no stored subtotal, recomputes with the snapshot pack size and free units", () => {
    renderTable([
      line({
        subtotal: null,
        qty: 36,
        boxes: 3,
        pieces: 0,
        unitsPerBox: 12,
        unitPrice: 30,
        promoFreeUnits: 1,
      }),
    ]);
    expect(screen.getByText("$60.00")).toBeInTheDocument(); // (3 - 1 free) boxes x $30
  });

  it("falls back to the live product's pack size when the line has no snapshot", () => {
    renderTable([
      line({
        subtotal: null,
        qty: 27,
        boxes: 2,
        pieces: 3,
        unitsPerBox: undefined,
        unitPrice: 30,
        product: { id: "p-1", name: "Sample Cola 12oz", unit: "case", unitsPerBox: 12 },
      }),
    ]);
    expect(screen.getByText("$67.50")).toBeInTheDocument(); // 2 boxes + 3/12 of a box at $30
  });

  it("keeps the price emphasis: struck original, emerald special, amber discount", () => {
    const special = renderTable([line({ priceType: "SPECIAL", originalPrice: 80, unitPrice: 65 })]);
    let row = within(rowFor("Sample Cola 12oz"));
    expect(row.getByText("$80.00")).toHaveClass("strike");
    expect(row.getAllByText("$65.00")[0]).toHaveClass("text-emerald-600");
    special.unmount();

    renderTable([line({ priceType: "DISCOUNTED", originalPrice: 80, unitPrice: 65 })]);
    row = within(rowFor("Sample Cola 12oz"));
    expect(row.getByText("$80.00")).toHaveClass("strike");
    expect(row.getAllByText("$65.00")[0]).toHaveClass("text-amber-600");
  });

  it("MANUAL with no original price is just the plain price (no badge)", () => {
    renderTable([line({ priceType: "MANUAL", originalPrice: null })]);
    const row = within(rowFor("Sample Cola 12oz"));
    expect(row.queryByText("Adjusted")).toBeNull();
    expect(row.queryByText("Upsell")).toBeNull();
  });

  it("an order with no lines renders the header and footer only", () => {
    renderTable([], "CONFIRMED", 0);
    expect(screen.getByText("Order Total")).toBeInTheDocument();
    expect(screen.queryByText("Custom item")).toBeNull();
  });

  it("a cancelled line: struck-through name, dimmed row, an em dash instead of a total", () => {
    renderTable([line({ status: "CANCELLED" })]);
    const row = rowFor("Sample Cola 12oz");
    expect(row).toHaveClass("opacity-50");
    expect(screen.getByText("Sample Cola 12oz")).toHaveClass("line-through");
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(within(row).queryByText("$520.00")).toBeNull();
  });

  it("the status pill is derived from delivery data, not just the stored line status", () => {
    renderTable([line({ status: "PENDING", deliveredQty: 3, qty: 8 })], "OUT_FOR_DELIVERY");
    expect(within(rowFor("Sample Cola 12oz")).getByText("Partial")).toBeInTheDocument();
  });

  it("a line on a DELIVERED order with no per-line data reads Delivered", () => {
    renderTable([line({ status: "PENDING", deliveredQty: 0 })], "DELIVERED");
    expect(within(rowFor("Sample Cola 12oz")).getByText("Delivered")).toBeInTheDocument();
  });
});
