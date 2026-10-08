import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import EstimatesPage from "./page";

/**
 * B1215 C6/C7 on the create-estimate dialog: an estimate can quote a variant (the dropdown expands
 * a family's variants, and a flavor-only hit re-attaches its opened parent), the line is named
 * "<Parent> - <Variant>", and a FAMILY is never added as a line.
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
jest.mock("@/lib/api/tier-labels", () => ({
  ...jest.requireActual("@/lib/api/tier-labels"),
  useTierLabels: () => ({ data: {}, isLoading: false, isError: false }),
}));

const VARIANT = {
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

async function openDialog() {
  const user = userEvent.setup();
  renderWithProviders(<EstimatesPage />);
  await user.click(screen.getByRole("button", { name: "New Estimate" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByPlaceholderText(/search customers/i), "Acme");
  await user.click(await within(dialog).findByText("Acme Foods"));
  return { user, dialog };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = [];
});

describe("new estimate - product search variants and families (B1215)", () => {
  it("C6: a flavor-only hit shows its parent opened; the variant is quotable", async () => {
    mockRows = [VARIANT];
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByPlaceholderText(/search by name, sku/i), "strawberry");
    expect(await within(dialog).findByText("Sample Pod")).toBeInTheDocument();
    await user.click(
      await within(dialog).findByRole("button", { name: /Sample Pod - Strawberry/ }),
    );
    // the quoted line carries the composed name
    await waitFor(() =>
      expect(within(dialog).getAllByText("Sample Pod - Strawberry").length).toBeGreaterThan(0),
    );
    expect(within(dialog).queryByRole("button", { name: /Sample Pod - Strawberry/ })).toBeNull();
  });

  it("C6: a matched family expands to its variants when tapped", async () => {
    mockRows = [FAMILY];
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByPlaceholderText(/search by name, sku/i), "pod");
    await user.click(await within(dialog).findByRole("button", { name: /Sample Pod/ }));
    expect(
      await within(dialog).findByRole("button", { name: /Sample Pod - Mint/ }),
    ).toBeInTheDocument();
  });

  it("C7: tapping a FAMILY never adds it as a line", async () => {
    mockRows = [FAMILY];
    const { user, dialog } = await openDialog();
    const box = within(dialog).getByPlaceholderText(/search by name, sku/i) as HTMLInputElement;
    await user.type(box, "pod");
    await user.click(await within(dialog).findByRole("button", { name: /Sample Pod/ }));
    await within(dialog).findByRole("button", { name: /Sample Pod - Mint/ });
    // an add clears the search box; a family tap only opens the group
    expect(box.value).toBe("pod");
  });
});

/**
 * #3323 fold (c): a NON-family parent (a sellable product that also has variants) stays quotable as its
 * own line - the picker may not over-filter it down to an expander. A FAMILY still never is.
 */
const PARENT = {
  id: "p-bar",
  name: "Protein Bar",
  kind: "STANDARD",
  parentProductId: null,
  unit: "box",
  pricePerUnit: "24.00",
  isActive: true,
  variants: [
    {
      id: "v-choc",
      name: "Chocolate",
      variantName: "Chocolate",
      kind: "VARIANT",
      parentProductId: "p-bar",
      unit: "box",
      pricePerUnit: "25.00",
      isActive: true,
    },
  ],
};

describe("new estimate - a non-family parent stays quotable (#3323)", () => {
  it("the expanded group offers the parent itself, and quoting it adds the parent line", async () => {
    mockRows = [PARENT];
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByPlaceholderText(/search by name, sku/i), "bar");
    await user.click(await within(dialog).findByRole("button", { name: /Protein Bar/ }));
    expect(
      await within(dialog).findByRole("button", { name: /Protein Bar - Chocolate/ }),
    ).toBeInTheDocument();
    await user.click(
      await within(dialog).findByRole("button", { name: /Quote Protein Bar itself/ }),
    );
    await waitFor(() =>
      expect(within(dialog).getAllByText("Protein Bar").length).toBeGreaterThan(0),
    );
    expect(within(dialog).queryByRole("button", { name: /Quote Protein Bar itself/ })).toBeNull();
  });

  it("a FAMILY group has no 'itself' row", async () => {
    mockRows = [FAMILY];
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByPlaceholderText(/search by name, sku/i), "pod");
    await user.click(await within(dialog).findByRole("button", { name: /Sample Pod/ }));
    await within(dialog).findByRole("button", { name: /Sample Pod - Mint/ });
    expect(within(dialog).queryByRole("button", { name: /itself/ })).toBeNull();
  });
});
