import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";
import { getCounterCartBusy, setCounterCartBusy } from "@/lib/counter-cart-signal";

/**
 * B1210: "Ship this order instead" saves the counter cart + customer as a parked ORDER draft (POST /drafts, fulfillPath SHIP) and
 * resumes it in the order builder. The cart is cleared only once the draft exists; a failed save leaves everything intact; a
 * walk-in is asked for a customer first and the hand-off then continues on its own.
 */

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
const createDraft = jest.fn();
let draftPending = false;
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutateAsync: createDraft, isPending: draftPending }),
}));
const COLA = {
  id: "p-cola",
  name: "Cola",
  pricePerUnit: 2.5,
  priceTier3: 2,
  unit: "each",
  unitsPerBox: null,
};
const WATER = { id: "p-water", name: "Water", pricePerUnit: 12, unit: "case", unitsPerBox: 12 };
let productFor: Record<string, unknown> = {};
let resolveHook: ((code: string) => Promise<unknown>) | null = null;
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    resolveHook
      ? resolveHook(code)
      : productFor[code]
        ? { product: productFor[code], source: "sku" }
        : { notFound: true },
}));
let customersFor: unknown[] = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: customersFor } }),
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
let salePending = false;
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP"], staffDefault: "SHIP" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: salePending }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const ACME = { id: "c1", businessName: "Acme Co", pricingTier: 3, fulfillPath: "ROUTE" };
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  jest.clearAllMocks();
  salePending = false;
  draftPending = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  resolveHook = null;
  customersFor = [ACME];
  productFor = { COLA, WATER };
  createDraft.mockResolvedValue({ id: "d-1" });
});

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};
const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");
const pickAcme = () => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
  fireEvent.click(screen.getByRole("button", { name: "Acme Co" }));
};
const shipBtn = () => screen.getByRole("button", { name: "Ship this order instead" });

