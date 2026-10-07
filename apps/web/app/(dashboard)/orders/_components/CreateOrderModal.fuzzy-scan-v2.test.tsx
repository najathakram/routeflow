import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * B1219: under scan_v2 the ScanOrderScreen owns the scan. A fuzzy suggestion resolved while it is
 * active must NOT leave a stale "Did you mean" picker behind in the (closed) modal Dialog.
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
  unit: "case",
  pricePerUnit: "30.00",
  unitsPerBox: 12,
  isActive: true,
};

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PLAIN, BOXED] } }),
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
let mockOrderUiV2 = true;
let mockScanV2 = true;
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

let capturedOnScan: ((code: string) => void) | undefined;
let capturedOpenContinuous: (() => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: {
    onScan: (code: string) => void;
    onOpenContinuous?: () => void;
    title?: string;
  }) => {
    capturedOnScan = props.onScan;
    capturedOpenContinuous = props.onOpenContinuous;
    return (
      <button type="button" title={props.title}>
        scan
      </button>
    );
  },
}));

// The continuous scan screen is mounted whenever scan_v2 is on; only its resolveCode prop matters here.
type ScanScreenResolve = (
  code: string,
  opts?: { quiet?: boolean; background?: boolean },
) => Promise<unknown>;
let capturedScanScreenResolve: ScanScreenResolve | undefined;
let capturedScanScreenClose: (() => void) | undefined;
jest.mock("./scan/ScanOrderScreen", () => ({
  ScanOrderScreen: (props: { resolveCode: ScanScreenResolve; onClose: () => void }) => {
    capturedScanScreenResolve = props.resolveCode;
    capturedScanScreenClose = props.onClose;
    return null;
  },
}));

const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

const FUZZY = { ...PLAIN, id: "p-fuzzy", name: "Cola Zero 12345", sku: "CZ-1" };

describe("scan_v2 - fuzzy suggestion while the scan screen is active (B1219)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("adds nothing and leaves no picker in the modal", async () => {
    mockResolveProductByCode.mockResolvedValue({
      product: FUZZY,
      source: "search",
      ambiguous: true,
      suggestion: true,
      matches: [FUZZY],
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    act(() => capturedOpenContinuous!());
    let res: any;
    await act(async () => {
      res = await capturedScanScreenResolve!("12345");
    });
    expect(res).toMatchObject({ kind: "suggested" });
    expect(screen.queryAllByTitle("Remove")).toHaveLength(0);
    // Closing the scan screen brings the Dialog back: no stale picker may be waiting in it.
    act(() => capturedScanScreenClose!());
    expect(await screen.findByPlaceholderText(/search by name/i)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
    expect(screen.queryAllByTitle("Remove")).toHaveLength(0);
  });
});
