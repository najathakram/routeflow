import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { componentSubLineText } from "@routeflow/pricing";
import { OrderLineItemsTable } from "./OrderLineItemsTable";
import type { OrderItem } from "@/lib/api/orders";

/**
 * SA-593e (M3 fold 1): the staff order detail's read-only table (the DEFAULT renderer) prints a
 * composed line's sub-lines through the ONE shared ComponentSubLines. Selected by testid (L-212).
 */
const comp = (id: string, name: string, position: number) => ({
  componentProductId: id,
  name,
  qty: 24,
  unitSku: `SKU-${id}`,
  unitBarcode: null,
  barcodeSymbology: null,
  displayUnitPrice4: 1.25,
  position,
});
const line = (id: string, extra: object = {}) =>
  ({
    id,
    productId: `p-${id}`,
    product: { id: `p-${id}`, name: `Product ${id}`, unit: "Box", unitsPerBox: 24 },
    qty: 48,
    boxes: 2,
    pieces: 0,
    unitsPerBox: 24,
    unitPrice: 30,
    subtotal: 60,
    status: "CONFIRMED",
    ...extra,
  }) as unknown as OrderItem;

describe("OrderLineItemsTable sub-lines", () => {
  const items = [
    line("composed", { components: [comp("a", "Almond", 0), comp("o", "Oat", 1)] }),
    line("plain"),
  ];

  it("renders one sub-line per component, under the composed line's row only", () => {
    render(<OrderLineItemsTable lineItems={items} orderStatus="CONFIRMED" total={120} />);
    const all = screen.getAllByTestId("line-component-sub-line");
    expect(all).toHaveLength(2);
    expect(all[0].textContent).toBe(
      componentSubLineText({ name: "Almond", qty: 24, unitSku: "SKU-a", displayUnitPrice4: 1.25 }),
    );
    expect(all[1].textContent).toBe(
      componentSubLineText({ name: "Oat", qty: 24, unitSku: "SKU-o", displayUnitPrice4: 1.25 }),
    );
    const rows = screen.getAllByRole("row");
    const composedRow = rows.find((r) => r.textContent?.includes("Product composed"))!;
    const plainRow = rows.find((r) => r.textContent?.includes("Product plain"))!;
    expect(within(composedRow).getAllByTestId("line-component-sub-line")).toHaveLength(2);
    expect(within(plainRow).queryByTestId("line-component-sub-line")).toBeNull();
  });

  it("a plain line renders none, and the totals row is unchanged", () => {
    render(<OrderLineItemsTable lineItems={[line("plain")]} orderStatus="CONFIRMED" total={60} />);
    expect(screen.queryByTestId("line-component-sub-line")).toBeNull();
    expect(screen.getByText("Order Total")).toBeInTheDocument();
  });
});
