import * as React from "react";
import { roundMoney } from "@routeflow/pricing";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { renderTill, tapWalkIn } from "@/test-utils/render-till";
import { CounterSaleScreen, lineQtyLabel, toSaleItem } from "./CounterSaleScreen";
import {
  cancelCounterLeave,
  confirmCounterLeave,
  guardCounterLeave,
} from "@/lib/counter-cart-signal";

/**
 * Counter sale (walk-in pickup): the one screen. The API is mocked at the module boundary. Pins: Walk-in default, On account
 * disabled for a walk-in, quantity-then-scan multiply, a running total through @routeflow/pricing, quick tender + LARGE change,
 * Complete & show receipt -> receipt, Complete & next sale -> a fresh Walk-in sale, per-device auto-print (on once / off never / storage
 * unavailable), FIXED error copy, the capability-driven "Ship this order instead", and an always-focused scan field.
 */

let authUser: { id: string; tenantSlug: string | null; role?: string } | null = {
  id: "u-a",
  tenantSlug: "acme",
  role: "OPERATOR",
};
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: authUser }),
}));
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: jest.fn() }) }));

const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const WATER_CASE = {
  id: "p-water",
  name: "Water",
  pricePerUnit: 12,
  unit: "case",
  unitsPerBox: 12,
};
const ONE_PACK = { id: "p-one", name: "Single", pricePerUnit: 1, unit: "each", unitsPerBox: 1 };
let productFor: Record<string, unknown> = {};
// A scan resolves through the shared exact-code ladder (B1207); the fixtures answer by exact code.
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    productFor[code] ? { product: productFor[code], source: "sku" } : { notFound: true },
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

let gate: Record<string, unknown> = {};
const mutateAsync = jest.fn();
const lookupAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => gate,
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: lookupAsync, isPending: false }),
}));

const printSpy = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  authUser = { id: "u-a", tenantSlug: "acme", role: "OPERATOR" };
  window.print = printSpy;
  customersFor = [];
  productFor = { "012345678905": COLA, WATER: WATER_CASE, ONE: ONE_PACK };
  gate = {
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  };
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 2.5, // the default cart (one Cola) estimates $2.50: the server agrees
    paid: 20,
    balanceDue: 0,
    change: 17.5,
    paymentRecorded: true,
  });
  // a deterministic key source: key-1, key-2, ...
  let n = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => `key-${++n}`,
  });
});

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};

/**
 * W-709 (538 F24): Complete with no or too little cash tendered said "Enter at least $X." but left focus in the scan box
 * and, at phone width with a few lines, the Amount tendered field and Exact off screen. The fix takes the cashier to the
 * fix: Amount tendered is scrolled into view (with Exact beside it) and focused, so one tap or one typed amount completes.
 */
describe("W-709: a short tender takes the cashier to Amount tendered", () => {
  let scrolled: Element[] = [];
  const original = Element.prototype.scrollIntoView;
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    } as typeof Element.prototype.scrollIntoView;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("no cash entered: Complete focuses Amount tendered and brings it into view", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter at least $2.50.");
    const tender = screen.getByLabelText("Amount tendered");
    await waitFor(() => expect(document.activeElement).toBe(tender));
    expect(scrolled.some((el) => el === tender || el.contains(tender))).toBe(true);
  });

  it("too little cash: the same, and Exact then completes it in one tap", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter at least $2.50.");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Amount tendered")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    expect(screen.queryByText(/Enter at least/)).toBeNull();
  });

  it("a second Complete with the same short tender takes focus back to Amount tendered", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    const tender = screen.getByLabelText("Amount tendered");
    await waitFor(() => expect(document.activeElement).toBe(tender));
    screen.getByLabelText("Scan or search items").focus();
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(document.activeElement).toBe(tender));
  });
});
