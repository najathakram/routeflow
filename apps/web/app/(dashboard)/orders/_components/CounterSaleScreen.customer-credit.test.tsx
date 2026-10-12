import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-07: a picked customer shows their terms, credit limit and open balance, an amber OVERDUE flag when they have overdue
 * invoices, and an informational OVER-LIMIT note. Display only: the sale is never blocked (owner ruling 10-07).
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const ACME = { id: "c-acme", businessName: "Acme Cafe", pricingTier: 1 };
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [ACME] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const get = apiClient.get as unknown as jest.Mock;
let customerRecord: Record<string, unknown>;
let statement: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  customerRecord = { id: "c-acme", defaultPaymentTerms: "Net 15", creditLimit: 1000 };
  statement = { outstandingAmount: 400, overdueAmount: 0, creditExposure: 400 };
  get.mockImplementation((url: string) => {
    if (url === "/customers/c-acme") return Promise.resolve({ data: customerRecord });
    if (url === "/customers/c-acme/statement") return Promise.resolve({ data: statement });
    if (url === "/settings/invoice") return Promise.resolve({ data: { defaultTerms: "Net 30" } });
    return Promise.resolve({ data: { taxRate: 0 } });
  });
});

const pickAcme = () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  fireEvent.click(screen.getByRole("button", { name: "Acme Cafe" }));
};

describe("CounterSaleScreen: a picked customer's account signal (CQ-07)", () => {
  it("shows the customer's terms, credit limit and open balance", async () => {
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    const box = await screen.findByTestId("counter-customer-credit");
    await waitFor(() => expect(box).toHaveTextContent("Open balance$400.00"));
    expect(box).toHaveTextContent("TermsNet 15");
    expect(box).toHaveTextContent("Credit limit$1,000.00");
    expect(screen.queryByTestId("counter-customer-overdue")).toBeNull();
    expect(screen.queryByTestId("counter-customer-over-limit")).toBeNull();
  });

  it("a credit limit of 0 is a zero limit, not 'no limit': any open balance is over it", async () => {
    customerRecord = { id: "c-acme", defaultPaymentTerms: "Net 15", creditLimit: 0 };
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    const box = await screen.findByTestId("counter-customer-credit");
    await waitFor(() => expect(box).toHaveTextContent("Credit limit$0.00"));
    expect(box).not.toHaveTextContent("No limit");
    const note = await screen.findByTestId("counter-customer-over-limit");
    expect(note).toHaveTextContent("$400.00");
  });

  it("a zero limit with nothing owed shows no over-limit note", async () => {
    customerRecord = { id: "c-acme", defaultPaymentTerms: "Net 15", creditLimit: "0.00" };
    statement = { outstandingAmount: 0, overdueAmount: 0, creditExposure: 0 };
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    const box = await screen.findByTestId("counter-customer-credit");
    await waitFor(() => expect(box).toHaveTextContent("Credit limit$0.00"));
    expect(screen.queryByTestId("counter-customer-over-limit")).toBeNull();
  });

  it("falls back to the business's default terms when the customer has none of their own", async () => {
    customerRecord = { id: "c-acme", defaultPaymentTerms: "", creditLimit: null };
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    const box = await screen.findByTestId("counter-customer-credit");
    await waitFor(() => expect(box).toHaveTextContent("TermsNet 30"));
    expect(box).toHaveTextContent("Credit limitNo limit");
  });

  it("flags overdue invoices in amber, and still lets the sale go ahead", async () => {
    statement = { outstandingAmount: 400, overdueAmount: 150.5, creditExposure: 400 };
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    const flag = await screen.findByTestId("counter-customer-overdue");
    expect(flag).toHaveTextContent("Overdue $150.50");
    expect(flag.className).toMatch(/amber/);
    expect(screen.getByRole("button", { name: "Complete & show receipt" })).not.toBeDisabled();
  });

  it("notes, without blocking, that the open balance is over the credit limit", async () => {
    statement = { outstandingAmount: 1250, overdueAmount: 0, creditExposure: 1250 };
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    const note = await screen.findByTestId("counter-customer-over-limit");
    expect(note).toHaveTextContent("Over the credit limit by $250.00");
    expect(note).toHaveTextContent("not blocked");
    expect(screen.getByRole("button", { name: "Complete & show receipt" })).not.toBeDisabled();
  });

  it("shows nothing for the walk-in customer", () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.queryByTestId("counter-customer-credit")).toBeNull();
  });
});
