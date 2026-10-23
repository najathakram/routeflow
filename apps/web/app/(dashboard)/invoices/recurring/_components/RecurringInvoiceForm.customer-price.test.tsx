import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import type { RecurringInvoice } from "@/lib/api/invoices";
import { RecurringInvoiceForm } from "./RecurringInvoiceForm";

/**
 * SA-856 (W-693): a recurring-invoice line is priced at SET-UP from the one resolver, the customer's own price
 * (`customerLinePrice` over `customerTierFor` and the customer's price layer), the price the invoice form would pre-fill.
 * An operator's typed price is never replaced; existing templates change nothing automatically and only show
 * "This customer's price now: $X" when their stored price differs. Master pre-filled the catalog LIST price (tier 1).
 */

// The API serves prices as decimal strings.
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
const C1 = { id: "c1", businessName: "Retail Cafe", pricingTier: 1 };
const C3 = { id: "c3", businessName: "Tier Three Cafe", pricingTier: 3 };
const CUSTOMERS: Record<string, typeof C1> = { c1: C1, c3: C3 };

let mockCustomerLoading = false;
let mockCustomerError = false;
let mockPricesError = false;
let mockPricesErrorWithData = false;
let mockCustomerPaused = false;
const mockRefetchCustomer = jest.fn();
const mockRefetchPrices = jest.fn();
let mockCustomerPrices: unknown[] = [];
let mockLayer: Record<string, unknown> = {};
const layerOff = () => ({
  enabled: false,
  ready: true,
  pending: false,
  failed: false,
  complete: true,
  lineReady: () => true,
  layerOf: () => undefined,
  refetch: jest.fn(),
});

jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [P] } }),
  useProduct: (id: string) => ({ data: id === P.id ? P : undefined, isLoading: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [C1, C3] } }),
  useCustomer: (id: string) => ({
    data:
      mockCustomerLoading || mockCustomerError || mockCustomerPaused ? undefined : CUSTOMERS[id],
    isLoading: !!id && mockCustomerLoading,
    // TanStack v5: a query paused offline is pending (no data, no error) but NOT loading.
    isPending: !!id && (mockCustomerLoading || mockCustomerPaused),
    isError: !!id && mockCustomerError,
    refetch: mockRefetchCustomer,
  }),
  useCustomerPrices: (id?: string) => ({
    data: id && !mockPricesError ? mockCustomerPrices : undefined,
    isLoading: false,
    isError: !!id && (mockPricesError || mockPricesErrorWithData),
    refetch: mockRefetchPrices,
  }),
}));
jest.mock("@/lib/api/useCustomerPriceLayer", () => ({
  ...jest.requireActual("@/lib/api/useCustomerPriceLayer"),
  useCustomerPriceLayer: () => mockLayer,
}));

beforeEach(() => {
  mockCustomerLoading = false;
  mockCustomerError = false;
  mockPricesError = false;
  mockPricesErrorWithData = false;
  mockCustomerPaused = false;
  mockCustomerPrices = [];
  mockLayer = layerOff();
});

const renderCreate = (onSubmit = jest.fn()) => {
  renderWithProviders(
    <RecurringInvoiceForm mode="create" onSubmit={onSubmit} isPending={false} submitLabel="Save" />,
  );
  return onSubmit;
};

async function chooseCustomer(name: string) {
  fireEvent.change(screen.getByPlaceholderText("Search customers…"), {
    target: { value: name.slice(0, 4) },
  });
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
}

/** The chosen customer's clear button (icon-only on master), found next to the customer's name. */
function clearCustomer(name: string) {
  const card = screen.getByText(name).closest("div")!.parentElement!;
  fireEvent.click(card.querySelector("button")!);
}

async function pickProduct(index = 0) {
  const input = screen.getAllByPlaceholderText(/Description \/ product…|Loading customer pricing…/)[
    index
  ] as HTMLInputElement;
  fireEvent.change(input, { target: { value: "cola" } });
  fireEvent.click(await screen.findByRole("button", { name: /Cola 12oz/ }));
}

