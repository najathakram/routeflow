import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import EstimatesPage from "./page";

/**
 * Row 503 (the M3 pattern on the estimate dialog): Enter in the product search adds what the FIRST SHOWN
 * row stands for (a FAMILY row: its first variant; any other row: itself), never the API's raw first hit
 * filtered by sellableOnly. An exact barcode, or an exact SKU among the offered products, still wins (wedge
 * scanners). Enter typed before the dropdown caught up fetches, ordered the way the dropdown will show it.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/estimates",
  useSearchParams: () => new URLSearchParams(),
}));

const createEstimateMutate = jest.fn();
jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimates: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useCreateEstimate: () => ({ mutate: createEstimateMutate, isPending: false }),
}));

const CUSTOMER = { id: "cust-1", businessName: "Acme Foods", contactName: "Jane", pricingTier: 1 };
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [CUSTOMER] }, isLoading: false, isError: false }),
  useCustomerPrices: () => ({ data: [], isLoading: false, isError: false }),
}));

let mockRows: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockRows }, isLoading: false, isError: false }),
}));
let mockRawSearch: Array<Record<string, unknown>> = [];
let mockBarcodeProduct: Record<string, unknown> | undefined;
const mockGet = jest.fn((url: string) => {
  if (url.startsWith("/products/barcode/")) {
    return mockBarcodeProduct
      ? Promise.resolve({ data: mockBarcodeProduct })
      : Promise.reject(new Error("not found"));
  }
  if (url === "/products") return Promise.resolve({ data: { data: mockRawSearch } });
  return Promise.resolve({ data: {} });
});
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockGet(url),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/api/tier-labels", () => ({
  ...jest.requireActual("@/lib/api/tier-labels"),
  useTierLabels: () => ({ data: {}, isLoading: false, isError: false }),
}));

const DISTILLED = {
  id: "p-distilled",
  name: "Distilled Water",
  sku: "DW-1",
  kind: "STANDARD",
  parentProductId: null,
  unit: "each",
  pricePerUnit: "2.00",
  isActive: true,
};
// A flavor-only hit: the dropdown re-attaches its parent AFTER the standalones.
const STRAW = {
  id: "v-straw",
  name: "Strawberry",
  variantName: "Strawberry",
  kind: "VARIANT",
  parentProductId: "f-pod",
  parent: { id: "f-pod", name: "Sample Pod" },
  unit: "each",
  pricePerUnit: "4.00",
  isActive: true,
};
const FAMILY = {
  id: "f-pod",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  pricePerUnit: "0",
  isActive: true,
  variants: [
    {
      id: "v-mint",
      name: "Mint",
      variantName: "Mint",
      kind: "VARIANT",
      parentProductId: "f-pod",
      unit: "each",
      pricePerUnit: "4.00",
      isActive: true,
    },
  ],
};
// A FAMILY with two sellable variants: Enter must OPEN it, never add a hidden variant (SA must).
const DUO = {
  ...FAMILY,
  id: "f-duo",
  name: "Sample Duo",
  variants: [
    { ...FAMILY.variants[0], id: "v-mint2", name: "Mint", parentProductId: "f-duo", sku: "DUO-M" },
    {
      ...FAMILY.variants[0],
      id: "v-lime",
      name: "Lime",
      variantName: "Lime",
      parentProductId: "f-duo",
      sku: "DUO-L",
    },
  ],
};
const PARENT = {
  id: "p-bar",
  name: "Protein Bar",
  kind: "STANDARD",
  parentProductId: null,
  unit: "box",
  pricePerUnit: "24.00",
  isActive: true,
  variants: [{ ...FAMILY.variants[0], id: "v-choc", name: "Chocolate", parentProductId: "p-bar" }],
};

async function openDialog() {
  const user = userEvent.setup();
  renderWithProviders(<EstimatesPage />);
  await user.click(screen.getByRole("button", { name: "New Estimate" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByPlaceholderText(/search customers/i), "Acme");
  await user.click(await within(dialog).findByText("Acme Foods"));
  const box = within(dialog).getByPlaceholderText(/search by name, sku/i) as HTMLInputElement;
  return { user, dialog, box };
}

/** Types, waits until the dropdown shows `firstShown`, then presses Enter. */
async function typeWaitEnter(
  ctx: Awaited<ReturnType<typeof openDialog>>,
  text: string,
  firstShown: RegExp,
) {
  await ctx.user.type(ctx.box, text);
  await within(ctx.dialog).findAllByRole("button", { name: firstShown });
  await ctx.user.keyboard("{Enter}");
}

