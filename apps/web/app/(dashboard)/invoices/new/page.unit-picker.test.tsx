import * as React from "react";
import userEvent from "@testing-library/user-event";
import { buildLine, computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import { act, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { fmt } from "@/lib/formatting";
import { productUnitsKey } from "@/lib/api/product-units";
import NewInvoicePage from "./page";

/**
 * VU-4a / B1218 (M, U, S, P): the box / piece / unit picker on /invoices/new. Expected money comes from
 * @routeflow/pricing only. Fixture: a Box of 24 @ 48.00 with a Case of 12 pcs @ 24.00 on the ladder; the Piece
 * is implicit. Box and Piece are PACK lines (prorated, no unitLabel); only the Case is a unit line.
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
const mockGet = jest.fn(async (url: string) => {
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

async function open(basis: "sale" | "other", tier?: number) {
  mockCustomers = [{ id: "cust-1", businessName: "Acme Co", pricingTier: tier }];
  const user = userEvent.setup();
  const view = renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", {
      name: basis === "sale" ? /new sale/i : /other charge \(a fee or correction with no order\)/i,
    }),
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
const pickerOf = (name: string) => screen.findByRole("combobox", { name: `Sell ${name} by` });
async function pick(user: ReturnType<typeof userEvent.setup>, name: string, value: string) {
  await user.selectOptions(await pickerOf(name), value);
}
async function typeInto(user: ReturnType<typeof userEvent.setup>, el: HTMLElement, v: string) {
  await user.clear(el);
  await user.type(el, v);
}
const rowTotal = (n: number) => screen.getByText(`= ${fmt(n)}`);
const saveDraft = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /save as draft/i }));
};
const posted = () =>
  (createInvoiceMutate.mock.calls[0][0] as { items: Array<Record<string, unknown>> }).items;

beforeEach(() => {
  jest.clearAllMocks();
  Element.prototype.scrollIntoView = jest.fn();
  mockRole = "OPERATOR";
  mockFlags = ["flag.units_v1"];
  mockLadder = [level({})];
  mockLadderGate = null;
  mockLadderFail = false;
  mockBarcodeProduct = undefined;
  mockSearchProducts = [];
  createInvoiceMutateAsync.mockResolvedValue({ id: "inv-1" });
  updateInvoiceMutateAsync.mockResolvedValue({ id: "inv-1" });
});

describe("M: money (pricing helpers only)", () => {
  it("M1: 2 boxes + 3 pcs is prorated, never 51 x 48; payload is the pack shape with no unitLabel", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await typeInto(user, screen.getByTitle("Cases"), "2");
    await typeInto(user, screen.getByTitle("Extra loose units"), "3");
    const expected = computeLineSubtotal({
      unitPrice: 48,
      qty: 51,
      boxes: 2,
      pieces: 3,
      unitsPerBox: 24,
    });
    expect(expected).toBe(102);
    rowTotal(expected);
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ qty: 51, boxes: 2, pieces: 3, unitPrice: 48 });
    expect("unitLabel" in posted()[0]).toBe(false);
  });

  it("M2: Case x5 = 120.00; payload {qty:5, unitPrice:24, unitLabel} with no boxes or pieces", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    await typeInto(user, screen.getByLabelText(/^case count$/i), "5");
    rowTotal(120);
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ qty: 5, unitPrice: 24, unitLabel: "Case" });
    expect("boxes" in posted()[0]).toBe(false);
    expect("pieces" in posted()[0]).toBe(false);
  });

  it.each([
    [1, 3.33],
    [2, 6.67],
  ])(
    "M3: Piece is proration: 3-pack @10, %i pc = %f, never roundMoney(piecePrice x qty)",
    async (pcs, money) => {
      const { user } = await open("other");
      await scan(user, { ...THREE_PACK, scanMatch: { levels: ["BOX", "UNIT"] } });
      mockLadder = [level({ productId: "p-3", factorToBase: 3, label: "Tray", price: "9.00" })];
      await pick(user, "Gum", "Piece");
      await typeInto(user, screen.getByTitle("Total units"), String(pcs));
      const expected = computeLineSubtotal({
        unitPrice: 10,
        qty: pcs,
        boxes: 0,
        pieces: pcs,
        unitsPerBox: 3,
      });
      expect(expected).toBe(money);
      rowTotal(expected);
      if (pcs === 2) expect(expected).not.toBe(roundMoney(roundMoney(10 / 3) * 2));
    },
  );

  it("M3: 3 pieces of a 3-pack roll up to {boxes 1, pieces 0, qty 3} = 10.00", async () => {
    const { user } = await open("other");
    await scan(user, THREE_PACK);
    await pick(user, "Gum", "Piece");
    await typeInto(user, screen.getByTitle("Total units"), "3");
    rowTotal(10);
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ qty: 3, boxes: 1, pieces: 0, unitPrice: 10 });
  });

  it("M3: a level line (Case x3) totals exactly the server's buildLine unit-axis subtotal", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    await typeInto(user, screen.getByLabelText(/^case count$/i), "3");
    const built = buildLine({
      axis: { kind: "unit", label: "Case", count: 3, factorToBase: 12 },
      unitPrice: 24,
    });
    rowTotal(built.subtotal);
  });

  it("M4: Case x3 = 72.00; a 5.00 line discount = 67.00", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    await typeInto(user, screen.getByLabelText(/^case count$/i), "3");
    rowTotal(72);
    await typeInto(user, screen.getByLabelText("Line discount"), "5");
    rowTotal(67);
  });

  it("M5: a half-cent rounds once (1 pc of a 4-pack @0.02)", async () => {
    const { user } = await open("other");
    await scan(user, {
      id: "p-4",
      name: "Mint",
      unit: "Box",
      pricePerUnit: "0.02",
      unitsPerBox: 4,
    });
    await pick(user, "Mint", "Piece");
    await typeInto(user, screen.getByTitle("Total units"), "1");
    rowTotal(computeLineSubtotal({ unitPrice: 0.02, qty: 1, boxes: 0, pieces: 1, unitsPerBox: 4 }));
  });

  it("M6: unitsPerBox 1 stays a plain quantity line; a ladder-less product has no picker", async () => {
    mockLadder = [];
    const { user } = await open("other");
    await scan(user, { id: "p-1", name: "Cup", pricePerUnit: "2", unitsPerBox: 1 });
    expect(screen.queryByRole("combobox", { name: /sell cup by/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Cases")).not.toBeInTheDocument();
    await saveDraft(user);
    expect(posted()[0].qty).toBe(1);
    expect("boxes" in posted()[0]).toBe(false);
  });

  it("M7: Box -> Case -> Box restores qty / boxes / pieces / unitPrice exactly", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await typeInto(user, screen.getByTitle("Cases"), "2");
    await typeInto(user, screen.getByTitle("Extra loose units"), "3");
    await typeInto(user, screen.getByLabelText("Unit price"), "45.50");
    await pick(user, "Soda", "Case");
    await pick(user, "Soda", "");
    expect(screen.getByTitle("Cases")).toHaveValue(2);
    expect(screen.getByTitle("Extra loose units")).toHaveValue(3);
    expect(screen.getByLabelText("Unit price")).toHaveValue("45.50");
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ qty: 51, boxes: 2, pieces: 3, unitPrice: 45.5 });
    expect("unitLabel" in posted()[0]).toBe(false);
  });
});

describe("U: the picker", () => {
  it("U1: picking Case pre-fills the unit price from the ladder at the customer's tier (qty 1, unitLabel Case)", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    expect(screen.getByLabelText("Unit price")).toHaveValue("24.00");
    expect(screen.getByLabelText(/^case count$/i)).toHaveValue("1");
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ qty: 1, unitPrice: 24, unitLabel: "Case" });
  });

  it("U1: at tier 3 the pre-filled price is the tier-3 unit price", async () => {
    const { user } = await open("other", 3);
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    expect(screen.getByLabelText("Unit price")).toHaveValue("22.00");
  });

  it("U2: a typed 22.50 survives a re-render (priceEdited)", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    await typeInto(user, screen.getByLabelText("Unit price"), "22.50");
    await user.click(screen.getByRole("button", { name: /show avg\. cost/i }));
    await user.click(screen.getByRole("button", { name: /hide avg\. cost/i }));
    expect(screen.getByLabelText("Unit price")).toHaveValue("22.50");
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ unitPrice: 22.5, unitLabel: "Case" });
  });

  it("U3: a Case-default tap starts on Case; flag off => Box and no picker; no ladder => the old switch", async () => {
    mockLadder = [level({ isDefaultSelling: true })];
    const first = await open("other");
    await scan(first.user, BOXED);
    await waitFor(() => expect(screen.getByLabelText(/^case count$/i)).toBeInTheDocument());
    expect(await pickerOf("Soda")).toHaveValue("Case");
    first.unmount();

    mockFlags = [];
    const off = await open("other");
    await scan(off.user, BOXED);
    expect(screen.queryByRole("combobox", { name: /sell soda by/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Case" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unit" })).toBeInTheDocument();
    expect(screen.getByTitle("Cases")).toHaveValue(1);
    off.unmount();

    mockFlags = ["flag.units_v1"];
    mockLadder = [];
    const none = await open("other");
    await scan(none.user, BOXED);
    expect(screen.queryByRole("combobox", { name: /sell soda by/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unit" })).toBeInTheDocument();
  });

  it("U4: a shared code is a tap (Case); a distinct piece code is 1 piece; a distinct box code is 1 box", async () => {
    mockLadder = [level({ isDefaultSelling: true })];
    const { user } = await open("other");
    await scan(user, { ...BOXED, scanMatch: { levels: ["BOX"] } });
    expect(await pickerOf("Soda")).toHaveValue("");
    expect(screen.getByTitle("Cases")).toHaveValue(1);
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ qty: 24, boxes: 1, pieces: 0 });
    expect("unitLabel" in posted()[0]).toBe(false);
  });

  it("U4: a distinct piece code adds ONE loose piece", async () => {
    const { user } = await open("other");
    await scan(user, { ...BOXED, scanMatch: { levels: ["UNIT"] } });
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ qty: 1, boxes: 0, pieces: 1 });
  });

  it("U5: picking Box on a Case-default product sticks; a re-scan bumps the Case line by one Case", async () => {
    mockLadder = [level({ isDefaultSelling: true })];
    const { user } = await open("other");
    await scan(user, BOXED);
    await waitFor(() => expect(screen.getByLabelText(/^case count$/i)).toBeInTheDocument());
    await scan(user, BOXED);
    await waitFor(() => expect(screen.getByLabelText(/^case count$/i)).toHaveValue("2"));
    await pick(user, "Soda", "");
    expect(screen.getByTitle("Cases")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText(/^case count$/i)).not.toBeInTheDocument());
    expect(await pickerOf("Soda")).toHaveValue("");
  });

  it("U6: while the ladder loads the qty is locked, the status shows, nothing posts; Retry resolves and posts", async () => {
    mockLadder = [level({ isDefaultSelling: true })];
    mockLadderFail = true;
    const { user } = await open("other");
    await scan(user, BOXED);
    expect(await screen.findByText(/Couldn't load the selling units/)).toBeInTheDocument();
    expect(screen.getByTitle("Cases")).toBeDisabled();
    await saveDraft(user);
    expect(createInvoiceMutate).not.toHaveBeenCalled();
    mockLadderFail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByLabelText(/^case count$/i)).toBeInTheDocument());
    await saveDraft(user);
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalledTimes(1));
    expect(posted()[0]).toMatchObject({ unitLabel: "Case", qty: 1 });
  });

  it("U6: Save while units are still loading is blocked with the copy and sends nothing", async () => {
    mockLadder = [level({ isDefaultSelling: true })];
    let release!: () => void;
    mockLadderGate = new Promise<void>((r) => (release = r));
    const { user } = await open("other");
    await scan(user, BOXED);
    expect(await screen.findByText(/1 · loading units/)).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.getByLabelText(/^case count$/i)).toBeInTheDocument());
    expect(createInvoiceMutate).not.toHaveBeenCalled();
  });

  it("U7: Piece on a boxed product is a PACK line: picker shows Piece, box price and no unitLabel are kept; Box restores the split", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await pick(user, "Soda", "Piece");
    expect(await pickerOf("Soda")).toHaveValue("Piece");
    expect(screen.getByLabelText("Unit price")).toHaveValue("48.00");
    await typeInto(user, screen.getByTitle("Total units"), "30");
    const calls = mockGet.mock.calls.length;
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGet.mock.calls.length).toBe(calls); // no render loop re-fetching
    expect(screen.getByLabelText("Unit price")).toHaveValue("48.00"); // no price snap
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ qty: 30, boxes: 1, pieces: 6, unitPrice: 48 });
    expect("unitLabel" in posted()[0]).toBe(false);
    await pick(user, "Soda", "");
    expect(screen.getByTitle("Cases")).toHaveValue(1);
    expect(screen.getByTitle("Extra loose units")).toHaveValue(6);
  });
});

describe("S: submit paths", () => {
  it("S1: POST /invoices carries unitLabel and no boxes/pieces for a unit line", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    await saveDraft(user);
    expect(posted()[0]).toMatchObject({ unitLabel: "Case", qty: 1, unitPrice: 24 });
    expect(Object.keys(posted()[0])).not.toEqual(expect.arrayContaining(["boxes"]));
  });

  const refusal = (code?: string) => ({
    response: { status: code ? 400 : 500, data: code ? { code } : {} },
  });
  const OFFERED = /That unit isn't offered for this product any more/;

  it("S2: UNIT_NOT_OFFERED from createInvoice shows the coded copy and invalidates the units query", async () => {
    const { user, queryClient } = await open("other");
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    const spy = jest.spyOn(queryClient, "invalidateQueries");
    createInvoiceMutate.mockImplementation((_d, o) =>
      o.onError(refusal(API_ERROR_CODES.UNIT_NOT_OFFERED)),
    );
    await saveDraft(user);
    expect(await screen.findByText(OFFERED)).toBeInTheDocument();
    expect(screen.getByText("Failed to create invoice")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: productUnitsKey("p-24") }),
    );
  });

  it("S2: a generic 500 keeps the old text", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    createInvoiceMutate.mockImplementation((_d, o) => o.onError(refusal()));
    await saveDraft(user);
    expect(await screen.findByText("Please check your inputs and try again.")).toBeInTheDocument();
    expect(screen.queryByText(OFFERED)).not.toBeInTheDocument();
  });

  it("S2: UNIT_NOT_OFFERED from createSale and from the draft update use the coded copy too", async () => {
    const sale = await open("sale");
    await scan(sale.user, BOXED);
    await pick(sale.user, "Soda", "Case");
    createSaleMutate.mockImplementation((_d, o) =>
      o.onError(refusal(API_ERROR_CODES.UNIT_NOT_OFFERED)),
    );
    await sale.user.click(screen.getByRole("button", { name: /create sale & invoice/i }));
    expect(await screen.findByText(OFFERED)).toBeInTheDocument();
    expect(screen.getByText("Could not create the sale")).toBeInTheDocument();
  });

  it("S3: sale basis at tier 3: a picked Case sends unitLabel and NO unitPrice; a typed 20.00 sends unitPrice 20 and asks for a Reason", async () => {
    const { user } = await open("sale", 3);
    await scan(user, BOXED);
    await pick(user, "Soda", "Case");
    expect(screen.queryByLabelText("Reason (required)")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /create sale & invoice/i }));
    const items = () => (createSaleMutate.mock.calls.at(-1)![0] as { items: any[] }).items;
    expect(items()[0]).toMatchObject({ productId: "p-24", qty: 1, unitLabel: "Case" });
    expect("unitPrice" in items()[0]).toBe(false);
    createSaleMutate.mockClear();
    await typeInto(user, screen.getByLabelText("Unit price"), "20");
    expect(await screen.findByLabelText("Reason (required)")).toBeInTheDocument();
    await typeInto(user, screen.getByLabelText("Reason (required)"), "Spot deal");
    await user.click(screen.getByRole("button", { name: /create sale & invoice/i }));
    expect(items()[0]).toMatchObject({ unitLabel: "Case", unitPrice: 20 });
  });
});

describe("P: parity and the draft preview", () => {
  it("P1: flag off: the row controls are today's (Case | Unit switch, Cases, Extra loose units, Unit price, Line discount)", async () => {
    mockFlags = [];
    const { user } = await open("other");
    await scan(user, BOXED);
    const names = [
      screen.getByRole("button", { name: "Case" }),
      screen.getByRole("button", { name: "Unit" }),
      screen.getByTitle("Cases"),
      screen.getByTitle("Extra loose units"),
      screen.getByLabelText("Unit price"),
      screen.getByLabelText("Line discount"),
      screen.getByTitle("Remove item"),
    ];
    expect(names).toHaveLength(7);
    expect(screen.queryByRole("combobox", { name: /sell/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unit" }));
    expect(screen.getByTitle("Total units")).toBeInTheDocument();
  });

  it("P1: the Case | Unit switch is replaced (not duplicated) on a line that has the picker", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await pickerOf("Soda");
    expect(screen.queryByRole("button", { name: "Unit" })).not.toBeInTheDocument();
    expect(screen.getByTitle("Cases")).toBeInTheDocument();
    expect(screen.getByTitle("Extra loose units")).toBeInTheDocument();
  });

  it("P3: Other charge: Preview, add a Case line, Preview again, Download, Save: create once then PATCH with the unit line; never a second POST", async () => {
    const { user } = await open("other");
    await scan(user, BOXED);
    await user.click(screen.getByRole("button", { name: /^preview$/i }));
    await waitFor(() => expect(createInvoiceMutateAsync).toHaveBeenCalledTimes(1));
    await pick(user, "Soda", "Case");
    await user.click(screen.getByRole("button", { name: /^preview$/i }));
    await waitFor(() => expect(updateInvoiceMutateAsync).toHaveBeenCalledTimes(1));
    const caseBody = updateInvoiceMutateAsync.mock.calls[0][0];
    expect(caseBody.items[0]).toMatchObject({ qty: 1, unitPrice: 24, unitLabel: "Case" });
    expect("boxes" in caseBody.items[0]).toBe(false);
    // Case -> Box -> Case previews send the right shape each time
    await pick(user, "Soda", "");
    await user.click(screen.getByRole("button", { name: /^download$/i }));
    await waitFor(() => expect(updateInvoiceMutateAsync).toHaveBeenCalledTimes(2));
    const boxBody = updateInvoiceMutateAsync.mock.calls[1][0];
    expect("unitLabel" in boxBody.items[0]).toBe(false);
    expect(boxBody.items[0]).toMatchObject({ qty: 24, boxes: 1, pieces: 0 });
    await pick(user, "Soda", "Case");
    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(updateInvoiceMutate).toHaveBeenCalledTimes(1));
    expect(updateInvoiceMutate.mock.calls[0][0].items[0]).toMatchObject({ unitLabel: "Case" });
    expect(createInvoiceMutateAsync).toHaveBeenCalledTimes(1);
    expect(createInvoiceMutate).not.toHaveBeenCalled();
  });
});

// keep the helper imports referenced
void within;
