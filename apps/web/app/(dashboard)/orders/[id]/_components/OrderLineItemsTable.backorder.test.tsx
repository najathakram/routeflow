import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { OrderItem } from "@/lib/api/orders";
import { lineRowProps } from "./OrderLineItemCards";
import { OrderLineItemsTable } from "./OrderLineItemsTable";
import { LineItemRowReadOnly } from "@/components/LineItemRowReadOnly";

/** SA-714 R1: the staff "Backorder" tag on order-detail lines (table and card renderers). */
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
const table = (li: OrderItem, status = "CONFIRMED") =>
  render(<OrderLineItemsTable lineItems={[li]} orderStatus={status} total={520} />);

describe("Backorder tag, table renderer", () => {
  it("shows on a live order's line carrying backordered pieces (Decimal string)", () => {
    table(line({ backorderedPieces: "3" }));
    expect(screen.getByTestId("line-backorder-tag")).toHaveTextContent("Backorder");
    expect(screen.getByTestId("line-backorder-tag")).toHaveAttribute(
      "title",
      "3 pcs sold past stock",
    );
  });
  it("is absent at 0, absent on legacy rows, absent on a cancelled line or a cancelled/delivered order", () => {
    table(line({ backorderedPieces: "0" }));
    expect(screen.queryByTestId("line-backorder-tag")).toBeNull();
  });
  it("legacy row without the field", () => {
    table(line({}));
    expect(screen.queryByTestId("line-backorder-tag")).toBeNull();
  });
  it("cancelled line", () => {
    table(line({ backorderedPieces: "3", status: "CANCELLED" }));
    expect(screen.queryByTestId("line-backorder-tag")).toBeNull();
  });
  it.each(["CANCELLED", "DELIVERED", "DRAFT"])("%s order", (s) => {
    table(line({ backorderedPieces: "3" }), s);
    expect(screen.queryByTestId("line-backorder-tag")).toBeNull();
  });
});

describe("Backorder tag, card renderer", () => {
  it("lineRowProps carries the pieces for a live order and the row renders the tag", () => {
    const props = lineRowProps(line({ backorderedPieces: "3" }), "PENDING");
    expect(props.backorderPieces).toBe(3);
    render(<LineItemRowReadOnly {...props} />);
    expect(screen.getByTestId("line-backorder-tag")).toHaveTextContent("Backorder");
  });
  it("a cancelled order carries none", () => {
    expect(lineRowProps(line({ backorderedPieces: "3" }), "CANCELLED").backorderPieces).toBe(0);
  });
});
