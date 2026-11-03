import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { renderTill } from "@/test-utils/render-till";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-1086 PR-2 (CQ-13, LS-9): the counter reads the same live stock as New Order and prints the same note under each
 * line. One read for the cart (mode `entry`: the counter's save is the staff create), the named customer rides along,
 * a failed read prints nothing, and nothing here ever stops the sale.
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const ACME = { id: "c-acme", businessName: "Acme Cafe", pricingTier: 1 };
const WATER = { id: "p-water", name: "Water", pricePerUnit: 12, unit: "case", unitsPerBox: 12 };
const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const productFor: Record<string, unknown> = { WATER, COLA };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    productFor[code] ? { product: productFor[code], source: "sku" } : { notFound: true },
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
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
let stockRead: () => Promise<{ data: unknown }>;
const stock =
  (onHand: Record<string, number>, allowOversell = true) =>
  () =>
    Promise.resolve({
      data: {
        allowOversell,
        items: Object.entries(onHand).map(([productId, availablePieces]) => ({
          productId,
          availablePieces,
        })),
      },
    });
const stockCalls = () =>
  get.mock.calls.filter(([url]) => url === "/orders/stock-availability") as Array<
    [string, { params: Record<string, string> }]
  >;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  stockRead = stock({ "p-water": 20, "p-cola": 0 });
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 0,
    paid: 0,
    balanceDue: 0,
    paymentRecorded: true,
  });
  get.mockImplementation((url: string) =>
    url === "/orders/stock-availability" ? stockRead() : Promise.resolve({ data: { taxRate: 0 } }),
  );
});

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};

/** The sale goes out exactly as it would with no stock note on the screen. */
const completeSale = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Exact" }));
  fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
};

describe("CounterSaleScreen live stock (LS-9)", () => {
  it("S1: a case of a 12-pack with 20 pieces on hand reads '1 box and 8 pieces left', the same words as New Order", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("WATER");
    await waitFor(() =>
      expect(screen.getByTestId("line-stock")).toHaveAttribute("data-state", "ready"),
    );
    const note = screen.getByTestId("line-stock");
    expect(note).toHaveTextContent("1 box and 8 pieces left");
    expect(note).toHaveAttribute("data-level", "ok");
  });

  it("S2: past what is on hand the note warns; 'out' says so; the sale is not stopped", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("WATER");
    await scan("WATER"); // 2 cases = 24 pieces, 20 on hand
    await waitFor(() =>
      expect(screen.getAllByTestId("line-stock")[0]).toHaveAttribute("data-level", "low"),
    );
    // LS-9a: a till sale hands the goods over now, so the note says what the sale does, never "backorder".
    const message = screen.getByTestId("line-stock-message");
    expect(message).toHaveTextContent(
      "Only 1 box and 8 pieces left. You can still sell it. Stock will go below zero.",
    );
    expect(message.textContent).not.toMatch(/backorder/i);
    await scan("COLA"); // 0 on hand
    await waitFor(() =>
      expect(
        screen.getAllByTestId("line-stock").map((n) => n.getAttribute("data-level")),
      ).toContain("out"),
    );
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeEnabled();
    await completeSale();
  });

  it("S3: the read is mode 'entry' for the whole cart in one call; a walk-in sends no customerId", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("WATER");
    await scan("COLA");
    await waitFor(() => expect(stockCalls().length).toBeGreaterThan(0));
    const last = stockCalls().at(-1)![1].params;
    expect(last.mode).toBe("entry");
    expect(last.productIds).toBe("p-cola,p-water");
    expect(last).not.toHaveProperty("customerId");
  });

  it("S4: a named customer's id rides on the read (their own selling rules)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("option", { name: "Acme Cafe" }));
    await scan("WATER");
    await waitFor(() =>
      expect(stockCalls().some(([, c]) => c.params.customerId === "c-acme")).toBe(true),
    );
    expect(stockCalls().at(-1)![1].params.mode).toBe("entry");
  });

  it("S5: a failed read prints no note and the sale still goes on", async () => {
    stockRead = () => Promise.reject({ response: { status: 500 } });
    renderTill(<CounterSaleScreen />);
    await scan("WATER");
    await waitFor(() => expect(stockCalls().length).toBeGreaterThan(0));
    expect(screen.queryByTestId("line-stock")).toBeNull();
    await completeSale();
  });

  it("S6: an empty cart makes no stock read", async () => {
    renderTill(<CounterSaleScreen />);
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toBeInTheDocument());
    expect(stockCalls()).toHaveLength(0);
  });
});
