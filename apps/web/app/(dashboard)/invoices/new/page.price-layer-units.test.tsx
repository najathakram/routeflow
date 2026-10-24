import * as React from "react";
import userEvent from "@testing-library/user-event";
import { buildLine, computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import { act, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { fmt } from "@/lib/formatting";
import { productUnitsKey } from "@/lib/api/product-units";
import NewInvoicePage from "./page";

/**
 * S19b slice C review fixes (SA-811a, SA-813): MUST-1 a unit pick is priced from the customer layer, MUST-2 Preview, Download,
 * Save and Send are held while prices are unconfirmed, plus the M1 incomplete-layer case. Harness copied from
 * page.unit-picker.test.tsx. (Original header: VU-4a / B1218 (M, U, S, P): the box / piece / unit picker on /invoices/new. Expected money comes from
 * @routeflow/pricing only. Fixture: a Box of 24 @ 48.00 with a Case of 12 pcs @ 24.00 on the ladder; the Piece
 * is implicit. Box and Piece are PACK lines (prorated, no unitLabel); only the Case is a unit line.)
 */

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

let mockRole: string | null = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: mockRole ? { id: "u1", role: mockRole } : null }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
}));

let mockFlags: string[] = ["flag.units_v1"];
let mockLadder: Array<Record<string, unknown>> = [];
let mockLadderGate: Promise<void> | null = null;
let mockLadderFail = false;
let mockBarcodeProduct: Record<string, unknown> | undefined;
let flagOn = true;
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => flagOn }));
let layerResponder: () => Promise<unknown> = () => Promise.resolve({ data: {} });
const mockGet = jest.fn(async (url: string) => {
  if (url === "/customers/cust-1/price-layer") return layerResponder();
  if (url === "/billing/subscription") return { data: { flags: mockFlags } };
  if (/^\/products\/[^/]+\/units$/.test(url)) {
    if (mockLadderGate) await mockLadderGate;
    if (mockLadderFail) throw new Error("units down");
    return { data: mockLadder };
  }
  if (url.startsWith("/products/barcode/")) {
    if (mockBarcodeProduct) return { data: mockBarcodeProduct };
    throw new Error("not found");
  }
  if (url.endsWith("/pdf")) return { data: { url: "blob:x", invoiceNumber: "INV-1" } };
  return { data: {} };
});
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockGet(url),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/fetch-pdf-blob", () => ({
  fetchPdfBlob: jest.fn().mockResolvedValue(new Blob()),
}));

let mockSearchProducts: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockSearchProducts } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

const createInvoiceMutate = jest.fn();
const createInvoiceMutateAsync = jest.fn();
const updateInvoiceMutate = jest.fn();
const updateInvoiceMutateAsync = jest.fn();
const createSaleMutate = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({
    mutate: createInvoiceMutate,
    mutateAsync: createInvoiceMutateAsync,
    isPending: false,
  }),
  useUpdateInvoice: () => ({
    mutate: updateInvoiceMutate,
    mutateAsync: updateInvoiceMutateAsync,
    isPending: false,
  }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: createSaleMutate, isPending: false }),
  useUninvoicedOrders: () => ({ orders: [], isLoading: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));

const level = (over: Record<string, unknown>) => ({
  id: "u-case",
  productId: "p-24",
  label: "Case",
  factorToBase: 12,
  price: "24.00",
  priceTier2: null,
  priceTier3: "22.00",
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
  ...over,
});
const BOXED = {
  id: "p-24",
  name: "Soda",
  unit: "Box",
  pricePerUnit: "48",
  priceTier3: "44",
  unitsPerBox: 24,
  scanMatch: { levels: ["BOX", "UNIT"] },
};
const THREE_PACK = { id: "p-3", name: "Gum", unit: "Box", pricePerUnit: "10", unitsPerBox: 3 };

async function open(tier?: number) {
  mockCustomers = [{ id: "cust-1", businessName: "Acme Co", pricingTier: tier }];
  const user = userEvent.setup();
  const view = renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  return { user, ...view };
}
async function scan(user: ReturnType<typeof userEvent.setup>, product: Record<string, unknown>) {
  mockBarcodeProduct = product;
  const input = screen.getByPlaceholderText(/scan barcode, or type product name/i);
  await user.click(input);
  await user.type(input, "CODE{Enter}");
  await screen.findByDisplayValue(String(product.name));
}
const posted = () =>
  (createInvoiceMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }).items;
const btn = (re: RegExp) => screen.getByRole("button", { name: re });
const notChecking = () =>
  waitFor(() => expect(screen.queryByText(/checking this customer/i)).not.toBeInTheDocument());

