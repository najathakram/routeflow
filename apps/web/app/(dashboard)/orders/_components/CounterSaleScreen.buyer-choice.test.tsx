import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * S5 (RULES-AUDIT C19, owner Q4): no silent walk-in. A fresh till asks "Who's buying?"; Complete is off, with a visible
 * reason, until a customer is picked or Walk-in is tapped; park / resume and a refresh keep the choice (Walk-in too).
 * Scanning is never blocked by the question. Decision: the question is on screen as soon as the till opens and only
 * Complete waits for it. The park API is a tiny in-memory server at the apiClient seam.
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-o", tenantSlug: "acme", role: "OPERATOR" } }),
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
const ACME = { id: "c-acme", businessName: "Acme Cafe", pricingTier: 2, fulfillPath: null };
const BOLT = { id: "c-bolt", businessName: "Bolt Deli", pricingTier: 1, fulfillPath: null };
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));
// SA-1068: the till reads the customer's remembered prices (an empty, answered read here: no sticky upsell).
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCustomerPriceHistory: () => ({
    data: {},
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [ACME, BOLT] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
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
const post = apiClient.post as unknown as jest.Mock;
const PARKED = "/orders/counter-sale/parked";
let rows: { id: string; label: string; payload: unknown }[];

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  rows = [];
  get.mockImplementation((url: string) => {
    if (url === "/settings") return Promise.resolve({ data: { taxRate: 0 } });
    if (url === PARKED)
      return Promise.resolve({
        data: {
          data: rows.map((r) => ({
            id: r.id,
            label: r.label,
            registerKey: "main",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            lineCount: 1,
          })),
          total: rows.length,
          page: 1,
          pageSize: 20,
        },
      });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url: string, body?: { id: string; payload: unknown }) => {
    if (url === PARKED && body) {
      rows.push({ id: body.id, label: `Hold ${rows.length + 1}`, payload: body.payload });
      return Promise.resolve({ data: { id: body.id } });
    }
    const m = /\/parked\/(.+)\/resume$/.exec(url);
    if (m) {
      const row = rows.find((r) => r.id === decodeURIComponent(m[1]))!;
      rows = rows.filter((r) => r !== row);
      return Promise.resolve({
        data: { id: row.id, label: row.label, createdAt: "t", payload: row.payload },
      });
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
  mutateAsync.mockResolvedValue({
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

const scanCola = async () => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: "COLA" } });
  fireEvent.submit(field.closest("form")!);
  await screen.findByRole("button", { name: "Remove Cola" });
};
const completeShow = () => screen.getByRole("button", { name: "Complete & show receipt" });
const completeNext = () => screen.getByRole("button", { name: "Complete & next sale" });
const walkIn = () => screen.getByRole("button", { name: "Walk-in" });
const kind = () => screen.getByTestId("counter-buyer-choice").getAttribute("data-kind");
const pick = (typed: string, name: string) => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: typed } });
  fireEvent.click(screen.getByRole("option", { name }));
};
const park = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Park" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Cola" })).toBeNull());
};
const resumeLatest = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /^Parked \(1\)$/ }));
  await screen.findByRole("dialog", { name: "Parked sales" });
  fireEvent.click(await screen.findByRole("button", { name: /^Resume Hold/ }));
  await screen.findByRole("button", { name: "Remove Cola" });
};

describe("S5: a fresh till asks who is buying", () => {
  it("shows the question with a one-tap Walk-in, and no buyer is assumed", () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByText("Who's buying?")).toBeInTheDocument();
    expect(walkIn()).toBeEnabled();
    expect(kind()).toBe("none");
  });

  it("Complete is disabled with the visible reason, linked to both buttons", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    expect(completeShow()).toBeDisabled();
    expect(completeNext()).toBeDisabled();
    const reason = screen.getByTestId("counter-buyer-reason");
    expect(reason).toHaveTextContent("Choose who's buying");
    for (const b of [completeShow(), completeNext()])
      expect(b.getAttribute("aria-describedby") ?? "").toContain(reason.id);
  });

  it("scanning is not blocked by the question", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeInTheDocument();
  });
});

