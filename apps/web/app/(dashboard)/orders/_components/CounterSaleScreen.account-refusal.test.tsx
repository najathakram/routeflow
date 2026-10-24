import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/** B1181: the refusal for "On account" with no customer must not leave the register on a dead, disabled tender. */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "COLA" ? { product: COLA, source: "sku" } : { notFound: true },
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "c1", businessName: "Acme Co", pricingTier: 1 }] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
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

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const scan = async (text: string, name = "Cola") => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await screen.findByRole("button", { name: `Remove ${name}` });
};

describe("CounterSaleScreen: On account refused for a walk-in (B1181)", () => {
  it("resets the tender to Cash, clears the amount and keeps the cart", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("option", { name: "Acme Co" }));
    fireEvent.click(screen.getByRole("radio", { name: "On account" }));
    expect(screen.getByRole("radio", { name: "On account" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // the clerk drops back to the walk-in customer: On account is no longer offered, yet it is still the checked tender
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A walk-in customer can't be charged on account");
    expect(mutateAsync).not.toHaveBeenCalled();
    // RED on master: On account stays checked on a disabled radio, so no tender is selected at all
    expect(screen.getByRole("radio", { name: "Cash" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "On account" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByLabelText("Amount tendered")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete & show receipt" })).toBeEnabled();
  });
});
