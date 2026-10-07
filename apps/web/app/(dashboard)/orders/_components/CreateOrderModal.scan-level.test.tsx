import * as React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * #2717 M4a-1 (SA-580 R1/R2/R4, web): what a scan LANDS on the order depends on the LEVEL of the code
 * scanned, never on the line's mode. Scans reach the modal through BarcodeScannerButton.onScan ->
 * useScanCodeHandler -> addLineItem(product, level).
 *
 * RED (M4a-1): addLineItem ignores a level today (a scan of any code adds a whole case), so the
 * unit-level cases fail on the wrong line shape (1 case instead of 0 cases + 1 loose piece).
 * Unit-mode existing lines (sellBy "unit") are not set up here: the modal has no non-UI seam for it;
 * the playwright skeleton (e2e/48-scan-level.spec.ts) covers a unit-mode line on a real page.
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
let capturedScanScreenLines: Array<{ boxes?: number; pieces?: number; qty: number }> = [];
jest.mock("./scan/ScanOrderScreen", () => ({
  ScanOrderScreen: (props: {
    resolveCode: ScanScreenResolve;
    lines: Array<{ boxes?: number; pieces?: number; qty: number }>;
  }) => {
    capturedScanScreenResolve = props.resolveCode;
    capturedScanScreenLines = props.lines;
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

const casesInput = () => screen.getByTitle("Number of whole boxes") as HTMLInputElement;
const looseInput = () => screen.queryByLabelText("Extra pieces") as HTMLInputElement | null;
/** The line item's <li> in the order (not a dropdown row). */
const lineFor = (name: string) =>
  screen
    .getAllByText(name)
    .map((el) => el.closest("li"))
    .find((li) => li?.querySelector('[title="Remove"]')) as HTMLElement;
const plainQty = () =>
  (lineFor("Sample Cola").querySelector('input[aria-label="Quantity"]') as HTMLInputElement | null)
    ?.value ?? lineFor("Sample Cola").querySelector("span.w-8.text-center")?.textContent;

type Level = "BOX" | "UNIT";
/** Scan `code` whose server scanMatch says it has `levels` on `product`. */
async function scan(product: any, code: string, levels?: Level[]) {
  mockResolveProductByCode.mockResolvedValue({
    notFound: false,
    archived: false,
    product: levels ? { ...product, scanMatch: { code, levels } } : product,
  });
  await act(async () => {
    capturedOnScan!(code);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnScan = undefined;
  capturedScanScreenLines = [];
  mockOrderUiV2 = true;
  mockScanV2 = false;
});

describe("R1: a UNIT code adds one PIECE — never a hidden case", () => {
  it("UNIT on a boxed product, new line -> {boxes 0, pieces 1, qty 1}, and the loose piece is VISIBLE on the line", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await scan(BOXED, "UNITCODE", ["UNIT"]);
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    expect(casesInput().value).toBe("0");
    expect(looseInput()?.value).toBe("1"); // no hidden quantity: the line states boxes AND pieces
    expect(lineFor("Sample Chips").textContent).toContain("1 pcs total");
  });

  it("UNIT onto an existing case line -> 1 case + 1 loose on the ONE line (qty 13), and the merge toast says both", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await scan(BOXED, "BOXCODE", ["BOX"]);
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    await scan(BOXED, "UNITCODE", ["UNIT"]);
    await waitFor(() => expect(looseInput()?.value).toBe("1"));
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
    expect(casesInput().value).toBe("1");
    expect(lineFor("Sample Chips").textContent).toContain("13 pcs total");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringMatching(/1 box.*1 (pc|unit)/i) }),
    );
  });

  it("the 12th piece rolls over via normalizeBoxesPieces: 1 case + 11 loose, then one more UNIT -> 2 cases + 0 loose (qty 24)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await scan(BOXED, "BOXCODE", ["BOX"]);
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await scan(BOXED, "UNITCODE", ["UNIT"]);
    }
    await waitFor(() => expect(casesInput().value).toBe("2"));
    expect(lineFor("Sample Chips").textContent).toContain("24 pcs total");
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
  });

  it("web unitSku scan -> a piece (named behaviour change): the product's unitSku with no scanMatch adds one loose piece, not a case", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await scan(BOXED, "400500601"); // BOXED.unitSku
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    expect(casesInput().value).toBe("0");
    expect(looseInput()?.value).toBe("1");
  });

  it("the scan screen's resolveCode path applies the same level (scan_v2)", async () => {
    mockScanV2 = true;
    mockResolveProductByCode.mockResolvedValue({
      notFound: false,
      archived: false,
      product: { ...BOXED, scanMatch: { code: "UNITCODE", levels: ["UNIT"] } },
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    act(() => capturedOpenContinuous!());
    await act(async () => {
      await capturedScanScreenResolve!("UNITCODE", { quiet: true });
    });
    // The order dialog is closed while the scan screen is up (the screen renders the lines, and it
    // is mocked here), so the line is read from the `lines` prop the screen is handed.
    await waitFor(() => expect(capturedScanScreenLines).toHaveLength(1));
    expect(capturedScanScreenLines[0]).toMatchObject({ boxes: 0, pieces: 1, qty: 1 });
  });
});

