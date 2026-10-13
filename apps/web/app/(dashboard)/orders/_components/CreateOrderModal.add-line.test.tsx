import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * Quick-order extras (LANE-S step 10): adding a product that is already on the order MERGES into
 * that line (never a duplicate), announces it with a toast, and honours a typed "Qty". A camera
 * scan stays +1. Kept in its own file — Lane S-scan owns CreateOrderModal.test.tsx's scan coverage.
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
let mockScanV2 = false;
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
jest.mock("./scan/ScanOrderScreen", () => ({
  ScanOrderScreen: (props: { resolveCode: ScanScreenResolve }) => {
    capturedScanScreenResolve = props.resolveCode;
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

const search = () => screen.getByPlaceholderText(/search by name, sku or scan barcode/i);
/** A plain (non-boxed) line's qty — the row's tap-to-type qty input (#2696), else the old readout. */
const unitsOf = (name: string) =>
  (lineFor(name).querySelector('input[aria-label="Quantity"]') as HTMLInputElement | null)?.value ??
  lineFor(name).querySelector("span.w-8.text-center")?.textContent ??
  "";

async function pick(name: string) {
  fireEvent.change(search(), { target: { value: name.split(" ")[1].toLowerCase() } });
  const row = await screen.findByRole("option", { name: new RegExp(name, "i") });
  fireEvent.click(row);
}

/** The line item's <li> in the order (not a dropdown row). */
const lineFor = (name: string) =>
  screen
    .getAllByText(name)
    .map((el) => el.closest("li"))
    .find((li) => li?.querySelector('[title="Remove"]')) as HTMLElement;

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnScan = undefined;
});

// #2696 (owner): the quick-order "Qty" box is gone — every pick / scan adds ONE (one case for a
// case-packed product) and a repeat merges +1. The line's own qty is tap-to-type instead.
describe("adding a product — one per pick, merging (#2696; was LANE-S step 10's typed Qty)", () => {
  it("there is no quick-add Qty field next to the search", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await screen.findByPlaceholderText(/search by name, sku or scan barcode/i);
    expect(screen.queryByLabelText("Quantity to add")).not.toBeInTheDocument();
  });

  it("a new plain product starts at 1, and a first add is not a merge", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(unitsOf("Sample Cola")).toBe("1");
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("adding the same product again MERGES +1 into one line and says so", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await pick("Sample Cola");
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Added to existing line",
          description: "Sample Cola — now 2",
        }),
      ),
    );
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
    expect(unitsOf("Sample Cola")).toBe("2");
  });

  it("REG: a repeat pick on a case-packed line adds a whole CASE; no loose units appear", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Chips");
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    expect((screen.getByTitle("Number of whole boxes") as HTMLInputElement).value).toBe("1");

    await pick("Sample Chips"); // +1 case
    await waitFor(() =>
      expect((screen.getByTitle("Number of whole boxes") as HTMLInputElement).value).toBe("2"),
    );
    // #2696 (d): loose units are opt-in — no field until "+ pieces" is tapped.
    expect(screen.queryByLabelText("Extra pieces")).not.toBeInTheDocument();
    expect(lineFor("Sample Chips").textContent).toContain("24 pcs total"); // 2 x 12
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Sample Chips — now 2 boxes" }),
    );
  });
});

describe("the scan paths add one", () => {
  it("Enter on a typed code adds 1", async () => {
    mockResolveProductByCode.mockResolvedValue({
      notFound: false,
      archived: false,
      product: PLAIN,
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(search(), { target: { value: "100200300" } });
    fireEvent.keyDown(search(), { key: "Enter" });

    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(mockResolveProductByCode).toHaveBeenCalledWith("100200300");
    expect(unitsOf("Sample Cola")).toBe("1");
  });

  it("a repeated scan of the same code merges +1 and toasts", async () => {
    mockResolveProductByCode.mockResolvedValue({
      notFound: false,
      archived: false,
      product: PLAIN,
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await act(async () => {
      capturedOnScan!("100200300");
    });
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await act(async () => {
      capturedOnScan!("100200300");
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Added to existing line",
          description: "Sample Cola — now 2",
        }),
      ),
    );
  });
});

describe("the scan screen (Opus F1)", () => {
  afterEach(() => {
    mockScanV2 = false;
  });

  it("a scan-screen scan adds 1 and reports a created line (so Undo removes the whole line)", async () => {
    mockScanV2 = true;
    mockResolveProductByCode.mockResolvedValue({
      notFound: false,
      archived: false,
      product: PLAIN,
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    let res: any;
    await act(async () => {
      res = await capturedScanScreenResolve!("100200300", { quiet: true, background: true });
    });
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(unitsOf("Sample Cola")).toBe("1");
    expect(res).toMatchObject({ created: true });
  });

  it("a repeat scan on the scan screen does not toast", async () => {
    mockScanV2 = true;
    mockResolveProductByCode.mockResolvedValue({
      notFound: false,
      archived: false,
      product: PLAIN,
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    act(() => capturedOpenContinuous!());
    let first: any;
    let second: any;
    await act(async () => {
      first = await capturedScanScreenResolve!("100200300");
    });
    await act(async () => {
      second = await capturedScanScreenResolve!("100200300");
    });
    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({ created: false });
    expect(mockToast).not.toHaveBeenCalled();
  });
});

describe("order_ui_v2 OFF — the modal is what it was (LANE-S step 10)", () => {
  beforeEach(() => {
    mockOrderUiV2 = false;
  });
  afterEach(() => {
    mockOrderUiV2 = true;
  });

  it("has no Qty field", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await screen.findByPlaceholderText(/search by name, sku or scan barcode/i);
    expect(screen.queryByLabelText("Quantity to add")).not.toBeInTheDocument();
  });

  it("a repeat add keeps its historical +1 qty and says nothing", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await pick("Sample Cola");
    await waitFor(() => expect(unitsOf("Sample Cola")).toBe("2"));
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("a repeat add on a case-packed line is the historical +1 unit, not a whole extra case", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Chips");
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    await pick("Sample Chips");
    await waitFor(() => expect(lineFor("Sample Chips").textContent).toContain("13 pcs total"));
    expect(mockToast).not.toHaveBeenCalled();
  });
});
