import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * B664 — a product can carry `unitsPerBox = 1` (the DTO has no minimum, and inline edit saves
 * any integer). The new-invoice form's box-seeding sites used a TRUTHY check
 * (`upb ? Number(upb) : undefined`), which treats 1 as "boxed" — the edit form's hydrate
 * already guards with `> 1` (see its ProductSearchInput onChange callback); this form did not.
 *
 * IMPORTANT — what "wrong" actually looks like here: `computeLineSubtotal`'s own
 * `hasBoxPackaging = upb > 1` guard means the CLIENT'S rendered preview total was never wrong
 * (boxes:1/pieces:0/upb:1 already falls through to the plain unitPrice*qty branch, see
 * packages/pricing/src/pricing.ts:116). The real, money-relevant defect is what got SENT: the
 * outgoing item carried `boxes: 1, pieces: 0` for a upb-1 product. On the server,
 * manual-invoice-lines.ts re-derives quantity from boxes/pieces via `normalizeBoxesPieces`
 * called WITHOUT qty — `normalizeBoxesPieces({ boxes: 1, pieces: 0, unitsPerBox: 1 })` returns
 * `{ qty: 0, boxes: null, pieces: null }` (verified directly) — and the SAME `upb > 1` guard in
 * pricing.ts then stores the line at qty 0 / $0. This spec proves what the web form controls:
 * the outgoing payload and the rendered qty-control mode, repro-first against the unfixed code.
 */

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

describe("B664 — new-invoice form and a unitsPerBox = 1 product", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = undefined;
    capturedOnCreated = undefined;
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockBarcodeProduct = undefined;
    mockSearchProducts = [];
  });

  it("REPRO (fails without the fix): a scanned unitsPerBox=1 product is sent with boxes/pieces, not as a plain qty-1 line", async () => {
    mockBarcodeProduct = { id: "prod-1", name: "Widget", pricePerUnit: "9.99", unitsPerBox: 1 };
    const user = await openStandaloneBuilder();

    capturedOnScan!("012345678905");
    await screen.findByDisplayValue("Widget");

    // The box/piece stepper (title="Boxes") must NOT appear for a degenerate upb=1 — only a
    // real box size renders it. Pre-fix this input exists with value 1.
    expect(screen.queryByTitle("Boxes")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());

    const sentItem = (
      createInvoiceMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }
    ).items[0];
    expect(sentItem.qty).toBe(1);
    expect(sentItem.boxes).toBeUndefined();
    expect(sentItem.pieces).toBeUndefined();
  });

  it("control: a real boxed product (unitsPerBox = 24) still gets the stepper and sends boxes/pieces", async () => {
    mockBarcodeProduct = { id: "prod-2", name: "Case Soda", pricePerUnit: "60", unitsPerBox: 24 };
    const user = await openStandaloneBuilder();

    capturedOnScan!("111");
    await screen.findByDisplayValue("Case Soda");

    // A genuine case pack keeps its Boxes+Pieces editor — the fix must not regress this.
    expect(screen.getByTitle("Boxes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());

    const sentItem = (
      createInvoiceMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }
    ).items[0];
    expect(sentItem.qty).toBe(24); // 1 box of 24
    expect(sentItem.boxes).toBe(1);
    expect(sentItem.pieces).toBe(0);
  });

  it("control: a non-boxed product (no unitsPerBox at all) is unaffected", async () => {
    mockBarcodeProduct = { id: "prod-3", name: "Loose Item", pricePerUnit: "4.50" };
    const user = await openStandaloneBuilder();

    capturedOnScan!("222");
    await screen.findByDisplayValue("Loose Item");

    expect(screen.queryByTitle("Boxes")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());

    const sentItem = (
      createInvoiceMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }
    ).items[0];
    expect(sentItem.qty).toBe(1);
    expect(sentItem.boxes).toBeUndefined();
    expect(sentItem.pieces).toBeUndefined();
  });

  // #1176 review: pin the two OTHER state-seeding sites directly (not just incidentally via the
  // scan path, which happens to funnel through the same selectProduct/onChange as the dropdown
  // click does) — a future refactor of one path must not silently drop the other's guard.

  it("pin: selecting a unitsPerBox=1 product from the SEARCH DROPDOWN (not scan) is also a plain qty-1 line", async () => {
    mockSearchProducts = [
      { id: "prod-4", name: "Dropdown Widget", pricePerUnit: "8", unitsPerBox: 1 },
    ];
    const user = await openStandaloneBuilder();

    const input = screen.getByPlaceholderText("Description / product…");
    await user.click(input);
    await user.type(input, "Dropdown");
    await user.click(await screen.findByText("Dropdown Widget"));

    expect(screen.queryByTitle("Boxes")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());

    const sentItem = (
      createInvoiceMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }
    ).items[0];
    expect(sentItem.qty).toBe(1);
    expect(sentItem.boxes).toBeUndefined();
    expect(sentItem.pieces).toBeUndefined();
  });

  it("pin: a just-created unitsPerBox=1 product (InlineCreateProductModal.onCreated) is also a plain qty-1 line", async () => {
    const user = await openStandaloneBuilder();

    // No search match -> "Create new product" is the only dropdown option.
    const input = screen.getByPlaceholderText("Description / product…");
    await user.click(input);
    await user.type(input, "Brand New Thing");
    await user.click(await screen.findByText(/create new product/i));

    expect(capturedOnCreated).toBeDefined();
    act(() => {
      capturedOnCreated!({
        id: "prod-5",
        name: "Brand New Thing",
        pricePerUnit: "12",
        unitsPerBox: 1,
      });
    });
    await screen.findByDisplayValue("Brand New Thing");

    expect(screen.queryByTitle("Boxes")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());

    const sentItem = (
      createInvoiceMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }
    ).items[0];
    expect(sentItem.qty).toBe(1);
    expect(sentItem.boxes).toBeUndefined();
    expect(sentItem.pieces).toBeUndefined();
  });

  it("pin: a non-boxed product in the search dropdown never shows '· 1 per box' (finding 4)", async () => {
    // This listing is the top-level scan/quick-add bar (scanSuggestions), a DIFFERENT read site
    // from the row's own ProductSearchInput dropdown used above — its own useProducts() call.
    mockSearchProducts = [
      { id: "prod-6", name: "Plain Widget", pricePerUnit: "3", unitsPerBox: 1 },
    ];
    const user = await openStandaloneBuilder();

    const scanInput = screen.getByPlaceholderText(/scan barcode, or type product name/i);
    await user.click(scanInput);
    await user.type(scanInput, "Plain");
    await screen.findByText("Plain Widget");

    expect(screen.queryByText(/per box/i)).not.toBeInTheDocument();
  });
});
