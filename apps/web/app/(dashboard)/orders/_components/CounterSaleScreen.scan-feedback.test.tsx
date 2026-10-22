import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * F05 (UX run 2026-10-22): the scan / search box. After Enter the box is CLEAR; a code that matched nothing says so
 * INLINE, names the rejected text, and keeps the cursor in the box; a match confirms with a visible "Added <name>";
 * the miss message goes at the next keystroke. The API is mocked at apiClient, the scan ladder is the real one.
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
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
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
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

const COLA = {
  id: "p-cola",
  name: "Sample Cola",
  sku: "200000000001",
  pricePerUnit: 2.5,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
};
const CHIPS = {
  id: "p-chips",
  name: "Corn Chips",
  sku: "200000000002",
  pricePerUnit: 4,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
};

type Handler = () => Promise<unknown> | unknown;
let barcodeFor: Record<string, Handler> = {};
const notFound = () => Promise.reject({ response: { status: 404 } });

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  barcodeFor = { "200000000001": () => COLA, "200000000002": () => CHIPS };
  (apiClient.get as jest.Mock).mockImplementation(async (url: string, cfg?: any) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url.startsWith("/products/barcode/")) {
      const code = decodeURIComponent(url.slice("/products/barcode/".length));
      return barcodeFor[code] ? { data: await barcodeFor[code]() } : notFound();
    }
    if (url === "/products") {
      const code = cfg?.params?.scanCode ?? cfg?.params?.search;
      return { data: { data: barcodeFor[code] ? [await barcodeFor[code]()] : [] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});

const field = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const submitScan = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.submit(field().closest("form")!);
};
const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");

describe("F05: a code that matches nothing", () => {
  it("clears the box, names the rejected text in an alert, and keeps the cursor in the box", async () => {
    renderWithProviders(<CounterSaleScreen />);
    field().focus();
    submitScan("123ABC");
    await waitFor(() =>
      expect(screen.getByText("No product for '123ABC'").closest("[role='alert']")).not.toBeNull(),
    );
    expect(field().value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(lines()).toHaveLength(0);
  });

  it("the alert goes at the next keystroke", async () => {
    renderWithProviders(<CounterSaleScreen />);
    submitScan("123ABC");
    await screen.findByText("No product for '123ABC'");
    fireEvent.change(field(), { target: { value: "2" } });
    expect(screen.queryByText("No product for '123ABC'")).toBeNull();
  });

  it("the alert goes at the next successful scan", async () => {
    renderWithProviders(<CounterSaleScreen />);
    submitScan("123ABC");
    await screen.findByText("No product for '123ABC'");
    submitScan("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(screen.queryByText("No product for '123ABC'")).toBeNull();
  });

  it("a long rejected text is shortened in the message, never the whole barcode wall", async () => {
    renderWithProviders(<CounterSaleScreen />);
    submitScan("X".repeat(80));
    const msg = await screen.findByText(/^No product for 'X+…'$/);
    expect(msg.textContent!.length).toBeLessThan(50);
  });
});

describe("F05: a match", () => {
  it("adds the line, confirms it in a polite status, and clears the box", async () => {
    renderWithProviders(<CounterSaleScreen />);
    submitScan("200000000002");
    await waitFor(() => expect(lines()).toHaveLength(1));
    const status = await screen.findByText("Added Corn Chips");
    expect(status.closest("[role='status']")).not.toBeNull();
    expect(field().value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rapid scans: every scan is a line, the confirmation names the latest, and a miss in between does not drop the next", async () => {
    renderWithProviders(<CounterSaleScreen />);
    submitScan("200000000001");
    submitScan("NOPE-1");
    submitScan("200000000002");
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(await screen.findByTestId("counter-scan-added")).toHaveTextContent("Added Corn Chips");
    expect(screen.queryByText("No product for 'NOPE-1'")).toBeNull(); // the later successful scan cleared it
    expect(field().value).toBe("");
  });
});
