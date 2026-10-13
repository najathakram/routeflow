import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, within } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * New invoice / New sale builder at a phone width: the line-item row used to keep the 6-7 column
 * desktop grid (1fr 70px 100px 90px ...) at every width, so at 390px the item name and qty were
 * clipped and Rate / Discount / Tax ran off-screen with no way to scroll to them. Below `md` the
 * row now STACKS as a card (item + delete / qty + rate / discount + tax / line total) with a
 * visible label per field; at `md` and up the table grid is the one it always was.
 *
 * JSDOM has no layout, so this pins the responsive CLASSES (the breakpoint wiring); the pixel
 * proof (scrollWidth vs clientWidth at 390, every control inside the viewport, tap heights) is a
 * host-run Playwright capture recorded in local-assets/proofs/2026-10-13-line-item-390/.
 * Harness copied from page.line-discount.test.tsx.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" } }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
}));

// Keyed by URL so the page's own /settings fetch (tax rate, on mount) doesn't consume the
// barcode-scan mock — apiClient.get is called for both.
let mockBarcodeProduct: Record<string, unknown> | undefined;
let mockFlags: string[] = [];
let mockLadder: Array<Record<string, unknown>> = [];
const mockProductsGet = jest.fn((url: string) => {
  if (url === "/billing/subscription") return Promise.resolve({ data: { flags: mockFlags } });
  if (/^\/products\/[^/]+\/units$/.test(url)) return Promise.resolve({ data: mockLadder });
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

jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));

async function openBuilderWithOneLine(name = "Gum") {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  await act(async () => {
    capturedOnScan!("012345678905");
  });
  await screen.findByDisplayValue(name);
  return user;
}

/** The grid card of the one line: the nearest ancestor of the Unit price input that is a grid. */
function lineRow(): HTMLElement {
  let el: HTMLElement | null = screen.getByLabelText("Unit price");
  while (el && !el.className.toString().includes("grid-cols")) el = el.parentElement;
  if (!el) throw new Error("no grid row found above the Unit price input");
  return el;
}

const cls = (el: Element) => el.className.toString().split(/\s+/);

describe("new invoice — the line-item row stacks below md (390px clipping)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = undefined;
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockSearchProducts = [];
    mockBarcodeProduct = { id: "prod-1", name: "Gum", pricePerUnit: "5" };
    mockFlags = [];
    mockLadder = [];
  });

  it("the row is a 4-column stacked card below md and the table grid from md up", async () => {
    await openBuilderWithOneLine();
    const row = lineRow();
    const c = cls(row);
    expect(c).toContain("grid-cols-4");
    expect(c).toContain("md:grid-cols-[1fr_70px_100px_90px_44px_32px]");
    expect(c).toContain("max-md:rounded-lg");
  });

  it("the table header is hidden below md (the labels move onto each field) and kept from md up", async () => {
    await openBuilderWithOneLine();
    const header = screen.getByText("Item Details").parentElement!;
    expect(cls(header)).toEqual(expect.arrayContaining(["hidden", "md:grid"]));
    expect(cls(header)).toContain("md:grid-cols-[1fr_70px_100px_90px_44px_32px]");
    for (const t of ["Qty", "Rate", "Discount", "Tax"]) {
      expect(within(header).getByText(t)).toBeInTheDocument();
    }
  });

  it.each(["Qty", "Rate", "Discount", "Tax"])(
    "%s has a visible mobile-only label that md hides",
    async (label) => {
      await openBuilderWithOneLine();
      const row = lineRow();
      const lab = within(row).getByText(label);
      expect(cls(lab)).toContain("md:hidden");
    },
  );

  it("every control is still present and named: Qty, Unit price (Rate), Line discount, Tax, Remove", async () => {
    await openBuilderWithOneLine();
    const row = lineRow();
    expect(within(row).getByLabelText("Qty")).toBeInTheDocument();
    expect(within(row).getByLabelText("Unit price")).toBeInTheDocument();
    expect(within(row).getByLabelText("Line discount")).toBeInTheDocument();
    expect(within(row).getByRole("checkbox", { name: "Tax" })).toBeInTheDocument();
    expect(within(row).getByTitle("Remove item")).toBeInTheDocument();
  });

  it("the delete action sits on line 1 beside the item, with a 44px target on mobile", async () => {
    await openBuilderWithOneLine();
    const row = lineRow();
    const del = within(row).getByTitle("Remove item");
    expect(cls(del)).toEqual(expect.arrayContaining(["max-md:h-11", "max-md:w-11"]));
    expect(cls(del)).toEqual(expect.arrayContaining(["max-md:col-start-4", "max-md:row-start-1"]));
  });

  it("the inputs are 44px tall on mobile and unchanged from md up", async () => {
    await openBuilderWithOneLine();
    const row = lineRow();
    for (const name of ["Qty", "Unit price", "Line discount"]) {
      const c = cls(within(row).getByLabelText(name));
      expect(c).toContain("max-md:h-11");
      expect(c).toContain("h-9");
    }
  });

  it("the line total is inside the card on mobile; the desktop totals strip is md-only", async () => {
    await openBuilderWithOneLine();
    const row = lineRow();
    const mobileTotal = within(row).getByTestId("line-total-mobile");
    expect(cls(mobileTotal)).toContain("md:hidden");
    expect(mobileTotal).toHaveTextContent("$5.00");
    const strip = screen.getByText("= $5.00").closest("div")!;
    expect(cls(strip)).toEqual(expect.arrayContaining(["hidden", "md:grid"]));
  });
});

describe("new invoice — boxed, ladder and Case|Unit controls fit the 130px qty cell below md", () => {
  const BOXED = { id: "prod-24", name: "Soda", unit: "Box", pricePerUnit: "48", unitsPerBox: 24 };
  const CASE = {
    id: "u-case",
    productId: "prod-24",
    label: "Case",
    factorToBase: 12,
    price: "24.00",
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnScan = undefined;
    mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
    mockSearchProducts = [];
  });

  it("the boxes and pieces inputs are 44px wide and tall on mobile (w-8 from md up) and the row wraps", async () => {
    mockBarcodeProduct = BOXED;
    await openBuilderWithOneLine("Soda");
    const row = lineRow();
    const boxes = within(row).getByTitle("Boxes");
    const pieces = within(row).getByTitle("Extra pieces");
    for (const el of [boxes, pieces]) {
      expect(cls(el)).toEqual(expect.arrayContaining(["w-8", "max-md:h-11", "max-md:w-11"]));
      expect(cls(el)).not.toContain("max-md:w-14");
    }
    expect(cls(boxes.parentElement!)).toContain("max-md:flex-wrap");
  });

  it("the Case | Unit pills are 44px tall on mobile", async () => {
    mockBarcodeProduct = BOXED;
    await openBuilderWithOneLine("Soda");
    const row = lineRow();
    const pills = within(row)
      .getAllByRole("button")
      .filter((b) => b.className.toString().includes("max-w-[104px]"));
    expect(pills).toHaveLength(2);
    for (const b of pills) expect(cls(b)).toContain("max-md:min-h-11");
  });

  it("the unit-ladder count (LevelCount) is 44px tall on mobile and h-9 from md up", async () => {
    mockFlags = ["flag.units_v1"];
    mockLadder = [CASE];
    mockBarcodeProduct = BOXED;
    const user = await openBuilderWithOneLine("Soda");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Sell Soda by" }), "Case");
    const count = await screen.findByLabelText(/^case count$/i);
    expect(cls(count)).toEqual(expect.arrayContaining(["h-9", "max-md:h-11"]));
  });
});
