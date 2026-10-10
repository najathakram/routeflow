import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * While the Complete-sale request is in flight, "Ship this order instead" and every cart mutation are OFF: the controls are
 * disabled AND the handlers behind them do nothing. The POST is a promise this test resolves by hand, and the mutation hook is a
 * stateful stand-in with the real `isPending` lifecycle (true from the call until it settles), not a frozen flag.
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

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
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

/** A cart of one Cola, exact cash tendered, Complete pressed and the POST held open. */
async function startPendingSale() {
  const post = deferred<typeof SALE>();
  sendSale.mockReturnValue(post.promise);
  renderWithProviders(<CounterSaleScreen />);
  await scan("COLA", "Cola");
  fireEvent.click(btn("Exact"));
  fireEvent.click(btn("Complete & show receipt"));
  await waitFor(() => expect(sendSale).toHaveBeenCalledTimes(1));
  return post;
}

describe("counter sale: nothing changes while the sale request is in flight", () => {
  it("Ship this order instead is disabled and a click does nothing (no draft, no navigation)", async () => {
    const post = await startPendingSale();
    await waitFor(() => expect(btn("Ship this order instead")).toBeDisabled());

    fireEvent.click(btn("Ship this order instead"));
    await new Promise((r) => setTimeout(r, 30));
    expect(createDraft).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    post.resolve(SALE);
    await screen.findByTestId("counter-sale-receipt");
    expect(createDraft).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("every cart control is disabled, and a scan / customer pick / note / quantity does not land", async () => {
    const post = await startPendingSale();
    await waitFor(() => expect(btn("Remove Cola")).toBeDisabled());

    expect(btn("Add one Cola")).toBeDisabled();
    expect(screen.getByLabelText("Set quantity of Cola")).toBeDisabled();
    expect(btn("Add a note to Cola")).toBeDisabled();
    expect(btn("Edit price for Cola")).toBeDisabled(); // the admin's price control
    expect(screen.getByLabelText("Find a customer")).toBeDisabled();
    expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
    expect(btn("Complete & show receipt")).toBeDisabled();
    expect(btn("Complete & next sale")).toBeDisabled();

    // even if an event slips past `disabled`, the handlers do nothing
    fireEvent.change(screen.getByLabelText("Scan or search items"), { target: { value: "WATER" } });
    fireEvent.submit(screen.getByLabelText("Scan or search items").closest("form")!);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Set quantity of Cola"), { target: { value: "5" } });
    fireEvent.blur(screen.getByLabelText("Set quantity of Cola"));
    await new Promise((r) => setTimeout(r, 30));
    expect(itemCount()).toBe(1);
    expect(screen.getByText(/Cola · × 1/)).toBeInTheDocument();
    expect(screen.queryByText("Acme Co")).toBeNull(); // still the walk-in
    expect(screen.queryByRole("button", { name: "Acme Co" })).toBeNull();

    post.resolve(SALE);
    await screen.findByTestId("counter-sale-receipt");
  });

  it("after a refused sale the controls come back and the cart is as it was", async () => {
    const post = await startPendingSale();
    await waitFor(() => expect(btn("Remove Cola")).toBeDisabled());

    post.reject({ response: { status: 422 } }); // a definitive refusal: nothing was written
    await waitFor(() => expect(btn("Remove Cola")).toBeEnabled());
    expect(btn("Ship this order instead")).toBeEnabled();
    expect(btn("Add one Cola")).toBeEnabled();
    expect(screen.getByLabelText("Find a customer")).toBeEnabled();
    expect(btn("Complete & show receipt")).toBeEnabled();
    expect(itemCount()).toBe(1);

    // and they work again: a step, a note, a second scan
    fireEvent.click(btn("Add one Cola"));
    expect(screen.getByText(/Cola · × 2/)).toBeInTheDocument();
    await scan("WATER", "Water");
    expect(itemCount()).toBe(2);
    fireEvent.click(btn("Ship this order instead"));
    await waitFor(() => expect(screen.getByLabelText("Find a customer")).toHaveFocus());
  });
});
