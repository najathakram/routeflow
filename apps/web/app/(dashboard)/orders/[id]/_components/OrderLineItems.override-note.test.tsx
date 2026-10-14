import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrderLineItemsTable } from "./OrderLineItemsTable";
import { OrderLineItemCards } from "./OrderLineItemCards";

/** Row 510: a STAFF order's line sold despite a restriction says so, in both layouts; an ordinary line says nothing. */
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { id: "u-1", username: "pat" } }) },
}));

const line = (id: string, extra: object = {}) => ({
  id,
  productId: "p1",
  product: { id: "p1", name: "Widget", unit: "each", unitsPerBox: null },
  qty: 2,
  unitPrice: 5,
  subtotal: 10,
  status: "CONFIRMED",
  ...extra,
});
const stamped = line("li-1", {
  restrictionOverrideReason: "Owner approved the sale",
  restrictionOverrideBy: "u-1",
  restrictionOverrideAt: "2026-10-07T15:14:00.000Z",
  restrictionOverrideRuleIds: ["r1"],
});
const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

describe.each([
  [
    "table",
    (items: any[]) => <OrderLineItemsTable lineItems={items} orderStatus="PENDING" total={10} />,
  ],
  [
    "cards",
    (items: any[]) => <OrderLineItemCards lineItems={items} orderStatus="PENDING" total={10} />,
  ],
])("order lines (%s)", (_name, renderLines) => {
  it("shows the staff-only note on the overridden line only", async () => {
    render(wrap(renderLines([stamped, line("li-2")])));
    const note = await screen.findByText(
      /Sold despite restriction · Owner approved the sale · by pat/,
    );
    expect(note).toBeInTheDocument();
    expect(screen.getAllByTestId("restriction-override-note")).toHaveLength(1);
  });
  it("shows nothing on an ordinary line", () => {
    render(wrap(renderLines([line("li-2")])));
    expect(screen.queryByTestId("restriction-override-note")).toBeNull();
  });
});