describe("S5: no other way to Complete", () => {
  it("Enter in the cash box cannot ring the sale while nobody is chosen, and says why", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.keyDown(screen.getByLabelText("Amount tendered"), { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose who's buying");
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe("S5: the choice enables Complete", () => {
  it("a customer pick enables Complete and removes the reason", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    pick("acme", "Acme Cafe");
    await waitFor(() => expect(completeShow()).toBeEnabled());
    expect(completeNext()).toBeEnabled();
    expect(screen.queryByTestId("counter-buyer-reason")).toBeNull();
    expect(kind()).toBe("customer");
  });

  it("Walk-in enables Complete, and the sale goes as a walk-in", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    fireEvent.click(walkIn());
    await waitFor(() => expect(completeShow()).toBeEnabled());
    expect(kind()).toBe("walk-in");
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    fireEvent.click(completeShow());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const sent = mutateAsync.mock.calls[0][0];
    expect(sent.dto ?? sent).toMatchObject({ walkIn: true });
  });

  it("a finished sale starts the next one unanswered", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    fireEvent.click(walkIn());
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    await waitFor(() => expect(completeNext()).toBeEnabled());
    fireEvent.click(completeNext());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    await waitFor(() => expect(kind()).toBe("none"));
    await scanCola();
    expect(completeShow()).toBeDisabled();
  });
});

describe("S5: changing the buyer mid-cart", () => {
  it("customer -> another customer -> Walk-in: every step stays answered", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    pick("acme", "Acme Cafe");
    await waitFor(() => expect(completeShow()).toBeEnabled());
    pick("bolt", "Bolt Deli");
    expect(screen.getByTestId("counter-buyer-choice")).toHaveTextContent("Bolt Deli");
    expect(completeShow()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Use Walk-in customer" }));
    expect(kind()).toBe("walk-in");
    expect(completeShow()).toBeEnabled();
  });

  it("Walk-in -> a customer pick replaces it", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    fireEvent.click(walkIn());
    pick("acme", "Acme Cafe");
    expect(kind()).toBe("customer");
  });
});

describe("S5: park / resume and refresh keep the choice", () => {
  it("a parked Walk-in cart resumes as Walk-in (Complete enabled)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    fireEvent.click(walkIn());
    await park();
    expect(kind()).toBe("none");
    await resumeLatest();
    expect(kind()).toBe("walk-in");
    expect(completeShow()).toBeEnabled();
  });

  it("a parked customer cart resumes with that customer", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    pick("acme", "Acme Cafe");
    await waitFor(() => expect(completeShow()).toBeEnabled());
    await park();
    await resumeLatest();
    expect(screen.getByTestId("counter-buyer-choice")).toHaveTextContent("Acme Cafe");
    expect(completeShow()).toBeEnabled();
  });

  it("a cart parked with NO choice resumes still asking (never silently a walk-in)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    await park();
    await resumeLatest();
    expect(kind()).toBe("none");
    expect(completeShow()).toBeDisabled();
  });

  it("a refresh (the stored live cart) keeps a Walk-in choice", async () => {
    const first = renderWithProviders(<CounterSaleScreen />);
    await scanCola();
    fireEvent.click(walkIn());
    // the stored cart is written after a short debounce
    await waitFor(() => expect(window.localStorage.length).toBeGreaterThan(0), { timeout: 3000 });
    const stored = JSON.stringify(Object.values({ ...window.localStorage }));
    expect(stored).toContain("walkIn");
    first.unmount();
    renderWithProviders(<CounterSaleScreen />);
    await screen.findByRole("button", { name: "Remove Cola" });
    expect(kind()).toBe("walk-in");
    expect(completeShow()).toBeEnabled();
  });
});
