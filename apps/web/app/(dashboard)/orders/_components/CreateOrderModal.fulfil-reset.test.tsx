import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * W20-L1: the open-time reset must leave fulfillPath UNSET unless the page forces SHIP on a fresh open, so an
 * account whose staffDefault is SHIP (formDefault) starts on SHIP and one without it is not forced anywhere.
 *
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

let caps: Record<string, unknown> | undefined;
let draftData: unknown;
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: caps ? { capabilities: { fulfilment: caps } } : undefined,
    isError: false,
    refetch: jest.fn(),
  }),
}));
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
  useDraft: () => ({ data: draftData, isFetching: false }),
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
const capsWith = (staffDefault: "ROUTE" | "SHIP") => ({
  methods: ["ROUTE", "SHIP"],
  staffDefault,
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: true,
  staffOpensAs: "order",
  consistent: true,
});

beforeEach(() => {
  caps = capsWith("ROUTE");
  draftData = undefined;
});

describe("CreateOrderModal open-time fulfillPath reset (W20-L1)", () => {
  it("fresh open with initialFulfillPath SHIP: SHIP even when the account default is ROUTE", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} initialFulfillPath="SHIP" />);
    expect(await screen.findByText(SHIP_NOTE)).toBeInTheDocument();
  });

  it("resuming a draft with initialFulfillPath SHIP: the draft's own path wins, SHIP is not forced", async () => {
    caps = capsWith("SHIP");
    draftData = { id: "d1", payload: { fulfillPath: "ROUTE", lineItems: [] } };
    renderWithProviders(
      <CreateOrderModal isOpen onClose={jest.fn()} initialFulfillPath="SHIP" resumeDraftId="d1" />,
    );
    await screen.findByRole("button", { name: /Ship via carrier/ });
    expect(screen.queryByText(SHIP_NOTE)).toBeNull();
  });

  it("no initialFulfillPath on a SHIP-default account: formDefault applies (SHIP)", async () => {
    caps = capsWith("SHIP");
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(await screen.findByText(SHIP_NOTE)).toBeInTheDocument();
  });

  it("no initialFulfillPath on a ROUTE-default account: no ship note", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await screen.findByRole("button", { name: /Ship via carrier/ });
    expect(screen.queryByText(SHIP_NOTE)).toBeNull();
  });
});
