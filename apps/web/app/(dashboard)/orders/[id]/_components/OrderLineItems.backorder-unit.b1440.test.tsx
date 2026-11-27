import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { OrderItem } from "@/lib/api/orders";
import { lineRowProps } from "./OrderLineItemCards";
import { OrderLineItemsTable } from "./OrderLineItemsTable";
import { LineItemRowReadOnly } from "@/components/LineItemRowReadOnly";

/** REG-B1440: both renderers of an order's lines hand the tag the product's own unit, so a line sold in bags reads
 *  "Backorder · 3 bags", the word the order's line summary prints. */
function line(over: Record<string, unknown>): OrderItem {
  return {
    id: "li-1",
    productId: "p-1",
    product: { id: "p-1", name: "Sample Rice 5lb", unit: "bag" },
    qty: 3,
    unitPrice: 4,
    priceType: "STANDARD",
    status: "PENDING",
    subtotal: 12,
    backorderedPieces: "3",
    ...over,
  } as unknown as OrderItem;
}
const tag = () => screen.getByTestId("line-backorder-tag");

describe("REG-B1440: the backorder tag on an order line sold in bags", () => {
  it("table renderer: 'Backorder · 3 bags', never 'pcs'", () => {
    render(<OrderLineItemsTable lineItems={[line({})]} orderStatus="CONFIRMED" total={12} />);
    expect(tag()).toHaveTextContent("Backorder · 3 bags (0 in stock when ordered)");
    expect(tag()).toHaveAttribute("title", "3 bags sold past stock");
  });

  it("card renderer says the same", () => {
    const props = lineRowProps(line({}), "CONFIRMED");
    expect(props.backorderUnit).toBe("bag");
    render(<LineItemRowReadOnly {...props} />);
    expect(tag()).toHaveTextContent("Backorder · 3 bags (0 in stock when ordered)");
  });

  it("pin: a boxed line whose product unit is 'case' still counts boxes and pieces", () => {
    const boxed = line({
      product: { id: "p-1", name: "Sample Cola 12oz", unit: "case", unitsPerBox: 12 },
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      backorderedPieces: "24",
    });
    render(<OrderLineItemsTable lineItems={[boxed]} orderStatus="CONFIRMED" total={12} />);
    expect(tag()).toHaveTextContent("Backorder · 2 boxes");
  });

  it("pin: an 'each' product stays pcs on both renderers", () => {
    const each = line({ product: { id: "p-1", name: "Sample Cola 12oz", unit: "each" } });
    render(<OrderLineItemsTable lineItems={[each]} orderStatus="CONFIRMED" total={12} />);
    expect(tag()).toHaveTextContent("Backorder · 3 pcs");
  });
});
