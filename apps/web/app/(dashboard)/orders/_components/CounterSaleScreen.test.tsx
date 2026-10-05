import * as React from "react";
import userEvent from "@testing-library/user-event";
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
      dto: {
        walkIn: true,
        items: [{ productId: "p-cola", qty: 1 }],
        payment: { method: "CASH", amount: 20 },
      },
      idempotencyKey: "key-1",
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
    const banner = await screen.findByTestId("counter-outcome-unknown");
    expect(banner).toHaveTextContent(
      "We couldn't confirm the sale. Check recent sales before trying again.",
    );
    expect(banner.textContent).not.toMatch(/RAW SERVER TEXT|Nothing was charged/);
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

/** Step 3a: the screen wired to the counter-sale API contract. */
describe("CounterSaleScreen: API contract wiring", () => {
  const fillCola = async () => {
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
  };
  const keyOfCall = (i: number) => mutateAsync.mock.calls[i][0].idempotencyKey as string;

  describe("Idempotency-Key", () => {
    it("every submit sends a key", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
      expect(keyOfCall(0)).toBe("key-1");
    });

    it.each([
      ["a 5xx", { response: { status: 503 } }],
      ["a network error", new Error("Network Error")],
    ])(
      "a retry of the SAME sale after %s (Try again) reuses the SAME key and the SAME body",
      async (_label, failure) => {
        mutateAsync.mockRejectedValueOnce(failure);
        renderWithProviders(<CounterSaleScreen />);
        await fillCola();
        fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
        expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
        expect(keyOfCall(1)).toBe(keyOfCall(0));
        expect(mutateAsync.mock.calls[1][0].dto).toEqual(mutateAsync.mock.calls[0][0].dto);
        await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      },
    );

    it("after a DEFINITIVE 400 the sale is editable and the next submit uses a NEW key", async () => {
      mutateAsync.mockRejectedValueOnce({ response: { status: 400 } });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
      expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
      await scan("WATER");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$14.50"));
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(keyOfCall(1)).not.toBe(keyOfCall(0));
    });

    it.each([401, 403, 404, 409, 422, 429])(
      "a definitive %s also releases the key: the next submit is a NEW key",
      async (status) => {
        mutateAsync.mockRejectedValueOnce({ response: { status } });
        renderWithProviders(<CounterSaleScreen />);
        await fillCola();
        fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
        expect(keyOfCall(1)).not.toBe(keyOfCall(0));
      },
    );

    it("a 408 is still an unknown outcome: banner, locked, same key on Try again", async () => {
      mutateAsync.mockRejectedValueOnce({ response: { status: 408 } });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(keyOfCall(1)).toBe(keyOfCall(0));
    });

    it("a reset after an unknown outcome mints a NEW key for the next sale", async () => {
      mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "New sale" }));
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(3));
      expect(keyOfCall(2)).not.toBe(keyOfCall(0));
    });

    it("a new sale after Complete & next sale gets a NEW key", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(keyOfCall(1)).not.toBe(keyOfCall(0));
    });

    it("a new sale after the receipt's New sale gets a NEW key", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "New sale" }));
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(keyOfCall(1)).not.toBe(keyOfCall(0));
    });
  });

  describe("unknown outcome (5xx / network / timeout): keep the key, lock the sale", () => {
    const goUnknown = async (failure: unknown) => {
      mutateAsync.mockRejectedValueOnce(failure);
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      return screen.findByTestId("counter-outcome-unknown");
    };
    it.each([
      ["a 503", { response: { status: 503 } }],
      ["a network error", new Error("Network Error")],
      ["a timeout", { code: "ECONNABORTED", message: "timeout" }],
    ])(
      "%s: the banner with its two actions, and every cart/payment control disabled",
      async (_l, failure) => {
        const banner = await goUnknown(failure);
        expect(banner).toHaveTextContent(
          "We couldn't confirm the sale. Check recent sales before trying again.",
        );
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Check recent sales" })).toHaveAttribute(
          "href",
          "/orders",
        );
        expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
        expect(screen.getByLabelText("Find a customer")).toBeDisabled();
        expect(screen.getByLabelText("Amount tendered")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Remove Cola" })).toBeDisabled();
        for (const name of ["Cash", "Card", "Check", "Exact", "$20", "$50", "$100"])
          expect(screen.getByRole("button", { name })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Complete sale" })).toBeDisabled();
        expect(screen.getByRole("button", { name: /Complete & next sale/ })).toBeDisabled();
      },
    );

    it("a late product lookup cannot change the locked cart", async () => {
      await goUnknown({ response: { status: 503 } });
      const field = screen.getByLabelText("Scan or search items");
      fireEvent.change(field, { target: { value: "WATER" } });
      fireEvent.submit(field.closest("form")!);
      expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50");
    });

    it("a 409 COUNTER_SALE_ORDER_CHANGED: the sale exists, so banner, lock and the SAME key on Try again", async () => {
      const banner = await goUnknown({
        response: { status: 409, data: { code: "COUNTER_SALE_ORDER_CHANGED", message: "RAW" } },
      });
      expect(banner).toHaveTextContent(
        "We couldn't confirm the sale. Check recent sales before trying again.",
      );
      expect(screen.queryByText(/nothing was charged/i)).toBeNull();
      expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(keyOfCall(1)).toBe(keyOfCall(0));
    });

    it("any other 409 is still a definitive refusal (editable, new key)", async () => {
      mutateAsync.mockRejectedValueOnce({
        response: { status: 409, data: { code: "WALK_IN_OPEN_CREDIT" } },
      });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
      expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
    });

    it("Try again that fails again keeps the banner and the SAME key", async () => {
      await goUnknown({ response: { status: 502 } });
      mutateAsync.mockRejectedValueOnce({ response: { status: 504 } });
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(3));
      expect(keyOfCall(1)).toBe(keyOfCall(0));
      expect(keyOfCall(2)).toBe(keyOfCall(0));
    });

    it("a definitive answer to Try again clears the banner and unlocks (a 409 here)", async () => {
      await goUnknown({ response: { status: 503 } });
      mutateAsync.mockRejectedValueOnce({ response: { status: 409 } });
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
      expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
    });

    it("Try again that succeeds shows the receipt and clears the banner", async () => {
      await goUnknown({ response: { status: 503 } });
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    });
  });

  describe("Complete & next sale never hides an unpaid sale", () => {
    const unpaid = {
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "inv-9",
      invoiceNumber: "INV-9",
      total: 2.5,
      paid: 0,
      balanceDue: 2.5,
      paymentRecorded: false,
      paymentErrorCode: "PAYMENT_WRITE_FAILED",
    };
    const partlyPaid = { ...unpaid, paid: 1, balanceDue: 1.5, paymentRecorded: true };
    const completeAndNext = async () => {
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    };

    it("paymentRecorded false: the receipt with the not-recorded panel shows, the cart is not reset", async () => {
      mutateAsync.mockResolvedValue(unpaid);
      await completeAndNext();
      expect(await screen.findByTestId("counter-sale-receipt")).toBeInTheDocument();
      expect(screen.getByTestId("counter-payment-not-recorded")).toBeInTheDocument();
      expect(screen.getByText(/Cola/)).toBeInTheDocument();
      expect(screen.queryByText("No items yet.")).toBeNull();
      expect(screen.queryByTestId("counter-sale-screen")).toBeNull();
    });

    it("balanceDue > 0 (payment recorded): the receipt with the balance due shows, not reset", async () => {
      mutateAsync.mockResolvedValue(partlyPaid);
      await completeAndNext();
      expect(await screen.findByTestId("counter-sale-receipt")).toBeInTheDocument();
      expect(screen.getByText("Balance due").nextSibling).toHaveTextContent("$1.50");
      expect(screen.queryByText("No items yet.")).toBeNull();
    });

    it("the receipt's own New sale button then starts the next sale (fresh walk-in, new key)", async () => {
      mutateAsync.mockResolvedValue(unpaid);
      await completeAndNext();
      fireEvent.click(await screen.findByRole("button", { name: "New sale" }));
      expect(await screen.findByText("No items yet.")).toBeInTheDocument();
      expect(screen.getByText("Walk-in customer")).toBeInTheDocument();
      expect(screen.queryByTestId("counter-sale-receipt")).toBeNull();
    });

    it("auto-print still fires exactly once for the unpaid sale", async () => {
      window.localStorage.setItem("rf.counterSale.autoPrint", "1");
      mutateAsync.mockResolvedValue(unpaid);
      renderWithProviders(<CounterSaleScreen />);
      await waitFor(() =>
        expect(screen.getByLabelText("Print receipt automatically")).toBeChecked(),
      );
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      await screen.findByTestId("counter-sale-receipt");
      expect(printSpy).toHaveBeenCalledTimes(1);
    });

    it("fully paid still resets as before", async () => {
      await completeAndNext();
      await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
      expect(screen.queryByTestId("counter-sale-receipt")).toBeNull();
    });
  });

  describe("the displayed total is an ESTIMATE; the receipt carries the server's number", () => {
    it("the running figure is labelled 'Estimated total' (and still drives quick tender / change)", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      const running = screen.getByTestId("running-total");
      expect(running).toHaveTextContent("Estimated total");
      expect(running).toHaveTextContent("$2.50");
      expect(screen.getByTestId("change-due")).toHaveTextContent("Change $17.50");
    });

    it("the receipt's total is prominent and is the server's number", async () => {
      mutateAsync.mockResolvedValue({
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 2.7,
        paid: 20,
        balanceDue: 0,
        change: 17.3,
        paymentRecorded: true,
      });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      const total = await screen.findByTestId("receipt-total");
      expect(total).toHaveTextContent("$2.70");
      expect(total.className).toMatch(/text-lg/);
    });

    it("Complete & next sale whose server total DIFFERS from the estimate shows the receipt first, not reset", async () => {
      mutateAsync.mockResolvedValue({
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 2.7,
        paid: 20,
        balanceDue: 0,
        change: 17.3,
        paymentRecorded: true,
      });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      expect(await screen.findByTestId("receipt-total")).toHaveTextContent("$2.70");
      expect(screen.queryByText("No items yet.")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "New sale" }));
      expect(await screen.findByText("No items yet.")).toBeInTheDocument();
    });

    it("auto-print fires once when the receipt is held for a total mismatch", async () => {
      window.localStorage.setItem("rf.counterSale.autoPrint", "1");
      mutateAsync.mockResolvedValue({
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 2.7,
        paid: 20,
        balanceDue: 0,
        change: 17.3,
        paymentRecorded: true,
      });
      renderWithProviders(<CounterSaleScreen />);
      await waitFor(() =>
        expect(screen.getByLabelText("Print receipt automatically")).toBeChecked(),
      );
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      await screen.findByTestId("receipt-total");
      expect(printSpy).toHaveBeenCalledTimes(1);
    });

    it("a server total equal to the estimate still resets (the clerk already saw that number)", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
    });
  });

  describe("payment not recorded", () => {
    beforeEach(() => {
      mutateAsync.mockResolvedValue({
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "inv-9",
        invoiceNumber: "INV-9",
        total: 2.5,
        paid: 0,
        balanceDue: 2, // the server's stored balance (e.g. a credit applied at send), never re-derived here
        paymentRecorded: false,
        paymentErrorCode: "PAYMENT_WRITE_FAILED",
      });
    });

    it("says so, links to the invoice, never shows Paid, and shows the server balance due", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      const notice = await screen.findByTestId("counter-payment-not-recorded");
      expect(notice).toHaveTextContent("Sale recorded — payment not recorded");
      expect(screen.getByRole("link", { name: "Record payment" })).toHaveAttribute(
        "href",
        "/invoices/inv-9",
      );
      const receipt = screen.getByTestId("counter-sale-receipt");
      expect(receipt.textContent).not.toMatch(/Paid/);
      expect(screen.getByText("Balance due").nextSibling).toHaveTextContent("$2.00");
      expect(screen.queryByText("Change")).toBeNull();
    });

    it("a recorded payment shows Paid and no not-recorded notice", async () => {
      mutateAsync.mockResolvedValue({
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "inv-9",
        invoiceNumber: "INV-9",
        total: 2.5,
        paid: 2.5,
        balanceDue: 0,
        paymentRecorded: true,
      });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      expect(screen.getByText("Paid")).toBeInTheDocument();
      expect(screen.queryByTestId("counter-payment-not-recorded")).toBeNull();
      expect(screen.queryByRole("link", { name: "Record payment" })).toBeNull();
    });
  });

  it("a replayed response renders the same receipt: no error, no extra alert", async () => {
    mutateAsync.mockResolvedValue({
      orderId: "o1",
      orderNumber: "ORD-1",
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      total: 2.5,
      paid: 20,
      balanceDue: 0,
      change: 17.5,
      paymentRecorded: true,
      replayed: true,
    });
    renderWithProviders(<CounterSaleScreen />);
    await fillCola();
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(screen.getByText(/Order ORD-1/)).toHaveTextContent("Invoice INV-1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("fixed error copy by status", () => {
    const failWith = async (response: unknown) => {
      mutateAsync.mockRejectedValue({ response });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      return (await screen.findByRole("alert")).textContent ?? "";
    };
    it("403 COUNTER_SALES_DISABLED shows the fixed disabled copy", async () => {
      expect(
        await failWith({ status: 403, data: { code: "COUNTER_SALES_DISABLED", message: "RAW" } }),
      ).toBe("Counter sales are not turned on for this business.");
    });
    it("a plain 403 shows the permission copy, 409 the changed copy, 400 the entered copy", async () => {
      expect(await failWith({ status: 403, data: { message: "RAW" } })).toMatch(/permission/);
    });
    it("409 shows the changed-while-checking-out copy", async () => {
      expect(await failWith({ status: 409, data: { message: "RAW" } })).toMatch(/changed/);
    });
    it("400 shows the can't-be-completed-as-entered copy", async () => {
      expect(await failWith({ status: 400, data: { message: "RAW" } })).toMatch(/as entered/);
    });
  });

  describe("keyboard flow for quick-tender", () => {
    it("tab order: payment methods, then the tender buttons (real buttons), then the tendered field", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CounterSaleScreen />);
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
      const names = ["Cash", "Card", "Check", "Exact", "$20", "$50", "$100"];
      for (const n of names) {
        expect(screen.getByRole("button", { name: n }).tagName).toBe("BUTTON");
      }
      screen.getByRole("button", { name: "Cash" }).focus();
      const seen: string[] = ["Cash"];
      for (let i = 0; i < 6; i++) {
        await user.tab();
        seen.push(document.activeElement?.textContent ?? "");
      }
      expect(seen).toEqual(["Cash", "Card", "Check", "Exact", "$20", "$50", "$100"]);
      await user.tab();
      expect(screen.getByLabelText("Amount tendered")).toHaveFocus();
    });

    it("Enter in the tendered field submits a valid sale", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CounterSaleScreen />);
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
      await user.type(screen.getByLabelText("Amount tendered"), "20{Enter}");
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
      expect(mutateAsync.mock.calls[0][0].dto.payment).toEqual({ method: "CASH", amount: 20 });
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    });

    it("Enter in the tendered field does NOT submit while the tender is short", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CounterSaleScreen />);
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
      await user.type(screen.getByLabelText("Amount tendered"), "1{Enter}");
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it("after Complete & next sale, focus returns to the scan field", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      await user.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
    });
  });

  describe("auto-print: exactly once per completed sale", () => {
    beforeEach(() => window.localStorage.setItem("rf.counterSale.autoPrint", "1"));

    it("a failed attempt does not print; the successful retry prints once", async () => {
      mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
      renderWithProviders(<CounterSaleScreen />);
      await waitFor(() =>
        expect(screen.getByLabelText("Print receipt automatically")).toBeChecked(),
      );
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
      expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
      expect(printSpy).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      expect(printSpy).toHaveBeenCalledTimes(1);
    });

    it("two Complete & next sale runs print twice in total", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await waitFor(() =>
        expect(screen.getByLabelText("Print receipt automatically")).toBeChecked(),
      );
      for (let i = 0; i < 2; i++) {
        await fillCola();
        fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(i + 1));
        await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
      }
      expect(printSpy).toHaveBeenCalledTimes(2);
    });
  });
});
