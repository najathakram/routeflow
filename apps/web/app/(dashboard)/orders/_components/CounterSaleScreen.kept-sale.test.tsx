import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Row 466 (counter sale): POST /orders/counter-sale runs createSale, which commits the order and then builds and
 * sends its invoice. When a later step fails, the error body names the committed order (and the invoice, if it
 * exists). The till must treat that as "the sale exists": the key is kept (Try again finishes the SAME sale),
 * the cart stays locked, and the clerk is offered a link to the recorded invoice or order. A 400/409 carrying an
 * id used to be read as a definitive refusal, which dropped the key and unlocked the cart, so ringing it again
 * made a second sale.
 */
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme", role: "TENANT_ADMIN" } }),
}));
const createDraft = jest.fn();
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutateAsync: createDraft, isPending: false }),
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
const ACME = { id: "c1", businessName: "Acme Co", pricingTier: 1, fulfillPath: "ROUTE" };
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
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
const sendSale = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP"], staffDefault: "SHIP" },
  }),
  useCreateCounterSale: () => {
    const R = jest.requireActual("react") as typeof React;
    const [isPending, setPending] = R.useState(false);
    return {
      isPending,
      mutateAsync: async (v: unknown) => {
        setPending(true);
        try {
          return await sendSale(v);
        } finally {
          setPending(false);
        }
      },
    };
  },
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  createDraft.mockResolvedValue({ id: "d-1" });
});

const scan = async (text: string, name: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await screen.findByRole("button", { name: `Remove ${name}` });
};
const btn = (name: string) => screen.getByRole("button", { name });
const itemCount = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.").length;

const sendFailure = (status: number, data: Record<string, unknown>) => ({
  response: { status, data },
});

async function ringColaAndFail(err: unknown) {
  sendSale.mockRejectedValue(err);
  renderWithProviders(<CounterSaleScreen />);
  await scan("COLA", "Cola");
  fireEvent.click(btn("Exact"));
  fireEvent.click(btn("Complete & show receipt"));
  await waitFor(() => expect(sendSale).toHaveBeenCalledTimes(1));
}

describe("counter sale: a failure after the sale committed keeps it (row 466)", () => {
  it("a coded 500 carrying orderId locks the till as 'outcome unknown' and links the order", async () => {
    await ringColaAndFail(sendFailure(500, { code: "SALE_INVOICE_CREATE_FAILED", orderId: "o1" }));
    const alert = await screen.findByTestId("counter-outcome-unknown");
    expect(within(alert).getByRole("link", { name: "Open it" })).toHaveAttribute(
      "href",
      "/orders/o1",
    );
  });

  it("a 400 carrying invoiceId + orderId is NOT a definitive refusal: the till stays locked and links the invoice", async () => {
    await ringColaAndFail(
      sendFailure(400, { statusCode: 400, message: "raw words", invoiceId: "i1", orderId: "o1" }),
    );
    const alert = await screen.findByTestId("counter-outcome-unknown");
    expect(within(alert).getByRole("link", { name: "Open it" })).toHaveAttribute(
      "href",
      "/invoices/i1",
    );
    expect(alert.textContent).not.toContain("raw words");
    // Retrying re-sends the SAME key (it finishes the one sale), never a fresh one.
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sendSale).toHaveBeenCalledTimes(2));
    expect(sendSale.mock.calls[1][0].idempotencyKey).toBe(sendSale.mock.calls[0][0].idempotencyKey);
  });

  it("control: a 400 with NO id is still a definitive refusal (no outcome-unknown, no link)", async () => {
    await ringColaAndFail(sendFailure(400, { statusCode: 400, message: "Customer not found" }));
    await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
    expect(screen.queryByRole("link", { name: "Open it" })).toBeNull();
  });
});
