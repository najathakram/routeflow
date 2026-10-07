import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

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
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutateAsync: createDraft, isPending: false }),
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
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP"], staffDefault: "SHIP" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
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
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    await screen.findByTestId("counter-outcome-unknown");
    expect(shipBtn()).toBeDisabled();
    fireEvent.click(shipBtn());
    expect(createDraft).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
