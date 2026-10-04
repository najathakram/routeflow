/**
 * Order edit: every priced catalog line of EditableLineItems carries the customer price-history
 * button (beside "Unit price") when a customer is known - the real page passes `customer`.
 * Harness copied from unit-picker-mount.test.tsx.
 */
import * as React from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
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

function renderRows(items: EditItemState[], customer?: { id: string; name?: string | null }) {
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

  it("is disabled when the customer is not known yet, and absent for an unlisted line", () => {
    const { unmount } = renderRows([line()]);
    expect(screen.getByRole("button", { name: "Price history" })).toBeDisabled();
    unmount();
    renderRows([line({ isUnlisted: true, productId: "" })], { id: "c1" });
    expect(screen.queryByRole("button", { name: "Price history" })).not.toBeInTheDocument();
  });
});
