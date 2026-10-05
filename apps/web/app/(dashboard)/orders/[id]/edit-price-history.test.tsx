/**
 * Order edit: every priced catalog line of EditableLineItems carries the customer price-history
 * button (beside "Unit price") when a customer is known - the real page passes `customer`.
 * Harness copied from unit-picker-mount.test.tsx.
 */
import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./page";

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
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));

const line = (over: Partial<EditItemState> = {}): EditItemState => ({
  id: "li-1",
  originalProductId: "p-1",
  originalProductName: "Widget",
  originalQty: 3,
  productId: "p-1",
  productName: "Widget",
  qty: 3,
  unitPrice: 10,
  basePrice: 10,
  originalUnitPrice: 10,
  cancelled: false,
  unit: "each",
  unitsPerBox: null,
  boxSplit: false,
  priceType: "STANDARD",
  ...over,
});

function renderRows(
  items: EditItemState[],
  customer?: { id: string; name?: string | null },
  orderId?: string,
) {
  return renderWithProviders(
    <EditableLineItems
      items={items}
      onChange={() => {}}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice
      tierPriceFor={() => 10}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
      customer={customer}
      orderId={orderId}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({
    data: {
      customerId: "c1",
      customerName: "Acme Foods",
      productId: "p-1",
      productName: "Widget",
      costVisible: false,
      rows: [
        {
          date: "2026-09-20T00:00:00.000Z",
          source: "INVOICE",
          unitPrice: 9,
          unitLabel: "each",
          unitsPerBox: null,
          qty: 4,
          boxes: null,
          pieces: null,
          avgCostAtSale: null,
          invoiceId: "inv-1",
          invoiceNumber: "INV-0001",
          orderId: "ord-1",
          orderNumber: "ORD-0001",
          priceType: null,
        },
      ],
      summaries: [
        { unitLabel: "each", last: 9, low: 9, high: 9, qtySold: 4, currentAvgCost: null },
      ],
    },
  });
});

describe("order edit page - price history button", () => {
  it("shows beside Unit price for a catalog line and opens the panel for this customer", async () => {
    renderRows([line()], { id: "c1", name: "Acme Foods" });
    const btn = screen.getByRole("button", { name: "Price history" });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    const panel = await screen.findByRole("dialog", { name: "Price history" });
    expect(await within(panel).findByText("Customer: Acme Foods")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/customers/c1/products/p-1/price-history", {
      params: { limit: 25 },
    });
  });

  it("hunt2 F6: the edited order is left out of its own history (excludeOrderId)", async () => {
    renderRows([line()], { id: "c1", name: "Acme Foods" }, "ord-edit");
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    await screen.findByRole("dialog", { name: "Price history" });
    expect(mockGet).toHaveBeenCalledWith("/customers/c1/products/p-1/price-history", {
      params: { limit: 25, excludeOrderId: "ord-edit" },
    });
  });

  it("hunt2 F6 wiring: the order page hands EditableLineItems the order's own id", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    const call = src.slice(
      src.indexOf("<EditableLineItems"),
      src.indexOf("/>", src.indexOf("<EditableLineItems")),
    );
    expect(call).toContain("orderId={order.id}");
  });

  it("is disabled when the customer is not known yet, and absent for an unlisted line", () => {
    const { unmount } = renderRows([line()]);
    expect(screen.getByRole("button", { name: "Price history" })).toBeDisabled();
    unmount();
    renderRows([line({ isUnlisted: true, productId: "" })], { id: "c1" });
    expect(screen.queryByRole("button", { name: "Price history" })).not.toBeInTheDocument();
  });
  it("an outside click on another line's input closes the panel and leaves focus on that input", async () => {
    renderRows(
      [
        line(),
        line({ id: "li-2", originalProductId: "p-2", productId: "p-2", productName: "Gadget" }),
      ],
      { id: "c1", name: "Acme Foods" },
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Price history" })[0]!);
    await screen.findByRole("dialog", { name: "Price history" });
    const other = screen.getAllByRole("spinbutton")[screen.getAllByRole("spinbutton").length - 1]!;
    await user.click(other);
    expect(screen.queryByRole("dialog", { name: "Price history" })).not.toBeInTheDocument();
    // The close used to refocus the trigger on a deferred tick, stealing focus from the click target.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(other).toHaveFocus();
  });
});
