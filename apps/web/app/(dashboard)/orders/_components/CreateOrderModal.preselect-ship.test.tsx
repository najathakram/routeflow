import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * B1210: the order builder honours `initialFulfillPath="SHIP"` (the orders page passes it for ?preselect=SHIP) on a FRESH open.
 * A resumed draft keeps its own fulfillPath (hydration wins), so the prop only seeds a new order.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const PLAIN = {
  id: "p-plain",
  name: "Sample Cola",
  sku: "100200300",
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
};
const BOXED = {
  id: "p-boxed",
  name: "Sample Chips",
  sku: "400500600",
  unitSku: "400500601",
  unit: "case",
  pricePerUnit: "30.00",
  unitsPerBox: 12,
  isActive: true,
};

const UPB_ONE = { ...PLAIN, id: "p-upb1", name: "Sample Soda", sku: "700800900", unitsPerBox: 1 };
const UPB_NULL = {
  ...PLAIN,
  id: "p-upbnull",
  name: "Sample Juice",
  sku: "111222333",
  unitsPerBox: null,
};

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PLAIN, BOXED, UPB_ONE, UPB_NULL] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
// order_ui_v2 is the gate for every behaviour under test (dark by default); scan_v2 stays off.
const mockOrderUiV2 = true;
const mockScanV2 = false;
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useOrderUiV2: () => ({ enabled: mockOrderUiV2, resolved: true }),
  useScanV2: () => mockScanV2,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => <button type="button">scan</button>,
}));
jest.mock("./scan/ScanOrderScreen", () => ({ ScanOrderScreen: () => null }));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

const SHIP_NOTE = /Ships via carrier/;

describe("CreateOrderModal initialFulfillPath", () => {
  it("SHIP: a fresh builder opens with Ship via carrier on", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} initialFulfillPath="SHIP" />);
    expect(await screen.findByText(SHIP_NOTE)).toBeInTheDocument();
  });

  it("absent: the builder keeps its route default (no ship note)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await screen.findByRole("button", { name: /Ship via carrier/ });
    expect(screen.queryByText(SHIP_NOTE)).toBeNull();
  });
});
