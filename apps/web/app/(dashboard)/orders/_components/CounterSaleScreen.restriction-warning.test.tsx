import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import userEvent from "@testing-library/user-event";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Row 510: a counter sale the API answers with 409 RESTRICTION_WARNING (nothing written) opens the warning dialog. "Sell
 * anyway" re-rings the SAME cart with the SAME Idempotency-Key plus the per-line reasons and the hash; "Go back" leaves the
 * cart intact and unlocked (no outcome-unknown lock, no error banner).
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const WATER = { id: "p-water", name: "Water", pricePerUnit: 3, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "COLA"
      ? { product: COLA, source: "sku" }
      : code === "WATER"
        ? { product: WATER, source: "sku" }
        : { notFound: true },
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
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

const SALE = {
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 2.5,
  paid: 2.5,
  balanceDue: 0,
  change: 0,
  paymentRecorded: true,
};
const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "n:0",
          productId: "p-cola",
          displayName: "Cola",
          outcome: "BLOCK",
          rules: [
            {
              id: "r1",
              states: ["CA"],
              legal: true,
              reasonText: "This product is banned in CA by law.",
            },
          ],
        },
      ],
    },
  },
};
const complete = () => screen.getByRole("button", { name: "Complete & show receipt" });

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  let n = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => `key-${++n}`,
  });
});

const ringCola = async () => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: "COLA" } });
  fireEvent.submit(field.closest("form")!);
  await screen.findByRole("button", { name: "Remove Cola" });
  fireEvent.click(screen.getByRole("button", { name: "$20" }));
};

describe("CounterSaleScreen: row 510 restriction warning", () => {
  it("warns, then re-rings the same cart with the same key and the ack", async () => {
    const user = userEvent.setup();
    mutateAsync.mockRejectedValueOnce(warning409);
    mutateAsync.mockResolvedValueOnce(SALE);
    renderWithProviders(<CounterSaleScreen />);
    await ringCola();
    fireEvent.click(complete());
    expect(await screen.findByText("This product is banned in CA by law.")).toBeInTheDocument();
    // not the unknown-outcome lock, not the generic refusal banner
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.type(screen.getByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    const [first, second] = mutateAsync.mock.calls.map((c) => c[0]);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.dto).toEqual({
      ...first.dto,
      restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    });
    await screen.findByTestId("counter-sale-receipt");
  });

  it("Go back keeps the cart and unlocks the screen", async () => {
    const user = userEvent.setup();
    mutateAsync.mockRejectedValueOnce(warning409);
    renderWithProviders(<CounterSaleScreen />);
    await ringCola();
    fireEvent.click(complete());
    await user.click(await screen.findByRole("button", { name: "Go back" }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Remove Cola" })).not.toBeDisabled();
    expect(complete()).not.toBeDisabled();
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
  });
});
