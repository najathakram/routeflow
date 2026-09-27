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
/** A plain (non-boxed) line's qty — the stepper's own readout, not the row's text (which holds "$2.50"). */
const unitsOf = (name: string) =>
  lineFor(name).querySelector("span.w-8.text-center")?.textContent ?? "";
const qtyField = () => screen.getByLabelText("Quantity to add") as HTMLInputElement;

async function pick(name: string, qty?: string) {
  if (qty !== undefined) fireEvent.change(qtyField(), { target: { value: qty } });
  fireEvent.change(search(), { target: { value: name.split(" ")[1].toLowerCase() } });
  const row = await screen.findByRole("button", { name: new RegExp(name, "i") });
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

describe("adding a product — typed Qty and merging (LANE-S step 10)", () => {
  it("a new plain product starts at the typed qty, then the field resets to 1", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola", "3");
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(unitsOf("Sample Cola")).toBe("3");
    expect(qtyField().value).toBe("1");
    expect(mockToast).not.toHaveBeenCalled(); // a first add is not a merge
  });

  it("adding the same product again MERGES into one line (sum) and says so", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola", "3");
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await pick("Sample Cola", "2");

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Added to existing line",
          description: "Sample Cola — now 5",
        }),
      ),
    );
    // still exactly one line for the product
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
    expect(unitsOf("Sample Cola")).toBe("5");
  });

  it("a plain repeat pick (Qty left at 1) is +1", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await pick("Sample Cola");
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Sample Cola — now 2" }),
      ),
    );
  });

  it("REG: merging into a case-packed line adds CASES and keeps boxes / pieces / qty consistent", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Chips", "2");
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    expect((screen.getByTitle("Number of whole cases") as HTMLInputElement).value).toBe("2");

    await pick("Sample Chips"); // +1 case
    await waitFor(() =>
      expect((screen.getByTitle("Number of whole cases") as HTMLInputElement).value).toBe("3"),
    );
    expect(
      (screen.getByTitle("Extra loose units (less than a full case)") as HTMLInputElement).value,
    ).toBe("0");
    expect(lineFor("Sample Chips").textContent).toContain("36 pcs total"); // 3 x 12
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Sample Chips — now 3 cases" }),
    );
  });

  it("junk in the Qty field adds one, never zero or a negative", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola", "");
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await pick("Sample Cola", "-5");
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Sample Cola — now 2" }),
      ),
    );
  });
});

describe("typed Qty and the scan paths", () => {
  it("Enter on a typed code applies the typed qty", async () => {
    mockResolveProductByCode.mockResolvedValue({
      notFound: false,
      archived: false,
      product: PLAIN,
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(qtyField(), { target: { value: "4" } });
    fireEvent.change(search(), { target: { value: "100200300" } });
    fireEvent.keyDown(search(), { key: "Enter" });

    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(mockResolveProductByCode).toHaveBeenCalledWith("100200300");
    expect(unitsOf("Sample Cola")).toBe("4");
  });

  it("a camera scan is always +1 — it never inherits a qty typed for an Enter that added nothing", async () => {
    mockResolveProductByCode
      // Enter resolves to an ARCHIVED product: error toast, nothing added — the typed qty is left
      // behind unless the camera path clears it.
      .mockResolvedValueOnce({ notFound: false, archived: true, product: PLAIN })
      .mockResolvedValueOnce({ notFound: false, archived: false, product: PLAIN }); // then a scan hits
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(qtyField(), { target: { value: "9" } });
    fireEvent.change(search(), { target: { value: "999999999999" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledTimes(1));

    await act(async () => {
      capturedOnScan!("100200300");
    });
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(unitsOf("Sample Cola")).toBe("1");
    // ...and the scan did not consume or wipe what the operator typed
    expect(qtyField().value).toBe("9");
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

describe("typed Qty and the scan screen (Opus F1)", () => {
  afterEach(() => {
    mockScanV2 = false;
  });

  it("a qty typed for an Enter that added nothing never rides into a scan-screen scan", async () => {
    mockScanV2 = true;
    mockResolveProductByCode
      .mockResolvedValueOnce({ notFound: false, archived: true, product: PLAIN })
      .mockResolvedValueOnce({ notFound: false, archived: false, product: PLAIN });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(qtyField(), { target: { value: "9" } });
    fireEvent.change(search(), { target: { value: "999999999999" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledTimes(1));

    let res: any;
    await act(async () => {
      res = await capturedScanScreenResolve!("100200300");
    });
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(unitsOf("Sample Cola")).toBe("1"); // +1, not 9
    expect(res).toMatchObject({ created: true }); // so the screen's Undo removes the whole line
  });

  it("a qty typed for an Enter that added nothing never rides into a background retry either (B595 supersede)", async () => {
    mockScanV2 = true;
    mockResolveProductByCode
      .mockResolvedValueOnce({ notFound: false, archived: true, product: PLAIN }) // the live Enter adds nothing
      .mockResolvedValueOnce({ notFound: false, archived: false, product: PLAIN }); // the retry's own lookup
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(qtyField(), { target: { value: "9" } });
    fireEvent.change(search(), { target: { value: "999999999999" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledTimes(1));

    // The poor-signal queue calls resolveCode again quiet-AND-background, exactly like a retry of
    // a different queued code: opts must still pass through to the real handler, and the stale
    // typed qty from the Enter above must not ride into it.
    let res: any;
    await act(async () => {
      res = await capturedScanScreenResolve!("100200300", { quiet: true, background: true });
    });
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(unitsOf("Sample Cola")).toBe("1"); // +1, not the stale typed 9
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
    // the second scan really hit the merge path (not a fresh line) and stayed silent
    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({ created: false });
    expect(mockToast).not.toHaveBeenCalled();
  });
});

describe("typed Qty does not outlive the builder session", () => {
  const archivedThenPlain = () =>
    mockResolveProductByCode
      .mockResolvedValueOnce({ notFound: false, archived: true, product: PLAIN })
      .mockResolvedValue({ notFound: false, archived: false, product: PLAIN });

  it("REG: a qty typed for an Enter that added nothing is gone after close -> reopen", async () => {
    archivedThenPlain();
    const { rerender } = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(qtyField(), { target: { value: "7" } });
    fireEvent.change(search(), { target: { value: "100200300" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledTimes(1));
    expect(qtyField().value).toBe("7"); // nothing added, nothing consumed

    rerender(<CreateOrderModal isOpen={false} onClose={jest.fn()} />);
    rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(qtyField().value).toBe("1");
  });

  it("REG: a stale Enter qty cannot leak into the deep-link scan that reopens the builder", async () => {
    archivedThenPlain();
    const { rerender } = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(qtyField(), { target: { value: "7" } });
    fireEvent.change(search(), { target: { value: "100200300" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledTimes(1));

    rerender(<CreateOrderModal isOpen={false} onClose={jest.fn()} />);
    rerender(<CreateOrderModal isOpen onClose={jest.fn()} initialScanCode="100200300" />);

    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(lineFor("Sample Cola").textContent).not.toContain("7");
  });

  it("Enter inside the Qty field commits it and returns to the product search", () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    qtyField().focus();
    fireEvent.change(qtyField(), { target: { value: "5" } });
    fireEvent.keyDown(qtyField(), { key: "Enter" });
    expect(document.activeElement).toBe(search());
    expect(qtyField().value).toBe("5");
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
