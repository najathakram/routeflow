/**
 * SA-1097 A-6 item 6: the web readers show a stored split line at the pack it was SOLD in, never today's product pack. One row each
 * for the web mutants the reviews found no lane for: the cards, the table's unit-price note and its fallback money, the unit-label
 * gate, free units in the web read, and the locked line's badge. The product's pack is now 24 in every fixture.
 */
import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import type { OrderItem } from "@/lib/api/orders";
import { lineOwnPack } from "@/lib/line-own-pack";
import { renderWithProviders } from "@/test-utils/render";
import { OrderLineItemsTable } from "./_components/OrderLineItemsTable";
import { lineRowProps } from "./_components/OrderLineItemCards";
import { EditableLineItems, buildEditItemFromLine } from "./_components/order-line-edit";
import { PACK_LOCKED_COPY } from "./_components/unit-line-lock";

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));

const line = (over: Record<string, unknown> = {}): OrderItem =>
  ({
    id: "li-1",
    productId: "p-1",
    product: { id: "p-1", name: "Sample Cola 12oz", unit: "case", unitsPerBox: 24 },
    qty: 30,
    boxes: 2,
    pieces: 6,
    unitsPerBox: null,
    unitPrice: 12,
    priceType: "STANDARD",
    status: "PENDING",
    subtotal: 30, // 2 boxes + 6 pieces of a 12-pack at 12.00 a box
    ...over,
  }) as unknown as OrderItem;

const renderTable = (li: OrderItem) =>
  render(
    <OrderLineItemsTable lineItems={[li]} orderStatus="CONFIRMED" total={Number(li.subtotal)} />,
  );

describe("SA-1097 A-6: the order screens read a stored split line at its own pack", () => {
  it("W-cards (mutant: the cards read the live pack): a line sold at 12 shows pack 12, a no-pack line none, not today's 24", () => {
    expect(lineRowProps(line(), "CONFIRMED").unitsPerBox).toBe(12);
    expect(lineRowProps(line({ qty: 8, subtotal: 96 }), "CONFIRMED").unitsPerBox).toBeNull();
  });

  it("W-table-note (mutant: the table's price note reads the live pack): the 12-pack line says $1.00 each, not $0.50", () => {
    renderTable(line());
    const cell = within(screen.getByText("Sample Cola 12oz").closest("tr") as HTMLElement)
      .getByText("$12.00")
      .closest("td") as HTMLElement;
    expect(cell).toHaveTextContent("/ box");
    expect(cell).toHaveTextContent("$1.00 each");
    expect(cell).not.toHaveTextContent("$0.50 each");
  });

  it("W-table-note (no pack at sale): the 96.00 line is priced as plain units, so no per-piece price is shown", () => {
    renderTable(line({ qty: 8, subtotal: 96 }));
    const cell = within(screen.getByText("Sample Cola 12oz").closest("tr") as HTMLElement)
      .getByText("$12.00")
      .closest("td") as HTMLElement;
    expect(cell).not.toHaveTextContent("each");
  });

  it("W-table-money (mutant: the table's fallback money reads the live pack): a line with no stored subtotal totals at its own pack", () => {
    renderTable(line({ subtotal: null, unitsPerBox: 12 })); // a snapshot of 12 stands for the pack it was sold in
    expect(screen.getAllByText("$30.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("$27.00")).toBeNull();
  });
});

describe("SA-1097 A-6: the web's own-pack read", () => {
  it("W-label (mutant: the unit-label gate removed): a unit line is left to its label and snapshot, never re-read from its split", () => {
    const li = line({ qty: 6, boxes: 1, pieces: 0, unitLabel: "Case", subtotal: 12 });
    expect(lineOwnPack(li)).toEqual({ kind: "as-stored" });
  });

  it("W-free (mutant: free units dropped from the web read): a no-pack line of 10 with 2 free (80.00) reads as no pack, not unreadable", () => {
    const li = line({
      qty: 10,
      boxes: 10,
      pieces: 0,
      unitPrice: 10,
      subtotal: 80,
      promoFreeUnits: 2,
    });
    expect(lineOwnPack(li)).toEqual({ kind: "none" });
  });

  it("W-locked (mutant: a locked line shows the unit badge): an unreadable line shows the pack-locked text and not the unit 'needs repair' badge", () => {
    const li = line({ qty: 6, boxes: 0, pieces: 6, subtotal: 7 }); // 7.00 fits neither the 24-pack nor no pack
    const loaded = buildEditItemFromLine(li);
    renderWithProviders(
      <EditableLineItems
        items={[loaded]}
        onChange={() => {}}
        onAdd={() => {}}
        onDelete={() => {}}
        canEditPrice
        tierPriceFor={() => 10}
        isSpecialTierFor={() => false}
        tierForProductId={() => 1}
        pricingReady
      />,
    );
    expect(screen.getByText(PACK_LOCKED_COPY)).toBeInTheDocument();
    expect(screen.queryByText("This line needs repair")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
