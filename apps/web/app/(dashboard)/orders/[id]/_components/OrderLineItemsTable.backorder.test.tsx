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

describe("F02 / F30: the reason is visible text, not hover-only", () => {
  it("table renderer: 'Backorder · 3 pcs'", () => {
    table(line({ backorderedPieces: "3" }));
    expect(screen.getByTestId("line-backorder-tag")).toHaveTextContent("Backorder · 3 pcs");
  });
  it("card renderer says the same", () => {
    render(<LineItemRowReadOnly {...lineRowProps(line({ backorderedPieces: "3" }), "PENDING")} />);
    expect(screen.getByTestId("line-backorder-tag")).toHaveTextContent("Backorder · 3 pcs");
  });
  it("one piece reads singular", () => {
    table(line({ backorderedPieces: "1" }));
    expect(screen.getByTestId("line-backorder-tag")).toHaveTextContent("Backorder · 1 pc");
  });
});

/** R3 Q17 / F14 (L-332): the pill reads in the unit the line was sold in, on its own no-wrap line. */
describe("R3: backorder pill in the line's own unit, on its own line", () => {
  const caseLine = (over: Record<string, unknown> = {}) =>
    line({
      boxes: 2,
      pieces: 0,
      qty: 24,
      unitsPerBox: 12,
      unitLabel: "Case",
      backorderedPieces: "24",
      ...over,
    });

  it("a case line says cases, not the pieces behind them (table)", () => {
    table(caseLine());
    expect(screen.getByTestId("line-backorder-tag")).toHaveTextContent(/^Backorder · 2 cases$/);
  });
  it("a case line says cases (card renderer)", () => {
    render(<LineItemRowReadOnly {...lineRowProps(caseLine(), "PENDING")} />);
    expect(screen.getByTestId("line-backorder-tag")).toHaveTextContent(/^Backorder · 2 cases$/);
  });
  it("the meaning is visible text beside the pill, not only a hover title (table)", () => {
    table(caseLine());
    expect(screen.getByText("Ships when stock arrives")).toBeVisible();
  });
  it("the meaning is visible text beside the pill (card renderer)", () => {
    render(<LineItemRowReadOnly {...lineRowProps(caseLine(), "PENDING")} />);
    expect(screen.getByText("Ships when stock arrives")).toBeVisible();
  });
  it("the hover title also reads in cases", () => {
    table(caseLine());
    expect(screen.getByTestId("line-backorder-tag")).toHaveAttribute(
      "title",
      "2 cases sold past stock",
    );
  });
  it("the pill never wraps and sits on its own line under the name, not inside it", () => {
    table(caseLine());
    const pill = screen.getByTestId("line-backorder-tag");
    expect(pill).toHaveClass("whitespace-nowrap");
    const name = screen.getByText("Sample Cola 12oz");
    expect(name.contains(pill)).toBe(false);
    expect(pill.parentElement).not.toBe(name.parentElement);
    expect(pill.parentElement).toHaveClass("flex");
    expect(name.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("no pill, no hint, when nothing is backordered", () => {
    table(caseLine({ backorderedPieces: "0" }));
    expect(screen.queryByText("Ships when stock arrives")).toBeNull();
  });
});
