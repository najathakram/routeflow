import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * B744 (invoices/new family) — a scan adds a line after an AWAITED barcode lookup, then schedules a
 * 30 ms refocus of the top-of-table scan input so the next scan lands there. That re-arm must
 * never take focus from a text-entry field the operator moved to (here, the customer notes).
 *
 * The trigger is the barcode WEDGE path: a code typed into the top-of-table scan input plus Enter
 * runs `handleScanCode` (the site-8 re-arm). The page's only `BarcodeScannerButton` belongs to
 * the per-LINE product picker, so its captured `onScan` never reaches this site.
 *
 * Harness: this file reuses page.test.tsx's mocks verbatim. The lookup resolves through
 * microtasks only, so the test flushes those (no real time passes) until the lookup has run and
 * the add has rendered — the 30 ms timer is scheduled but has not fired — then focuses the notes
 * synchronously and waits past it.
 * `findBy*` is avoided on that path because it polls every 50 ms and would let the timer fire
 * first. Keystrokes use `user.keyboard`, never `user.type` (which clicks the target first and
 * would mask the steal).
 */

// jsdom has no scrollIntoView; the page scrolls a newly added line into view.
window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
}));

// Keyed by URL so the page's own /settings fetch (tax rate, on mount) doesn't consume the
// barcode-scan mock — apiClient.get is called for both.
let mockBarcodeProduct: Record<string, unknown> | undefined;
const mockProductsGet = jest.fn((url: string) => {
  if (url.startsWith("/products/barcode/")) {
    return mockBarcodeProduct
      ? Promise.resolve({ data: mockBarcodeProduct })
      : Promise.reject(new Error("not found"));
  }
  return Promise.resolve({ data: {} });
});
let mockSearchProducts: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockSearchProducts } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

const createInvoiceMutate = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({ mutate: createInvoiceMutate, isPending: false }),
  useUpdateInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));

jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: jest.fn(), isPending: false }),
  useUninvoicedOrders: () => ({ orders: [], isLoading: false }),
}));

jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockProductsGet(url),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// Same technique as CreateOrderModal.test.tsx (B499): the real scanner needs getUserMedia,
// impractical in JSDOM — capture the live onScan prop so a test can trigger it directly.
let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void }) => {
    capturedOnScan = props.onScan;
    return null;
  },
}));

// Same technique — the real modal needs form interaction impractical to drive here; capture
// onCreated so a test can simulate "the operator just created this product" directly (#1176 pin).
let capturedOnCreated: ((product: Record<string, unknown>) => void) | undefined;
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: (props: {
    isOpen: boolean;
    onCreated: (product: Record<string, unknown>) => void;
  }) => {
    if (props.isOpen) capturedOnCreated = props.onCreated;
    return null;
  },
}));

async function openStandaloneBuilder() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  // Pick a customer — validate() requires one before Save as Draft will submit.
  const customerInput = screen.getByPlaceholderText(/search customers/i);
  await user.click(customerInput);
  await user.click(await screen.findByText("Acme Co"));
  return user;
}

const scanInput = () =>
  screen.getByPlaceholderText(
    "Scan barcode, or type product name / SKU and press Enter…",
  ) as HTMLInputElement;
const customerNotes = () =>
  screen.getByPlaceholderText("Add any notes visible to the customer…") as HTMLTextAreaElement;
const pastReArm = () => act(() => new Promise<void>((r) => setTimeout(r, 90)));

/** Wedge-scan a code into the scan input, then flush microtasks (no real time passes) until the
 *  add has rendered — `lineName` shows up as a line's description. */
async function scanAndSettle(code: string, lineName: string) {
  fireEvent.change(scanInput(), { target: { value: code } });
  fireEvent.keyDown(scanInput(), { key: "Enter" });
  for (let i = 0; i < 10 && !screen.queryByDisplayValue(lineName); i++) {
    await act(async () => {});
  }
  expect(screen.queryByDisplayValue(lineName)).not.toBeNull();
}

const barcodeLookups = () =>
  mockProductsGet.mock.calls.map(([url]) => url).filter((u) => u.startsWith("/products/barcode/"));

describe("B744 — invoices/new: the scanner re-arm never steals focus from notes (REG-B744)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = undefined;
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockBarcodeProduct = { id: "prod-1", name: "Widget", pricePerUnit: "9.99" };
    mockSearchProducts = [];
  });

  it("REG-B744-3: notes focused inside the re-arm window keep focus, and an Enter there never runs a scan", async () => {
    await openStandaloneBuilder();
    const user = userEvent.setup({ delay: null });
    await scanAndSettle("012345678905", "Widget");
    const notes = customerNotes();
    act(() => notes.focus());

    await pastReArm();

    expect(document.activeElement).toBe(notes);
    await user.keyboard("Leave at door{Enter}");
    await act(async () => {});
    expect(notes.value).toContain("Leave at door");
    expect(scanInput().value).toBe("");
    expect(barcodeLookups()).toEqual(["/products/barcode/012345678905"]);
  });
});

describe("B744 pins — invoices/new: scanning never dies", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = undefined;
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockBarcodeProduct = { id: "prod-1", name: "Widget", pricePerUnit: "9.99" };
    mockSearchProducts = [];
  });

  it("P1: a scan with nothing focused re-arms the scan input", async () => {
    await openStandaloneBuilder();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await scanAndSettle("012345678905", "Widget");
    await waitFor(() => expect(scanInput()).toHaveFocus());
  });

  it("P2: a focused BUTTON does not block the re-arm", async () => {
    await openStandaloneBuilder();
    const button = screen.getByRole("button", { name: /save as draft/i });
    act(() => button.focus());
    await scanAndSettle("012345678905", "Widget");
    await pastReArm();
    expect(scanInput()).toHaveFocus();
  });
});