describe("SA-856: a recurring line pre-fills the customer's own price", () => {
  it("a tier-3 customer's picked line pre-fills the tier-3 price, never the list price (master: 10.00)", async () => {
    const onSubmit = renderCreate();
    await chooseCustomer("Tier Three Cafe");
    await pickProduct();
    expect(await screen.findByDisplayValue("8.00")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("10.00")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const line = onSubmit.mock.calls[0][0].items[0];
    expect(line.unitPrice).toBe(8);
    expect(typeof line.unitPrice).toBe("number");
  });

  it("a CustomerPrice override tier wins over the customer's own tier", async () => {
    mockCustomerPrices = [{ productId: P.id, pricingTier: 2, product: P }];
    renderCreate();
    await chooseCustomer("Retail Cafe");
    await pickProduct();
    expect(await screen.findByDisplayValue("9.00")).toBeInTheDocument();
  });

  it("an msrp-only CustomerPrice row (pricingTier null) prices at the customer's own tier", async () => {
    mockCustomerPrices = [{ productId: P.id, pricingTier: null, product: P }];
    renderCreate();
    await chooseCustomer("Tier Three Cafe");
    await pickProduct();
    expect(await screen.findByDisplayValue("8.00")).toBeInTheDocument();
  });

  it("a product picked before any customer is chosen is re-suggested at the customer's price once one is", async () => {
    renderCreate();
    await pickProduct();
    expect(await screen.findByDisplayValue("10.00")).toBeInTheDocument();
    await chooseCustomer("Tier Three Cafe");
    expect(await screen.findByDisplayValue("8.00")).toBeInTheDocument();
  });

  it("the customer's price layer (flag on) is the price when it has a row for the pack", async () => {
    mockLayer = {
      ...layerOff(),
      enabled: true,
      layerOf: (id: string) =>
        id === P.id
          ? [
              {
                ref: "pack",
                label: null,
                price: 7.25,
                listPrice: 10,
                source: "customer",
                aboveList: false,
              },
            ]
          : undefined,
    };
    renderCreate();
    await chooseCustomer("Tier Three Cafe");
    await pickProduct();
    expect(await screen.findByDisplayValue("7.25")).toBeInTheDocument();
  });

  it("a hand-edited price survives a customer change; an unedited one is re-suggested", async () => {
    renderCreate();
    await chooseCustomer("Retail Cafe");
    await pickProduct(0);
    fireEvent.click(screen.getByRole("button", { name: /Add Line Item/ }));
    await pickProduct(1);
    expect(screen.getAllByDisplayValue("10.00")).toHaveLength(2);
    // The operator types their own price on line 1.
    const typed = screen.getAllByDisplayValue("10.00")[0];
    fireEvent.change(typed, { target: { value: "12.34" } });
    fireEvent.blur(typed);
    // Change the customer to a tier-3 one.
    clearCustomer("Retail Cafe");
    await chooseCustomer("Tier Three Cafe");
    expect(await screen.findByDisplayValue("8.00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("12.34")).toBeInTheDocument();
  });

  it("picking waits while the customer's pricing is being read, and Save is disabled", async () => {
    renderCreate();
    await chooseCustomer("Tier Three Cafe");
    mockCustomerLoading = true;
    // Re-render with the customer query in flight: choose the same customer again.
    clearCustomer("Tier Three Cafe");
    await chooseCustomer("Tier Three Cafe");
    const search = (await screen.findByPlaceholderText(
      "Loading customer pricing…",
    )) as HTMLInputElement;
    expect(search).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("SA-868: a failed customer-price read fails CLOSED (never a list-price suggestion)", () => {
  it("picking is disabled with the failed-prices notice and Retry; Save stays allowed", async () => {
    mockPricesError = true;
    const onSubmit = renderCreate();
    await chooseCustomer("Tier Three Cafe");
    // At 50f7d6533: the read failed, customerTierFor(undefined, …) priced the pick and it filled LIST (10.00).
    const search = screen.getByPlaceholderText(
      "Couldn't load this customer's prices.",
    ) as HTMLInputElement;
    expect(search).toBeDisabled();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load this customer's prices.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRefetchPrices).toHaveBeenCalled();
    // Save stays allowed: no suggestion can get in while picking is closed (typed and stored prices are the operator's).
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("SA-868: a customer change whose read fails never re-prices a line", () => {
  it("an unedited tier-3 line keeps 8.00 when the next customer's read fails (never re-priced to list 10.00)", async () => {
    renderCreate();
    await chooseCustomer("Tier Three Cafe");
    await pickProduct();
    expect(await screen.findByDisplayValue("8.00")).toBeInTheDocument();
    clearCustomer("Tier Three Cafe");
    mockCustomerError = true;
    await chooseCustomer("Retail Cafe");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load this customer's prices.",
    );
    expect(screen.getByDisplayValue("8.00")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("10.00")).not.toBeInTheDocument();
    // The line's price is a suggestion the failed read cannot confirm: Save waits for Retry.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("SA-870: a price suggested for one customer is never saved into another's template", () => {
  it("customer A's tier-3 suggestion holds Save after B's failed read; typing a price releases it and saves it", async () => {
    const onSubmit = renderCreate();
    await chooseCustomer("Tier Three Cafe");
    await pickProduct();
    expect(await screen.findByDisplayValue("8.00")).toBeInTheDocument();
    clearCustomer("Tier Three Cafe");
    mockPricesError = true;
    await chooseCustomer("Retail Cafe");
    // At 1c4d42dc7: the line kept A's 8.00 and Save was enabled, submitting 8.00 for B.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load this customer's prices.",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    const price = screen.getByDisplayValue("8.00");
    fireEvent.change(price, { target: { value: "9.00" } });
    fireEvent.blur(price);
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].items[0].unitPrice).toBe(9);
  });

  it("a read error WITH data present (a stale refetch) does not block: picking fills the customer's price", async () => {
    mockPricesErrorWithData = true;
    renderCreate();
    await chooseCustomer("Tier Three Cafe");
    const search = screen.getByPlaceholderText("Description / product…") as HTMLInputElement;
    expect(search).not.toBeDisabled();
    await pickProduct();
    expect(await screen.findByDisplayValue("8.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });
});

describe("SA-870 review: every failed or unread customer price fails closed", () => {
  it("a failed CUSTOMER read (not only prices) closes picking with the notice and Retry", async () => {
    mockCustomerError = true;
    renderCreate();
    await chooseCustomer("Tier Three Cafe");
    expect(screen.getByPlaceholderText("Couldn't load this customer's prices.")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load this customer's prices.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRefetchCustomer).toHaveBeenCalled();
    expect(mockRefetchPrices).toHaveBeenCalled();
  });

  it("a pick made before any customer, then a tier-3 customer with a failed read, holds Save (never list saved)", async () => {
    const onSubmit = renderCreate();
    await pickProduct();
    expect(await screen.findByDisplayValue("10.00")).toBeInTheDocument();
    mockPricesError = true;
    await chooseCustomer("Tier Three Cafe");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load this customer's prices.",
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a customer read PAUSED offline (pending, not loading, no data) blocks picking like a loading one", async () => {
    mockCustomerPaused = true;
    renderCreate();
    await chooseCustomer("Tier Three Cafe");
    expect(screen.getByPlaceholderText("Loading customer pricing…")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("SA-856: existing templates change nothing automatically", () => {
  const template: RecurringInvoice = {
    id: "ri-1",
    customerId: "c3",
    customer: { id: "c3", businessName: "Tier Three Cafe" },
    frequency: "MONTHLY",
    dayOfMonth: 1,
    isActive: true,
    autoSend: false,
    nextRunAt: "2026-11-01T00:00:00.000Z",
    items: [{ productId: P.id, description: "Cola 12oz", qty: 2, unitPrice: 10 }],
    createdAt: "2026-10-01T00:00:00.000Z",
  } as RecurringInvoice;

  it("keeps the stored price and shows the customer's price now, display-only", async () => {
    const onSubmit = jest.fn();
    renderWithProviders(
      <RecurringInvoiceForm
        mode="edit"
        initial={template}
        onSubmit={onSubmit}
        isPending={false}
        submitLabel="Save"
      />,
    );
    expect(await screen.findByText("This customer's price now: $8.00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("10.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].items[0].unitPrice).toBe(10);
  });

  it("shows no marker when the customer's prices could not be read (it would name the list price)", async () => {
    mockCustomerError = true;
    // Stored at the customer's real tier-3 price; with the customer unread the resolver would answer LIST ($10).
    renderWithProviders(
      <RecurringInvoiceForm
        mode="edit"
        initial={{ ...template, items: [{ ...template.items[0], unitPrice: 8 }] }}
        onSubmit={jest.fn()}
        isPending={false}
        submitLabel="Save"
      />,
    );
    await screen.findByDisplayValue("8.00");
    expect(screen.queryByText(/This customer's price now/)).not.toBeInTheDocument();
  });

  it("shows no marker when the stored price already is the customer's price", async () => {
    renderWithProviders(
      <RecurringInvoiceForm
        mode="edit"
        initial={{ ...template, items: [{ ...template.items[0], unitPrice: 8 }] }}
        onSubmit={jest.fn()}
        isPending={false}
        submitLabel="Save"
      />,
    );
    await screen.findByDisplayValue("8.00");
    expect(screen.queryByText(/This customer's price now/)).not.toBeInTheDocument();
  });
});

describe("SA-856 structural pin", () => {
  it("the form never writes the catalog list price into a line", () => {
    const src = fs.readFileSync(path.join(__dirname, "RecurringInvoiceForm.tsx"), "utf8");
    expect(src).not.toMatch(/onChange\([^)]*p\.pricePerUnit\)/);
    expect(src).not.toMatch(/unitPrice:\s*(Number\(|parseFloat\()?\s*(p|product)\.pricePerUnit/);
    expect(src).toContain("useCustomerLinePricing(");
  });
});