describe("B1210: Ship this order instead -> a parked ORDER draft", () => {
  it("2 lines + a customer: POST /drafts with the mapped payload, then the builder resumes it", async () => {
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    await scan("COLA");
    await scan("WATER");
    await waitFor(() => expect(lines()).toHaveLength(2));
    fireEvent.click(shipBtn());

    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    const dto = createDraft.mock.calls[0][0];
    expect(dto).toMatchObject({
      kind: "ORDER",
      customerId: "c1",
      customerName: "Acme Co",
      title: "Order, Acme Co",
    });
    expect(dto.payload.fulfillPath).toBe("SHIP");
    expect(dto.payload.customer).toEqual({ id: "c1", businessName: "Acme Co", pricingTier: 3 });
    expect(dto.payload.lineItems).toHaveLength(2);
    // the price the clerk saw (tier 3 = 2.00) and the product snapshot ride along
    expect(dto.payload.lineItems[0]).toMatchObject({
      productId: "p-cola",
      unitPrice: 2,
      listPrice: 2.5,
      unit: "each",
      priceType: "SPECIAL",
      qty: 1,
    });
    expect(dto.payload.lineItems[1]).toMatchObject({
      productId: "p-water",
      unitsPerBox: 12,
      boxes: 1,
      pieces: 0,
      qty: 12,
      unit: "case",
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/orders?resumeDraft=d-1"));
    expect(mutateAsync).not.toHaveBeenCalled(); // nothing was sold
  });

  it("the cart is cleared only AFTER the draft exists", async () => {
    const reply = deferred<{ id: string }>();
    createDraft.mockReturnValue(reply.promise);
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    await scan("COLA");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(shipBtn());
    await waitFor(() => expect(createDraft).toHaveBeenCalled());
    expect(lines()).toHaveLength(1); // still there while the save is in flight
    expect(push).not.toHaveBeenCalled();
    reply.resolve({ id: "d-9" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/orders?resumeDraft=d-9"));
    await waitFor(() => expect(lines()).toHaveLength(0));
  });

  it("a ship hand-off never navigates after the counter has been left (unmounted)", async () => {
    const draft = deferred<{ id: string }>();
    createDraft.mockReturnValue(draft.promise);
    const view = renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    await scan("COLA");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(shipBtn());
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    view.unmount(); // the clerk left the counter while the draft was saving
    draft.resolve({ id: "d-1" });
    await new Promise((r) => setTimeout(r, 30));
    expect(push).not.toHaveBeenCalled();
  });

  it("publishes busy while the ship draft is saving", async () => {
    const view = renderWithProviders(<CounterSaleScreen />);
    draftPending = true;
    view.rerender(<CounterSaleScreen />);
    await waitFor(() => expect(getCounterCartBusy()).toBe(true));
    draftPending = false;
    view.rerender(<CounterSaleScreen />);
    await waitFor(() => expect(getCounterCartBusy()).toBe(false));
    setCounterCartBusy(false);
  });

  it("a double click is ONE draft", async () => {
    const reply = deferred<{ id: string }>();
    createDraft.mockReturnValue(reply.promise);
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    await scan("COLA");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(shipBtn());
    fireEvent.click(shipBtn());
    reply.resolve({ id: "d-1" });
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it("a POST failure keeps the cart and the customer, shows the copy, and Ship works again", async () => {
    createDraft.mockRejectedValueOnce({ response: { status: 500 } });
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    await scan("COLA");
    await scan("WATER");
    await waitFor(() => expect(lines()).toHaveLength(2));
    fireEvent.click(shipBtn());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't move this sale to shipping. Try again.",
    );
    expect(push).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(2);
    expect(screen.getByText("Acme Co")).toBeInTheDocument();
    expect(shipBtn()).toBeEnabled();

    fireEvent.click(shipBtn()); // Try again: a second POST now succeeds
    await waitFor(() => expect(push).toHaveBeenCalledWith("/orders?resumeDraft=d-1"));
    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Couldn't move this sale/)).toBeNull();
  });

  it("a walk-in cart: focuses the customer field with the caption, makes NO draft until a pick, then continues on its own", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(shipBtn());

    const find = screen.getByLabelText("Find a customer");
    await waitFor(() => expect(find).toHaveFocus());
    expect(screen.getByText("Who are we shipping to? Find a customer.")).toBeInTheDocument();
    expect(createDraft).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(1); // the cart is kept

    pickAcme();
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft.mock.calls[0][0].customerId).toBe("c1");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/orders?resumeDraft=d-1"));
    expect(screen.queryByText("Who are we shipping to? Find a customer.")).toBeNull();
  });

  it("a scan still resolving is not lost: the hand-off waits for it", async () => {
    const reply = deferred<unknown>();
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    await scan("COLA");
    await waitFor(() => expect(lines()).toHaveLength(1));
    resolveHook = () => reply.promise;
    await scan("WATER");
    fireEvent.click(shipBtn());
    expect(createDraft).not.toHaveBeenCalled();
    reply.resolve({ product: WATER, source: "sku" });
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft.mock.calls[0][0].payload.lineItems).toHaveLength(2);
  });

  it("an empty cart keeps the old URL hand-off (nothing to carry): no draft", () => {
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    fireEvent.click(shipBtn());
    expect(createDraft).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/orders?action=new&ship=1&preselect=SHIP");
  });

  it("the button keeps its place and label, and is disabled while the outcome is unknown (locked)", async () => {
    mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-outcome-unknown");
    expect(shipBtn()).toBeDisabled();
    fireEvent.click(shipBtn());
    expect(createDraft).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("one cart is never BOTH rung up AND parked as a ship draft", () => {
  const SALE = {
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 2.5,
    paid: 2.5,
    balanceDue: 0,
    paymentRecorded: true,
  };

  it("Complete, then Ship while the sale POST is in flight: no draft, no navigation, the sale is untouched", async () => {
    const post = deferred<typeof SALE>();
    mutateAsync.mockReturnValue(post.promise);
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    fireEvent.click(shipBtn());
    // the customer pick that would let an armed hand-off run is itself frozen while the sale posts
    expect(screen.queryByRole("button", { name: "Acme Co" })).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(createDraft).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    post.resolve(SALE);
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(createDraft).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("a pending ship continues once a sale POST that held it back ends (a clean 4xx writes nothing)", async () => {
    const scanDone = deferred<unknown>();
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    resolveHook = () => scanDone.promise;
    const field = screen.getByLabelText("Scan or search items");
    fireEvent.change(field, { target: { value: "COLA" } });
    fireEvent.submit(field.closest("form")!);
    fireEvent.click(shipBtn()); // armed while the scan is still resolving: the hand-off waits
    salePending = true; // a sale POST is in flight when the scan lands
    scanDone.resolve({ product: COLA, source: "sku" });
    await waitFor(() => expect(lines()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(createDraft).not.toHaveBeenCalled(); // never both rung up AND parked
    salePending = false; // the POST failed cleanly (4xx): nothing was written
    fireEvent.click(screen.getByRole("button", { name: "Card" })); // any re-render reads the flag
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/orders?resumeDraft=d-1"));
  });

  it("the Ship button is disabled while the sale POST is pending", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    salePending = true;
    fireEvent.click(screen.getByRole("button", { name: "Card" })); // any state change re-reads the flag
    expect(shipBtn()).toBeDisabled();
  });

  it("Ship, then Enter in the cash field while the draft saves: no sale POST", async () => {
    const draft = deferred<{ id: string }>();
    createDraft.mockReturnValue(draft.promise);
    renderWithProviders(<CounterSaleScreen />);
    pickAcme();
    await scan("COLA");
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(shipBtn());
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByLabelText("Amount tendered"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & next sale" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(mutateAsync).not.toHaveBeenCalled();
    draft.resolve({ id: "d-1" });
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("both Complete buttons are disabled while the draft saves", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    draftPending = true;
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    expect(screen.getByRole("button", { name: "Complete & show receipt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Complete & next sale" })).toBeDisabled();
  });
});
