import { readOnlyLine } from "@/lib/subscription-banner-state";
import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { ReadOnlyGateProvider } from "@/lib/read-only-gate";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-733r6 (B4) on the counter-sale screen: when the workspace goes READ_ONLY the cart is KEPT, both Complete buttons
 * are disabled and described by the screen's one read-only hint, and the sale is never posted. jsdom does no layout, so
 * the 390px phone is asserted structurally: window.innerWidth = 390, and both buttons sit in the same checkout bar
 * (`counter-checkout-bar` / `counter-checkout-actions`) under the hint - the bar the Playwright 390 proof measures.
 * The API is mocked at the module boundary exactly as CounterSaleScreen.pos-ux.test.tsx does.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const WATER = { id: "p-water", name: "Water", pricePerUnit: 12, unit: "case", unitsPerBox: 12 };
const productFor: Record<string, unknown> = { COLA, WATER };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    productFor[code] ? { product: productFor[code], source: "sku" } : { notFound: true },
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
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP", "PICKUP"], staffDefault: "PICKUP" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const view = (status: "ACTIVE" | "READ_ONLY") =>
  ({ status, billingContactEmail: "dana@example.test" }) as unknown as SubscriptionView;
// SA-776: the one line is the shared read-only copy (the owner's sentence, then who to ask by e-mail), never a name.
const LINE = readOnlyLine(view("READ_ONLY"), false);

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};
const itemRows = () =>
  within(screen.getByRole("list", { name: "Items" })).getAllByRole("listitem").length;
const completeButtons = () => [
  screen.getByRole("button", { name: "Complete & show receipt" }),
  screen.getByRole("button", { name: "Complete & next sale" }),
];

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.print = jest.fn();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
});

describe("CounterSaleScreen at a 390px phone: the workspace goes read-only", () => {
  it("keeps the cart, disables BOTH Complete buttons and points them at the one read-only line", async () => {
    const ui = (status: "ACTIVE" | "READ_ONLY") => (
      <ReadOnlyGateProvider view={view(status)}>
        <CounterSaleScreen />
      </ReadOnlyGateProvider>
    );
    const { rerender } = renderWithProviders(ui("ACTIVE"));
    await scan("COLA");
    await scan("WATER");
    expect(itemRows()).toBe(2);
    for (const b of completeButtons()) expect(b).toBeEnabled();
    expect(screen.queryByTestId("read-only-line")).toBeNull();

    // The status flips (a 403 READ_ONLY refusal, or the next subscription read).
    rerender(ui("READ_ONLY"));

    const hint = screen.getByTestId("read-only-line");
    expect(hint).toHaveTextContent(LINE);
    const [receipt, next] = completeButtons();
    expect(receipt).toBeDisabled();
    expect(next).toBeDisabled();
    expect(receipt).toHaveAttribute("aria-describedby", hint.id);
    expect(next).toHaveAttribute("aria-describedby", hint.id);
    // Same checkout bar (the box the 390 proof measures), hint above it, nothing hidden.
    const actions = screen.getByTestId("counter-checkout-actions");
    expect(actions).toContainElement(receipt);
    expect(actions).toContainElement(next);
    expect(screen.getByTestId("counter-checkout-bar")).toContainElement(actions);
    // The cart is kept: same rows, same total; a click posts nothing.
    expect(itemRows()).toBe(2);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$14.50");
    fireEvent.click(receipt);
    fireEvent.click(next);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("an ACTIVE workspace: no read-only line, both Complete buttons enabled and undescribed", async () => {
    renderWithProviders(
      <ReadOnlyGateProvider view={view("ACTIVE")}>
        <CounterSaleScreen />
      </ReadOnlyGateProvider>,
    );
    await scan("COLA");
    for (const b of completeButtons()) {
      expect(b).toBeEnabled();
      expect(b).not.toHaveAttribute("aria-describedby");
    }
    expect(screen.queryByTestId("read-only-line")).toBeNull();
  });
});
