import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";
import { QUICK_KEYS_COLLAPSED_STORAGE_KEY } from "./QuickKeysGrid";

/**
 * SA-747 / SA-747r: the QUICK KEYS grid in the counter sale's cart column. A tap is the scan add path
 * (`addScannedProduct`) fed with the key's own `product` (the scan-lookup row the quick-keys answer carries), so the
 * only request the grid ever makes is the quick-keys query: no per-key product fetch, no price on a key.
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const ACME = { id: "c-acme", businessName: "Acme Cafe", pricingTier: 2 };
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
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));
const sendSale = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
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

const COLA = {
  id: "p-cola",
  name: "Sample Cola",
  pricePerUnit: 2.5,
  priceTier2: 2,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
};
const WATER = {
  id: "p-water",
  name: "Sample Water",
  pricePerUnit: 12,
  priceTier2: 9,
  unit: "case",
  unitsPerBox: 12,
  isActive: true,
};
const keyFor = (p: typeof COLA | typeof WATER, extra: object = {}) => ({
  productId: p.id,
  name: p.name,
  sellLevel: p.unitsPerBox ? "BOX" : "UNIT",
  pinned: false,
  product: p,
  ...extra,
});
let quickKeysAnswer: () => Promise<unknown>;
const get = apiClient.get as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  quickKeysAnswer = async () => ({
    data: {
      register: "main",
      cap: 12,
      keys: [keyFor(COLA, { pinned: true }), keyFor(WATER)],
    },
  });
  get.mockImplementation((url: string) =>
    url === "/orders/counter-sale/quick-keys"
      ? quickKeysAnswer()
      : Promise.resolve({ data: { taxRate: 0 } }),
  );
  sendSale.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 2.5,
    paid: 2.5,
    balanceDue: 0,
    change: 0,
    paymentRecorded: true,
  });
});

const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");
const colaKey = () => screen.findByTestId("quick-key-p-cola");
const total = () => screen.getByTestId("running-total");

describe("QuickKeysGrid: a tap is the scan add path", () => {
  it("one tap adds exactly ONE line at the walk-in price, with no request beyond the quick-keys query", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await colaKey());
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(total()).toHaveTextContent("$2.50");
    const urls = get.mock.calls.map((c) => c[0] as string);
    // the tap re-reads the same quick-keys answer for a fresh price (#3356); never a per-key /products fetch
    expect(urls.filter((u) => u === "/orders/counter-sale/quick-keys")).toHaveLength(2);
    expect(urls.some((u) => u.startsWith("/products"))).toBe(false);
  });

  it("#3356: a price changed server-side after the grid loaded is the price the next tap adds", async () => {
    renderWithProviders(<CounterSaleScreen />);
    const cola = await colaKey();
    quickKeysAnswer = async () => ({
      data: {
        register: "main",
        cap: 12,
        keys: [keyFor({ ...COLA, pricePerUnit: 3.1 }, { pinned: true }), keyFor(WATER)],
      },
    });
    fireEvent.click(cola);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(total()).toHaveTextContent("$3.10");
  });

  it("#3356: if the refresh fails the tap still adds from the loaded key", async () => {
    renderWithProviders(<CounterSaleScreen />);
    const cola = await colaKey();
    quickKeysAnswer = async () => {
      throw new Error("offline");
    };
    fireEvent.click(cola);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(total()).toHaveTextContent("$2.50");
  });

  it("a second tap on the same product adds to the SAME line", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await colaKey());
    fireEvent.click(await colaKey());
    await waitFor(() => expect(screen.getByText(/Sample Cola · × 2/)).toBeInTheDocument());
    expect(lines()).toHaveLength(1);
    expect(total()).toHaveTextContent("$5.00");
  });

  it("a boxed product lands as a whole case at its sell level", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await screen.findByTestId("quick-key-p-water"));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(total()).toHaveTextContent("$12.00");
  });

  it("prices at the picked customer's tier", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("option", { name: "Acme Cafe" }));
    fireEvent.click(await colaKey());
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(total()).toHaveTextContent("$2.00"); // tier 2, not the 2.50 walk-in price
  });

  it("hands focus back to the scan field after a POINTER tap", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await colaKey(), { detail: 1 });
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
  });

  it("a KEYBOARD activation (detail 0) keeps focus on the key so Tab/Enter can walk the grid", async () => {
    renderWithProviders(<CounterSaleScreen />);
    const cola = await colaKey();
    const water = await screen.findByTestId("quick-key-p-water");
    cola.focus();
    fireEvent.click(cola, { detail: 0 });
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(cola).toHaveFocus();
    water.focus();
    fireEvent.click(water, { detail: 0 });
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(water).toHaveFocus();
  });

  it("two variants with the same variant name read as 'Parent - Variant' on their keys", async () => {
    const variant = (id: string, parent: string) => ({
      id,
      name: "Strawberry",
      variantName: "Strawberry",
      parentProductId: `${id}-parent`,
      parent: { name: parent },
      pricePerUnit: 4,
      unit: "each",
      unitsPerBox: null,
      isActive: true,
    });
    quickKeysAnswer = async () => ({
      data: {
        register: "main",
        cap: 12,
        keys: [
          {
            productId: "v-a",
            name: "Strawberry",
            sellLevel: "UNIT",
            pinned: false,
            product: variant("v-a", "Brand A"),
          },
          {
            productId: "v-b",
            name: "Strawberry",
            sellLevel: "UNIT",
            pinned: false,
            product: variant("v-b", "Brand B"),
          },
        ],
      },
    });
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByTestId("quick-key-v-a")).toHaveTextContent("Brand A - Strawberry");
    expect(screen.getByTestId("quick-key-v-b")).toHaveTextContent("Brand B - Strawberry");
  });

  it("shows no price on a key", async () => {
    renderWithProviders(<CounterSaleScreen />);
    const key = await colaKey();
    expect(key.textContent).not.toMatch(/\$|\d+\.\d{2}/);
    expect(key).toHaveTextContent("Sample Cola");
  });
});

describe("QuickKeysGrid: frozen carts ignore taps", () => {
  it("an UNKNOWN-outcome (held) cart: keys are aria-disabled and a tap adds nothing", async () => {
    sendSale.mockRejectedValue({ response: { status: 500 } });
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await colaKey());
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-outcome-unknown");
    const key = await colaKey();
    expect(key).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(key);
    await new Promise((r) => setTimeout(r, 30));
    expect(lines()).toHaveLength(1);
    expect(screen.getByText(/Sample Cola · × 1/)).toBeInTheDocument();
  });

  it("while the sale request is in flight a tap adds nothing", async () => {
    let resolveSale!: (v: unknown) => void;
    sendSale.mockReturnValue(new Promise((r) => (resolveSale = r)));
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await colaKey());
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(sendSale).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("quick-key-p-cola")).toHaveAttribute("aria-disabled", "true"),
    );
    fireEvent.click(screen.getByTestId("quick-key-p-cola"));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/Sample Cola · × 1/)).toBeInTheDocument();
    resolveSale({
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: 2.5,
      paid: 2.5,
      balanceDue: 0,
      change: 0,
      paymentRecorded: true,
    });
    await screen.findByTestId("counter-sale-receipt");
  });

  it("#3356: a tap whose refresh outlives the sale never lands in the finished sale or the next cart", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await colaKey());
    await waitFor(() => expect(lines()).toHaveLength(1));
    // the NEXT tap's refresh hangs on a promise the test controls
    let release!: () => void;
    quickKeysAnswer = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            data: { register: "main", cap: 12, keys: [keyFor(WATER)] },
          });
      });
    fireEvent.click(screen.getByTestId("quick-key-p-water"));
    await waitFor(() => expect(release).toBeDefined());
    // meanwhile the sale finishes, then the clerk starts a new one
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    fireEvent.click(screen.getByRole("button", { name: "New sale" }));
    await screen.findByTestId("quick-keys");
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(lines()).toHaveLength(0);
    expect(total()).toHaveTextContent("$0.00");
  });

  it("the receipt view has no grid to tap", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await colaKey());
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    expect(screen.queryByTestId("quick-keys")).toBeNull();
  });
});

describe("QuickKeysGrid: states", () => {
  it("empty answer: the fixed empty-state text and an Edit keys link", async () => {
    quickKeysAnswer = async () => ({ data: { register: "main", cap: 12, keys: [] } });
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByTestId("quick-keys-empty")).toHaveTextContent(
      "Your best sellers appear here after a few sales — or pin products now.",
    );
    expect(screen.getByRole("button", { name: "Edit keys" })).toBeInTheDocument();
  });

  it("a failed quick-keys query shows no grid and no empty-state claim, and the till still works", async () => {
    quickKeysAnswer = () => Promise.reject({ response: { status: 500 } });
    renderWithProviders(<CounterSaleScreen />);
    await waitFor(() =>
      expect(get.mock.calls.some((c) => c[0] === "/orders/counter-sale/quick-keys")).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("quick-keys")).toBeNull();
    expect(screen.queryByTestId("quick-keys-empty")).toBeNull();
    expect(screen.getByLabelText("Scan or search items")).toBeInTheDocument();
  });

  it("the collapsed state is remembered in localStorage and restored", async () => {
    const first = renderWithProviders(<CounterSaleScreen />);
    await colaKey();
    fireEvent.click(screen.getByRole("button", { name: /Quick keys/ }));
    expect(screen.queryByTestId("quick-key-p-cola")).toBeNull();
    first.unmount();
    renderWithProviders(<CounterSaleScreen />);
    const toggle = await screen.findByRole("button", { name: /Quick keys/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("quick-key-p-cola")).toBeNull();
    fireEvent.click(toggle);
    expect(await colaKey()).toBeInTheDocument();
  });

  it("works when localStorage throws on the section's own reads and writes", async () => {
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    const blocked = (k: string) => k === QUICK_KEYS_COLLAPSED_STORAGE_KEY;
    const spies = [
      jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (
        this: Storage,
        k: string,
      ) {
        if (blocked(k)) throw new Error("blocked");
        return realGet.call(this, k);
      }),
      jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        k: string,
        v: string,
      ) {
        if (blocked(k)) throw new Error("blocked");
        return realSet.call(this, k, v);
      }),
    ];
    try {
      renderWithProviders(<CounterSaleScreen />);
      fireEvent.click(await colaKey());
      await waitFor(() => expect(lines()).toHaveLength(1));
      const toggle = screen.getByRole("button", { name: /Quick keys/ });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("quick-key-p-cola")).toBeNull();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("keys are 44 px targets and the pinned one carries a marker", async () => {
    renderWithProviders(<CounterSaleScreen />);
    const key = await colaKey();
    expect(key.className).toContain("min-h-[44px]");
    expect(within(key).getByTestId("quick-key-pin")).toBeInTheDocument();
    expect(
      within(await screen.findByTestId("quick-key-p-water")).queryByTestId("quick-key-pin"),
    ).toBeNull();
  });

  it("Edit keys opens the editor dialog", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await colaKey();
    fireEvent.click(screen.getByRole("button", { name: "Edit keys" }));
    expect(await screen.findByRole("dialog", { name: "Edit quick keys" })).toBeInTheDocument();
  });
});