// list $48 (pack), Case $24 list; tier 3 pack $44, Case $22. The customer's typed pack $40 puts the Case at $21 (customer-shape).
const layerOf = (complete = true, products: Record<string, unknown[]> | null = null) => ({
  data: {
    customerId: "cust-1",
    complete,
    products: products ?? {
      "p-24": [
        {
          ref: "pack",
          label: null,
          price: 40,
          listPrice: 48,
          source: "customer",
          aboveList: false,
        },
        {
          ref: "u-case",
          label: "Case",
          price: 21,
          listPrice: 24,
          source: "customer-shape",
          aboveList: false,
        },
      ],
    },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  Element.prototype.scrollIntoView = jest.fn();
  URL.createObjectURL = jest.fn(() => "blob:preview");
  URL.revokeObjectURL = jest.fn();
  mockRole = "OPERATOR";
  mockFlags = ["flag.units_v1"];
  mockLadder = [level({})];
  mockLadderGate = null;
  mockLadderFail = false;
  mockBarcodeProduct = undefined;
  mockSearchProducts = [];
  flagOn = true;
  layerResponder = () => Promise.resolve(layerOf());
  createInvoiceMutateAsync.mockResolvedValue({ id: "inv-1" });
  updateInvoiceMutateAsync.mockResolvedValue({ id: "inv-1" });
});

describe("S19b MUST-1: a unit pick prices from the customer layer", () => {
  it("MUST-1: the Case pick shows and posts the layer's $21, not the ladder's tier $22", async () => {
    const { user } = await open(3);
    await notChecking();
    await scan(user, BOXED);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Sell Soda by" }), "Case");
    await waitFor(() =>
      expect(parseFloat((screen.getByLabelText("Unit price") as HTMLInputElement).value)).toBe(21),
    );
    await user.click(btn(/save as draft/i));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(posted()[0]).toMatchObject({ unitLabel: "Case", unitPrice: 21 });
  });

  it("MUST-1: flag OFF keeps the ladder's tier price ($22) and fires no price-layer request", async () => {
    flagOn = false;
    const { user } = await open(3);
    await scan(user, BOXED);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Sell Soda by" }), "Case");
    await user.click(btn(/save as draft/i));
    expect(posted()[0]).toMatchObject({ unitLabel: "Case", unitPrice: 22 });
    expect(mockGet.mock.calls.filter((c) => String(c[0]).endsWith("/price-layer"))).toHaveLength(0);
  });
});

describe("S19b MUST-2 / M3: every outbound action is held while prices are unconfirmed", () => {
  it.each([
    ["pending", () => new Promise(() => {})],
    ["failed", () => Promise.reject(new Error("boom"))],
  ])(
    "%s layer: Preview, Download, Save as draft and Save and Send are all disabled",
    async (_n, r) => {
      layerResponder = r as () => Promise<unknown>;
      await open(3);
      await waitFor(() => expect(btn(/save as draft/i)).toBeDisabled());
      expect(btn(/^preview$/i)).toBeDisabled();
      expect(btn(/download/i)).toBeDisabled();
      expect(btn(/save and send/i)).toBeDisabled();
    },
  );

  it("MUST-2: the preview's Send invoice is held when the layer read fails after the preview opened", async () => {
    const { user, queryClient } = await open(3);
    await notChecking();
    await scan(user, BOXED);
    await user.click(btn(/^preview$/i));
    const send = await screen.findByRole("button", { name: /send invoice/i });
    expect(send).toBeEnabled();
    layerResponder = () => Promise.reject(new Error("boom"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["customers", "cust-1", "price-layer"] });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /send invoice/i })).toBeDisabled(),
    );
  });

  it("M1: an incomplete layer that does not list a line's product holds Save with the too-many copy", async () => {
    layerResponder = () => Promise.resolve(layerOf(false, {}));
    const { user } = await open(3);
    await notChecking();
    await scan(user, BOXED);
    expect(
      await screen.findByText("This customer has too many prices to load here."),
    ).toBeInTheDocument();
    expect(btn(/save as draft/i)).toBeDisabled();
    expect(btn(/save and send/i)).toBeDisabled();
  });
});

describe("S19b: the correction's own paths (default start, resolve at Save)", () => {
  it("default-unit start: a scan that starts on the default Case lands on the layer's $21, not the ladder's $22", async () => {
    mockLadder = [level({ isDefaultSelling: true })];
    const { user } = await open(3);
    await notChecking();
    await scan(user, BOXED);
    await waitFor(() =>
      expect(parseFloat((screen.getByLabelText("Unit price") as HTMLInputElement).value)).toBe(21),
    );
    await user.click(btn(/save as draft/i));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(posted()[0]).toMatchObject({ unitLabel: "Case", unitPrice: 21 });
  });

  it("resolve at Save: a default Case still pending when Save is clicked posts $21, never the ladder's $22", async () => {
    mockLadder = [level({ isDefaultSelling: true })];
    let release: () => void = () => {};
    mockLadderGate = new Promise<void>((r) => {
      release = r;
    });
    const { user } = await open(3);
    await notChecking();
    mockBarcodeProduct = BOXED;
    const input = screen.getByPlaceholderText(/scan barcode, or type product name/i);
    await user.click(input);
    await user.type(input, "CODE{Enter}");
    await screen.findByDisplayValue(String(BOXED.name));
    await user.click(btn(/save as draft/i));
    release();
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(posted()[0]).toMatchObject({ unitLabel: "Case", unitPrice: 21 });
  });
});

describe("S19b: Piece off a layered pack, and the SPECIAL judgement of a layered unit line", () => {
  it("Piece off the layered pack: 24 pieces total the layer's $40 (not the tier $44), posted as the pack shape", async () => {
    const { user } = await open(3);
    await notChecking();
    await scan(user, BOXED);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Sell Soda by" }),
      "Piece",
    );
    const pcs = screen.getByTitle("Total pieces");
    await user.clear(pcs);
    await user.type(pcs, "24");
    expect(screen.getByText("= $40.00")).toBeInTheDocument();
    await user.click(btn(/save as draft/i));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(posted()[0]).toMatchObject({ unitPrice: 40, boxes: 1, pieces: 0 });
    expect("unitLabel" in posted()[0]).toBe(false);
  });

  it("a layered unit line is judged SPECIAL from the layer row, not from the customer's tier: a customer on tier 1 with a typed price needs a reason to move off it", async () => {
    const { user } = await open(1);
    await notChecking();
    await scan(user, BOXED);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Sell Soda by" }), "Case");
    await waitFor(() =>
      expect(parseFloat((screen.getByLabelText("Unit price") as HTMLInputElement).value)).toBe(21),
    );
    const price = screen.getByLabelText("Unit price");
    await user.clear(price);
    await user.type(price, "20");
    expect(await screen.findByLabelText("Reason (required)")).toBeInTheDocument();
  });
});
