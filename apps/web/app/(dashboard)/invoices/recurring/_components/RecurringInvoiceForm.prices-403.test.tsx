import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { RecurringInvoiceForm } from "./RecurringInvoiceForm";

/**
 * SA-883 #3 (live regression): a tenant whose plan lacks flag.pricing_tiers gets GET /customers/:id/prices → 403
 * (PLAN_GATE) under PLAN_FLAG_ENFORCEMENT. The SA-868 gate read that as a FAILED price read, so on master every pick
 * was refused with "Couldn't load this customer's prices." and Retry looped on the same 403. A plan-gated (403) PRICES
 * read is a settled EMPTY read: the tenant has no customer-product price rows to honour, so the pick is priced by the
 * customer's own tier (customerTierFor(undefined, customer.pricingTier)). Every other failure still fails closed: a
 * 5xx, a network error or a 404 on the prices read, and ANY error (403 included) on the CUSTOMER read.
 * Harness copied from RecurringInvoiceForm.customer-price.test.tsx, plus the HTTP status on the error.
 */

const P = {
  id: "p-cola",
  name: "Cola 12oz",
  unit: "each",
  pricePerUnit: "10.00",
  priceTier2: "9.00",
  priceTier3: "8.00",
  priceTier4: "7.00",
  priceTier5: "6.00",
  unitsPerBox: null,
  isActive: true,
};
const C3 = { id: "c3", businessName: "Tier Three Cafe", pricingTier: 3 };

/** An axios-shaped error with an HTTP status, or a network error (no response). */
const httpError = (status?: number) =>
  Object.assign(new Error(status ? `Request failed with status code ${status}` : "Network Error"), {
    isAxiosError: true,
    response: status ? { status, data: {} } : undefined,
  });

let mockPricesError: ReturnType<typeof httpError> | null = null;
let mockCustomerError: ReturnType<typeof httpError> | null = null;
const mockRefetch = jest.fn();

jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [P] } }),
  useProduct: (id: string) => ({ data: id === P.id ? P : undefined, isLoading: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [C3] } }),
  useCustomer: (id: string) => ({
    data: id && !mockCustomerError ? C3 : undefined,
    isLoading: false,
    isPending: false,
    isError: !!id && !!mockCustomerError,
    error: id ? mockCustomerError : null,
    refetch: mockRefetch,
  }),
  useCustomerPrices: (id?: string) => ({
    data: id && !mockPricesError ? [] : undefined,
    isLoading: false,
    isPending: false,
    isError: !!id && !!mockPricesError,
    error: id ? mockPricesError : null,
    refetch: mockRefetch,
  }),
}));
jest.mock("@/lib/api/useCustomerPriceLayer", () => ({
  ...jest.requireActual("@/lib/api/useCustomerPriceLayer"),
  useCustomerPriceLayer: () => ({
    enabled: false,
    ready: true,
    pending: false,
    failed: false,
    complete: true,
    lineReady: () => true,
    layerOf: () => undefined,
    refetch: jest.fn(),
  }),
}));

beforeEach(() => {
  mockPricesError = null;
  mockCustomerError = null;
});

const renderCreate = () =>
  renderWithProviders(
    <RecurringInvoiceForm
      mode="create"
      onSubmit={jest.fn()}
      isPending={false}
      submitLabel="Save"
    />,
  );

async function chooseCustomer() {
  fireEvent.change(screen.getByPlaceholderText("Search customers…"), { target: { value: "Tier" } });
  fireEvent.click(await screen.findByRole("button", { name: /Tier Three Cafe/ }));
}

const FAILED = "Couldn't load this customer's prices.";

describe("SA-883 #3: a plan-gated (403) customer-prices read is a settled empty read", () => {
  it("a 403 on the PRICES read lets the pick fill the customer's tier-3 price (master: refused)", async () => {
    mockPricesError = httpError(403);
    renderCreate();
    await chooseCustomer();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText("Description / product…") as HTMLInputElement;
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "cola" } });
    fireEvent.click(await screen.findByRole("button", { name: /Cola 12oz/ }));
    expect(await screen.findByDisplayValue("8.00")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("10.00")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it.each([
    ["a 500", httpError(500)],
    ["a 404", httpError(404)],
    ["a network error", httpError()],
  ])("%s on the PRICES read still fails closed (picking refused, Retry shown)", async (_l, err) => {
    mockPricesError = err;
    renderCreate();
    await chooseCustomer();
    expect(screen.getByPlaceholderText(FAILED)).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(FAILED);
  });

  it("a 403 on the CUSTOMER read still fails closed (only the prices read is plan-gated)", async () => {
    mockCustomerError = httpError(403);
    renderCreate();
    await chooseCustomer();
    expect(screen.getByPlaceholderText(FAILED)).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(FAILED);
  });
});
