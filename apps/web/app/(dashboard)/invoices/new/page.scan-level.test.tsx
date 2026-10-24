import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * #2717 M4a-1 / SA-595c (1): the new-invoice screen adds SALES lines from a scan, so it resolves
 * the scanned code's LEVEL exactly like the order screens: a distinct UNIT code adds a loose
 * piece, a distinct BOX code and a SHARED code add a case (a shared code == a picker tap), and a
 * upb <= 1 product keeps today's plain line. Both scan paths are pinned: the row picker's
 * BarcodeScannerButton and the top scan bar (which also bumps an existing line).
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

const BOXED = { id: "p-24", name: "Case Soda", pricePerUnit: "60", unitsPerBox: 24 };

function sentItems() {
  return (createInvoiceMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }).items;
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /save as draft/i }));
  await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
}

async function scanBar(user: ReturnType<typeof userEvent.setup>, code: string) {
  const input = screen.getByPlaceholderText(/scan barcode, or type product name/i);
  await user.click(input);
  await user.type(input, `${code}{Enter}`);
}

describe("SA-595c (1) — new-invoice scan applies the scanned level", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // JSDOM has no scrollIntoView; the page scrolls the touched row into view after an add.
    Element.prototype.scrollIntoView = jest.fn();
    capturedOnScan = undefined;
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockBarcodeProduct = undefined;
    mockSearchProducts = [];
  });

  describe("row picker (BarcodeScannerButton)", () => {
    it("a distinct UNIT code adds ONE loose piece, not a case", async () => {
      mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["UNIT"] } };
      const user = await openStandaloneBuilder();
      capturedOnScan!("2000000000012");
      await screen.findByDisplayValue("Case Soda");
      await save(user);
      expect(sentItems()[0]).toMatchObject({ qty: 1, boxes: 0, pieces: 1 });
    });

    it("a distinct BOX code adds a case", async () => {
      mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["BOX"] } };
      const user = await openStandaloneBuilder();
      capturedOnScan!("COLA-24");
      await screen.findByDisplayValue("Case Soda");
      await save(user);
      expect(sentItems()[0]).toMatchObject({ qty: 24, boxes: 1, pieces: 0 });
    });

    it("a SHARED code (BOX + UNIT) equals a picker tap: a case", async () => {
      mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["BOX", "UNIT"] } };
      const user = await openStandaloneBuilder();
      capturedOnScan!("4000000000019");
      await screen.findByDisplayValue("Case Soda");
      await save(user);
      expect(sentItems()[0]).toMatchObject({ qty: 24, boxes: 1, pieces: 0 });
    });

    it("a UNIT code with NO scanMatch falls back to the product's own unitSku column", async () => {
      mockBarcodeProduct = { ...BOXED, unitSku: "2000000000012" };
      const user = await openStandaloneBuilder();
      capturedOnScan!("2000000000012");
      await screen.findByDisplayValue("Case Soda");
      await save(user);
      expect(sentItems()[0]).toMatchObject({ qty: 1, boxes: 0, pieces: 1 });
    });

    it("upb <= 1: a UNIT code keeps today's plain qty-1 line", async () => {
      mockBarcodeProduct = {
        id: "p-1",
        name: "Widget",
        pricePerUnit: "9.99",
        unitsPerBox: 1,
        scanMatch: { levels: ["UNIT"] },
      };
      const user = await openStandaloneBuilder();
      capturedOnScan!("1");
      await screen.findByDisplayValue("Widget");
      await save(user);
      expect(sentItems()[0].qty).toBe(1);
      expect(sentItems()[0].boxes).toBeUndefined();
      expect(sentItems()[0].pieces).toBeUndefined();
    });
  });

  describe("top scan bar (handleScanCode -> addProductFromCatalog)", () => {
    it("a distinct UNIT code adds a piece; a second one bumps the SAME line by a piece", async () => {
      mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["UNIT"] } };
      const user = await openStandaloneBuilder();
      await scanBar(user, "2000000000012");
      await screen.findByDisplayValue("Case Soda");
      await scanBar(user, "2000000000012");
      await waitFor(() => expect(screen.getByTitle("Extra pieces")).toHaveValue(2));
      await save(user);
      expect(sentItems()).toHaveLength(1);
      expect(sentItems()[0]).toMatchObject({ qty: 2, boxes: 0, pieces: 2 });
    });

    it("piece scans roll up into a case at the pack size and hide nothing", async () => {
      mockBarcodeProduct = { ...BOXED, unitsPerBox: 2, scanMatch: { levels: ["UNIT"] } };
      const user = await openStandaloneBuilder();
      await scanBar(user, "U");
      await screen.findByDisplayValue("Case Soda");
      await scanBar(user, "U");
      await waitFor(() => expect(screen.getByTitle("Boxes")).toHaveValue(1));
      await save(user);
      expect(sentItems()[0]).toMatchObject({ qty: 2, boxes: 1, pieces: 0 });
    });

    it("a SHARED code equals a picker tap: a case, then +1 case", async () => {
      mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["BOX", "UNIT"] } };
      const user = await openStandaloneBuilder();
      await scanBar(user, "4000000000019");
      await screen.findByDisplayValue("Case Soda");
      await scanBar(user, "4000000000019");
      await waitFor(() => expect(screen.getByTitle("Boxes")).toHaveValue(2));
      await save(user);
      expect(sentItems()[0]).toMatchObject({ qty: 48, boxes: 2, pieces: 0 });
    });

    it("a distinct BOX code on a line holding loose pieces adds a whole case", async () => {
      mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["UNIT"] } };
      const user = await openStandaloneBuilder();
      await scanBar(user, "U");
      await screen.findByDisplayValue("Case Soda");
      mockBarcodeProduct = { ...BOXED, scanMatch: { levels: ["BOX"] } };
      await scanBar(user, "B");
      await waitFor(() => expect(screen.getByTitle("Boxes")).toHaveValue(1));
      await save(user);
      expect(sentItems()[0]).toMatchObject({ qty: 25, boxes: 1, pieces: 1 });
    });

    it("upb <= 1: a UNIT scan keeps today's line (qty +1, no boxes)", async () => {
      mockBarcodeProduct = {
        id: "p-1",
        name: "Widget",
        pricePerUnit: "9.99",
        unitsPerBox: 1,
        scanMatch: { levels: ["UNIT"] },
      };
      const user = await openStandaloneBuilder();
      await scanBar(user, "1");
      await screen.findByDisplayValue("Widget");
      await scanBar(user, "1");
      await save(user);
      expect(sentItems()[0].qty).toBe(2);
      expect(sentItems()[0].boxes).toBeUndefined();
    });
  });
});