describe("R1/R2: a BOX code, or a shared code, adds one CASE", () => {
  it("BOX -> BOX merges into one line, 2 cases, no loose units (today's merge)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await scan(BOXED, "BOXCODE", ["BOX"]);
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    await scan(BOXED, "BOXCODE", ["BOX"]);
    await waitFor(() => expect(casesInput().value).toBe("2"));
    expect(looseInput()).toBeNull();
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
  });

  it("R2: a SHARED code (BOX+UNIT) adds a CASE, new line and repeat", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await scan(BOXED, "SHARED", ["BOX", "UNIT"]);
    await waitFor(() => expect(lineFor("Sample Chips")).toBeTruthy());
    expect(casesInput().value).toBe("1");
    expect(looseInput()).toBeNull();
    await scan(BOXED, "SHARED", ["UNIT", "BOX"]);
    await waitFor(() => expect(casesInput().value).toBe("2"));
    expect(looseInput()).toBeNull();
  });
});

describe("R2 (SA-580b): a shared code on upb <= 1 adds the default unit -> today's plain +1 line", () => {
  it("a SHARED hit on a plain product adds +1 qty, merges, and never shows a case/loose split", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await scan(PLAIN, "100200300", ["BOX", "UNIT"]);
    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    expect(plainQty()).toBe("1");
    await scan(PLAIN, "100200300", ["UNIT", "BOX"]);
    await waitFor(() => expect(plainQty()).toBe("2"));
    expect(screen.queryByTitle("Number of whole boxes")).not.toBeInTheDocument();
  });
});

describe("R4: upb <= 1 — no box/unit distinction, today's line shape whatever the level", () => {
  it.each([["UNIT"], ["BOX"]] as const)(
    "a %s hit on a plain product adds +1 qty and merges (no loose split)",
    async (level) => {
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await scan(PLAIN, "100200300", [level]);
      await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
      expect(plainQty()).toBe("1");
      await scan(PLAIN, "100200300", [level]);
      await waitFor(() => expect(plainQty()).toBe("2"));
      expect(screen.queryByTitle("Number of whole boxes")).not.toBeInTheDocument();
    },
  );
});

describe("SA-595a R4: a sku (BOX-level) hit at upb <= 1 adds today's line shape (unchanged by M4a)", () => {
  // Master's newLineQty/mergeQtyIntoLine: upb null -> a plain qty line; upb 1 -> a 1-box line
  // ({qty 1, boxes 1, pieces 0}) whose merge is +1 box. Either way qty is +1 per scan, one line.
  it("upb null: new line is plain qty 1 (no case/loose split), a repeat merges to qty 2", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const qty = () =>
      (
        lineFor("Sample Juice").querySelector(
          'input[aria-label="Quantity"]',
        ) as HTMLInputElement | null
      )?.value ?? lineFor("Sample Juice").querySelector("span.w-8.text-center")?.textContent;
    await scan(UPB_NULL, "111222333", ["BOX"]);
    await waitFor(() => expect(lineFor("Sample Juice")).toBeTruthy());
    expect(qty()).toBe("1");
    await scan(UPB_NULL, "111222333", ["BOX"]);
    await waitFor(() => expect(qty()).toBe("2"));
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
    expect(screen.queryByTitle("Number of whole boxes")).not.toBeInTheDocument();
  });

  it("upb 1: new line is {boxes 1, pieces 0, qty 1}, a repeat merges +1 box on the ONE line, no loose units", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await scan(UPB_ONE, "700800900", ["BOX"]);
    await waitFor(() => expect(lineFor("Sample Soda")).toBeTruthy());
    expect(casesInput().value).toBe("1");
    expect(looseInput()).toBeNull();
    expect(lineFor("Sample Soda").textContent).toContain("1 pcs total");
    await scan(UPB_ONE, "700800900", ["BOX"]);
    await waitFor(() => expect(casesInput().value).toBe("2"));
    expect(looseInput()).toBeNull();
    expect(lineFor("Sample Soda").textContent).toContain("2 pcs total");
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
  });
});