/** The quoted line exists once the search box clears and the name shows outside the dropdown. */
async function expectQuoted(ctx: Awaited<ReturnType<typeof openDialog>>, name: string) {
  await waitFor(() => expect(ctx.box.value).toBe(""));
  expect(within(ctx.dialog).getAllByText(name).length).toBeGreaterThan(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = [];
  mockRawSearch = [];
  mockBarcodeProduct = undefined;
});

describe("new estimate - Enter adds the first SHOWN row (row 503)", () => {
  it("adds the first shown row, not sellableOnly's raw first hit", async () => {
    mockRows = mockRawSearch = [STRAW, DISTILLED]; // shown: Distilled Water, then Sample Pod (opened)
    const ctx = await openDialog();
    await typeWaitEnter(ctx, "wa", /Distilled Water/);
    await expectQuoted(ctx, "Distilled Water");
    expect(within(ctx.dialog).queryByText("Sample Pod - Strawberry")).toBeNull();
  });

  it("a single-variant FAMILY first row adds that variant (never the family, never the next row)", async () => {
    mockRows = mockRawSearch = [FAMILY, DISTILLED];
    const ctx = await openDialog();
    await typeWaitEnter(ctx, "s", /Sample Pod/);
    await expectQuoted(ctx, "Sample Pod - Mint");
  });

  it("a non-family parent first row adds the parent itself", async () => {
    mockRows = mockRawSearch = [PARENT, DISTILLED];
    const ctx = await openDialog();
    await typeWaitEnter(ctx, "b", /Protein Bar/);
    await expectQuoted(ctx, "Protein Bar");
  });

  it("an exact SKU among the offered products still wins over the first row", async () => {
    mockRows = mockRawSearch = [FAMILY, DISTILLED];
    const ctx = await openDialog();
    await typeWaitEnter(ctx, "DW-1", /Sample Pod/);
    await expectQuoted(ctx, "Distilled Water");
  });

  it("an exact barcode still wins (scanner path)", async () => {
    mockRows = mockRawSearch = [FAMILY, DISTILLED];
    mockBarcodeProduct = DISTILLED;
    const ctx = await openDialog();
    await typeWaitEnter(ctx, "8000000000017", /Sample Pod/);
    await expectQuoted(ctx, "Distilled Water");
  });

  it("Enter before the dropdown catches up fetches, ordered the way the dropdown will show it", async () => {
    mockRows = [DISTILLED]; // the list on screen was built from an older query
    mockRawSearch = [FAMILY, DISTILLED]; // what the API answers for the full text
    const ctx = await openDialog();
    await ctx.user.type(ctx.box, "s");
    await within(ctx.dialog).findAllByRole("button", { name: /Distilled Water/ });
    await ctx.user.type(ctx.box, "ample{Enter}");
    await expectQuoted(ctx, "Sample Pod - Mint");
    expect(mockGet).toHaveBeenCalledWith("/products");
  });

  it("a multi-variant FAMILY first row EXPANDS on Enter and adds no line", async () => {
    mockRows = mockRawSearch = [DUO, DISTILLED];
    const ctx = await openDialog();
    await typeWaitEnter(ctx, "duo", /Sample Duo/);
    expect(
      await within(ctx.dialog).findByRole("button", { name: /Sample Duo - Lime/ }),
    ).toBeInTheDocument();
    expect(ctx.box.value).toBe("duo"); // nothing was added (an add clears the box)
  });

  it("once the family is open, Enter adds the highlighted visible variant; arrows move it", async () => {
    mockRows = mockRawSearch = [DUO, DISTILLED];
    const ctx = await openDialog();
    await typeWaitEnter(ctx, "duo", /Sample Duo/);
    await within(ctx.dialog).findByRole("button", { name: /Sample Duo - Lime/ });
    expect(within(ctx.dialog).getByRole("button", { name: /Sample Duo - Mint/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await ctx.user.keyboard("{ArrowDown}");
    expect(within(ctx.dialog).getByRole("button", { name: /Sample Duo - Lime/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await ctx.user.keyboard("{Enter}");
    await expectQuoted(ctx, "Sample Duo - Lime");
  });

  it("an exact VARIANT SKU still wins over expanding its family", async () => {
    mockRows = mockRawSearch = [DUO, DISTILLED];
    const ctx = await openDialog();
    await typeWaitEnter(ctx, "DUO-L", /Sample Duo/);
    await expectQuoted(ctx, "Sample Duo - Lime");
  });
});
