import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Counter sale (walk-in pickup): the one screen. The API is mocked at the module boundary. Pins: Walk-in default, On account
 * disabled for a walk-in, quantity-then-scan multiply, a running total through @routeflow/pricing, quick tender + LARGE change,
 * Complete sale -> receipt, Complete & next sale -> a fresh Walk-in sale, per-device auto-print (on once / off never / storage
 * unavailable), FIXED error copy, the capability-driven "Ship this order instead", and an always-focused scan field.
 */

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
let productFor: Record<string, unknown> = {};
jest.mock("@/lib/api/products", () => ({
  useProducts: (params: { search?: string; scanCode?: string }, opts?: { enabled?: boolean }) => {
    const key = params?.scanCode ?? params?.search ?? "";
    const p = productFor[key];
    return {
      data: opts?.enabled && p ? { data: [p] } : opts?.enabled ? { data: [] } : undefined,
      isFetching: false,
    };
  },
}));
jest.mock("@/lib/api/customers", () => ({ useCustomers: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));

let gate: Record<string, unknown> = {};
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => gate,
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
}));

const printSpy = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.print = printSpy;
  productFor = { "012345678905": COLA, WATER: WATER_CASE };
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
    total: 7.5,
    paid: 20,
    balanceDue: 0,
    change: 12.5,
  });
});

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};

describe("CounterSaleScreen", () => {
  it("defaults to a Walk-in customer, with On account disabled and the scan field focused", () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByText("Walk-in customer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "On account" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cash" })).not.toBeDisabled();
    expect(screen.getByLabelText("Scan or search items")).toHaveFocus();
  });

  it("type a quantity, then scan, to multiply: 3 then a scan = 3 units and the running total", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("3");
    expect(screen.getByTestId("pending-qty")).toHaveTextContent("×3");
    await scan("012345678905");
    await waitFor(() => expect(screen.getByText(/Cola/)).toBeInTheDocument());
    expect(screen.getByText(/× 3/)).toBeInTheDocument();
    expect(screen.getByTestId("running-total")).toHaveTextContent("$7.50");
    expect(screen.queryByTestId("pending-qty")).toBeNull(); // the multiplier is consumed
    expect(screen.getByLabelText("Scan or search items")).toHaveFocus();
  });

  it("a repeat scan merges into the same line; a boxed product adds a whole box and prices the box", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("WATER");
    await scan("WATER");
    await waitFor(() => expect(screen.getByText(/2 boxes/)).toBeInTheDocument());
    expect(screen.getAllByRole("listitem", { name: "" }).length).toBeGreaterThan(0);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$24.00");
  });

  it("cash: quick tender shows the change LARGE; Exact leaves none", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    expect(screen.getByRole("button", { name: "$20" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    expect(screen.getByTestId("change-due")).toHaveTextContent("Change $17.50");
    expect(screen.getByTestId("change-due").className).toMatch(/text-3xl/);
    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    expect(screen.getByTestId("change-due")).toHaveTextContent("Change $0.00");
  });

  it("Complete sale posts a walk-in sale with the cash tendered, then shows the receipt with Print", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(mutateAsync).toHaveBeenCalledWith({
      walkIn: true,
      items: [{ productId: "p-cola", qty: 1 }],
      payment: { method: "CASH", amount: 20 },
    });
    expect(screen.getByText("Change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("Complete & next sale resets to a fresh Walk-in sale", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$0.00"));
    expect(screen.getByText("No items yet.")).toBeInTheDocument();
    expect(screen.getByText("Walk-in customer")).toBeInTheDocument();
    expect(screen.queryByTestId("counter-sale-receipt")).toBeNull();
  });

  describe("auto-print (per device)", () => {
    const finishSale = async () => {
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    };
    it("on: window.print once after Complete sale, and the toggle persists locally", async () => {
      renderWithProviders(<CounterSaleScreen />);
      fireEvent.click(screen.getByLabelText("Print receipt automatically"));
      expect(window.localStorage.getItem("rf.counterSale.autoPrint")).toBe("1");
      await finishSale();
      await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    });
    it("on + Complete & next sale: prints once, BEFORE the reset", async () => {
      window.localStorage.setItem("rf.counterSale.autoPrint", "1");
      renderWithProviders(<CounterSaleScreen />);
      await waitFor(() =>
        expect(screen.getByLabelText("Print receipt automatically")).toBeChecked(),
      );
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      printSpy.mockImplementation(() => {
        expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"); // not reset yet
      });
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    });
    it("off: print is never called by the sale", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await finishSale();
      expect(printSpy).not.toHaveBeenCalled();
    });
    it("storage unavailable: defaults off and does not crash", async () => {
      // Only OUR key's storage access throws (the test harness's own providers keep working).
      const KEY = "rf.counterSale.autoPrint";
      const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation((k: string) => {
        if (k === KEY) throw new Error("denied");
        return null;
      });
      const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation((k: string) => {
        if (k === KEY) throw new Error("denied");
      });
      try {
        renderWithProviders(<CounterSaleScreen />);
        expect(screen.getByLabelText("Print receipt automatically")).not.toBeChecked();
        fireEvent.click(screen.getByLabelText("Print receipt automatically"));
        await finishSale();
        // the toggle was flipped for this session even though it could not persist
      } finally {
        getItem.mockRestore();
        setItem.mockRestore();
      }
    });
  });

  it("an API failure shows FIXED copy, never the server message", async () => {
    mutateAsync.mockRejectedValue({
      response: { status: 500, data: { message: "RAW SERVER TEXT" } },
    });
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not be completed/i);
    expect(alert.textContent).not.toMatch(/RAW SERVER TEXT/);
    expect(screen.queryByTestId("counter-sale-receipt")).toBeNull();
  });

  it("refuses short cash and an empty sale client-side, without calling the API", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add at least one item.");
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/less than the total/);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("'Ship this order instead' appears only when the capability offers SHIP, and drops to the normal order form", () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.queryByRole("button", { name: "Ship this order instead" })).toBeNull();
  });

  it("with SHIP offered, 'Ship this order instead' opens the normal form with the ship intent", () => {
    gate = { ...gate, offerShipInstead: true };
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Ship this order instead" }));
    expect(push).toHaveBeenCalledWith(expect.stringContaining("/orders?action=new&ship=1"));
  });

  it("a business with the counter off shows nothing to sell with", () => {
    gate = {
      showButton: false,
      opensAsCounter: false,
      offerShipInstead: false,
      capability: { counter: "off" },
    };
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByTestId("counter-sale-off")).toBeInTheDocument();
    expect(screen.queryByLabelText("Scan or search items")).toBeNull();
  });
});
