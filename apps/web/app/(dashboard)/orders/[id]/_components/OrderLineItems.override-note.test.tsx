import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { OrderLineItemsTable } from "./OrderLineItemsTable";
import { OrderLineItemCards } from "./OrderLineItemCards";

/** Row 510: a STAFF order's line sold despite a restriction says so, in both layouts; an ordinary line says nothing. */
const line = (id: string, extra: object = {}, name = "Widget") => ({
  id,
  productId: `p-${id}`,
  product: { id: `p-${id}`, name, unit: "each", unitsPerBox: null },
  qty: 2,
  unitPrice: 5,
  subtotal: 10,
  status: "CONFIRMED",
  ...extra,
});
const stamped = line("li-1", {
  restrictionOverrideReason: "Owner approved the sale",
  restrictionOverrideBy: "u-1",
  restrictionOverrideByName: "pat",
  restrictionOverrideAt: "2026-10-07T15:14:00.000Z",
  restrictionOverrideRuleIds: ["r1"],
});

describe.each([
  [
    "table",
    "tr",
    (items: any[]) => <OrderLineItemsTable lineItems={items} orderStatus="PENDING" total={10} />,
  ],
  [
    "cards",
    "li",
    (items: any[]) => <OrderLineItemCards lineItems={items} orderStatus="PENDING" total={10} />,
  ],
])("order lines (%s)", (_name, rowTag, renderLines) => {
  const plain = line("li-2", {}, "Gadget");
  /** The row of the line whose product name is `name`. */
  const rowOf = (name: string): HTMLElement => {
    const row = screen.getByText(name).closest(rowTag as string);
    expect(row).not.toBeNull();
    return row as HTMLElement;
  };

  it("shows the staff-only note on the overridden line only", async () => {
    render(renderLines([stamped, plain]));
    const note = await screen.findByText(
      /Sold despite restriction · Owner approved the sale · by pat/,
    );
    expect(note).toBeInTheDocument();
    expect(screen.getAllByTestId("restriction-override-note")).toHaveLength(1);
  });

  it("renders the note INSIDE its own line's row, not in the other line's and not as a block under the list", () => {
    render(renderLines([stamped, plain]));
    expect(
      within(rowOf("Widget")).getByText(/Sold despite restriction · Owner approved the sale/),
    ).toBeInTheDocument();
    expect(within(rowOf("Gadget")).queryByTestId("restriction-override-note")).toBeNull();
    // the note is a descendant of the line's own row element, so it can not sit between rows
    expect(rowOf("Widget").contains(screen.getByTestId("restriction-override-note"))).toBe(true);
  });

  it("the order of the lines does not move the note: it follows its line", () => {
    render(renderLines([plain, stamped]));
    expect(within(rowOf("Widget")).getByTestId("restriction-override-note")).toBeInTheDocument();
    expect(within(rowOf("Gadget")).queryByTestId("restriction-override-note")).toBeNull();
  });

  it("shows nothing on an ordinary line", () => {
    render(renderLines([plain]));
    expect(screen.queryByTestId("restriction-override-note")).toBeNull();
  });
});

describe("cards layout: the note adds no row of its own", () => {
  it("N lines are N list items, stamped or not", () => {
    const { container } = render(
      <OrderLineItemCards
        lineItems={[stamped, line("li-2", {}, "Gadget")] as any}
        orderStatus="PENDING"
        total={10}
      />,
    );
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
  });
});
