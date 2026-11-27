import * as React from "react";
import { act } from "@testing-library/react";
import { screen, waitFor, fireEvent } from "@/test-utils/render";
import userEvent from "@testing-library/user-event";
import { createNavShortcutHandler } from "@/lib/nav-shortcuts";
import { renderTill } from "@/test-utils/render-till";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";
import { installScanClock } from "@/test-utils/scan-clock";

/** W-1459 / B1468: a card or check amount over the total is said while typing and keeps Complete off. */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const mockLookups: string[] = [];
// SA-1138: codes a wedge types that start with a lowercase letter, punctuation, or AltGr @, all mapped to the one product
const MOCK_CASE_CODES = ["CASE", "cola12345678", "-ab12cd34", "@AB1234"];
const CASE = { id: "p-case", name: "Case", pricePerUnit: 12.5, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) => {
    mockLookups.push(code);
    return MOCK_CASE_CODES.includes(code) ? { product: CASE, source: "sku" } : { notFound: true };
  },
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({
    data: {
      data: [
        { id: "c-plain", businessName: "Plain Cafe", pricingTier: 1 },
        { id: "c-walkin", businessName: "Walk-in Record", pricingTier: 1, isWalkIn: true },
      ],
    },
  }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const get = apiClient.get as unknown as jest.Mock;
const HINT = "Press Enter again to complete the sale.";
const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 12.5,
  paid: 12.5,
  balanceDue: 0,
  paymentRecorded: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  get.mockImplementation((url: string) => {
    if (/^\/customers\/[^/]+\/statement$/.test(url))
      return Promise.resolve({
        data: { outstandingAmount: 0, overdueAmount: 0, availableCredit: 0, autoApplyCredit: 0 },
      });
    if (url === "/settings") return Promise.resolve({ data: { taxRate: 0, timezone: "UTC" } });
    if (url === "/orders/counter-sale/parked")
      return Promise.resolve({ data: { data: [], total: 0, page: 1, pageSize: 20 } });
    return Promise.resolve({ data: [] });
  });
  mutateAsync.mockResolvedValue(SALE);
});

const scanCase = async () => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: "CASE" } });
  fireEvent.submit(field.closest("form")!);
  await screen.findByRole("button", { name: "Remove Case" });
};
const pickPlain = () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "plain" } });
  fireEvent.click(screen.getByRole("option", { name: "Plain Cafe" }));
};
const completeBtn = () => screen.getByRole("button", { name: "Complete & show receipt" });
const nextBtn = () => screen.getByRole("button", { name: "Complete & next sale" });

installScanClock();

describe("W-1459 B1468: card or check amount over the total", () => {
  it("shows the figures and keeps both Complete buttons off while a card amount is over", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    await user.type(screen.getByLabelText("Amount paying now"), "20");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "$20.00 is more than the $12.50 total. Check the card amount.",
    );
    expect(completeBtn()).toBeDisabled();
    expect(nextBtn()).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("says check amount for a check, and clears once fixed", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Check" }));
    const field = screen.getByLabelText("Amount paying now");
    await user.type(field, "20");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "$20.00 is more than the $12.50 total. Check the check amount.",
    );
    await user.clear(field);
    await user.type(field, "5");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(completeBtn()).not.toBeDisabled();
  });

  it("an amount equal to the total is a full payment and stays enabled", async () => {
    const user = userEvent.setup();
    renderTill(<CounterSaleScreen />);
    pickPlain();
    await scanCase();
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    await user.type(screen.getByLabelText("Amount paying now"), "12.50");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(completeBtn()).not.toBeDisabled();
  });
});
