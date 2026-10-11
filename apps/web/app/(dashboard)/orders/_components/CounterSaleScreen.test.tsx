import * as React from "react";
import { roundMoney } from "@routeflow/pricing";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
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

let authUser: { id: string; tenantSlug: string | null } | null = { id: "u-a", tenantSlug: "acme" };
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
  authUser = { id: "u-a", tenantSlug: "acme" };
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

describe("CounterSaleScreen", () => {
  it("defaults to a Walk-in customer, with On account disabled and the scan field focused", () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByText("Walk-in customer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "On account" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cash" })).not.toBeDisabled();
    expect(screen.getByLabelText("Scan or search items")).toHaveFocus();
  });

  it("the screen root carries the marker the reprint print rule hides", () => {
    renderWithProviders(<CounterSaleScreen />);
    const root = screen.getByTestId("counter-sale-screen");
    expect(root).toHaveAttribute("data-counter-screen");
    expect(root).toContainElement(screen.getByLabelText("Scan or search items"));
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

  it("cash: the change line sits inside the sticky checkout bar, never under it (row 112)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    expect(screen.getByTestId("counter-checkout-bar")).toContainElement(
      screen.getByTestId("change-due"),
    );
  });

  it("cash: an underpayment reads 'Amount due', never 'Change $0.00' (row 188)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    expect(screen.getByTestId("change-due")).toHaveTextContent("Amount due $2.50");
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "1" } });
    expect(screen.getByTestId("change-due")).toHaveTextContent("Amount due $1.50");
    expect(screen.getByTestId("change-due")).not.toHaveTextContent("Change");
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "3" } });
    expect(screen.getByTestId("change-due")).toHaveTextContent("Change $0.50");
  });

  it("cash: the 'less than the total' error clears the moment the tender is fixed (row 188)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("less than the total");
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "5" } });
    expect(screen.queryByText(/less than the total/)).toBeNull();
  });

  it("row 238: the underpaid error renders INSIDE the sticky checkout bar, next to Complete (never off-screen below the fold)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("less than the total");
    expect(screen.getByTestId("counter-checkout-bar")).toContainElement(alert);
    // and it sits before the actions, so the cashier reads why before the buttons
    const actions = screen.getByTestId("counter-checkout-actions");
    expect(alert.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe("row 112: the scroll area ends below the sticky bar", () => {
    const realDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    let roCallbacks: Array<() => void> = [];
    beforeEach(() => {
      roCallbacks = [];
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get() {
          return (this as HTMLElement).dataset.testid === "counter-checkout-bar" ? 180 : 0;
        },
      });
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        constructor(cb: () => void) {
          roCallbacks.push(cb);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      };
    });
    afterEach(() => {
      if (realDescriptor)
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", realDescriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
      delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
    });

    it("the screen reserves the bar's height at its bottom (below md), so line 2 and Cash/Card can scroll clear of it", async () => {
      renderWithProviders(<CounterSaleScreen />);
      const root = screen.getByTestId("counter-sale-screen");
      await waitFor(() => expect(root.style.getPropertyValue("--counter-bar-h")).toBe("180px"));
    });

    it("row 330a: the scroll container keeps a focused control clear of the bar (scroll-padding-bottom), and lets go on unmount", async () => {
      const main = document.createElement("main");
      main.id = "main-content";
      main.style.paddingBottom = "96px"; // the shell's pb-24: the bar sticks above it
      document.body.appendChild(main);
      try {
        const view = renderWithProviders(<CounterSaleScreen />);
        await waitFor(() =>
          expect(main.style.getPropertyValue("scroll-padding-bottom")).toBe("292px"),
        ); // bar 180 + the shell pb-24 (96) + 1rem
        view.unmount();
        expect(main.style.getPropertyValue("scroll-padding-bottom")).toBe("");
      } finally {
        main.remove();
      }
    });

    it("row 330a: at md and wider the bar is static, so no scroll padding is reserved", async () => {
      const real = window.matchMedia;
      window.matchMedia = ((q: string) => ({
        matches: q === "(min-width: 768px)",
        media: q,
        addEventListener() {},
        removeEventListener() {},
      })) as never;
      const main = document.createElement("main");
      main.id = "main-content";
      document.body.appendChild(main);
      try {
        const view = renderWithProviders(<CounterSaleScreen />);
        const root = screen.getByTestId("counter-sale-screen");
        await waitFor(() => expect(root.style.getPropertyValue("--counter-bar-h")).toBe("180px"));
        expect(main.style.getPropertyValue("scroll-padding-bottom")).toBe("");
        view.unmount();
      } finally {
        window.matchMedia = real;
        main.remove();
      }
    });

    it("row 330a: below md the bar clears the home indicator (safe-area inset), so its measured height includes it", () => {
      renderWithProviders(<CounterSaleScreen />);
      const bar = screen.getByTestId("counter-checkout-bar");
      expect(bar.className).toContain("env(safe-area-inset-bottom");
    });

    it("a cold load (gate loading first) still measures the bar once it mounts", async () => {
      const loaded = gate;
      gate = { ...loaded, loading: true };
      const view = renderWithProviders(<CounterSaleScreen />);
      expect(screen.getByTestId("counter-sale-loading")).toBeInTheDocument();
      gate = loaded;
      view.rerender(<CounterSaleScreen />);
      const root = await screen.findByTestId("counter-sale-screen");
      await waitFor(() => expect(root.style.getPropertyValue("--counter-bar-h")).toBe("180px"));
    });

    it("follows the bar when it grows (an error appears in it)", async () => {
      renderWithProviders(<CounterSaleScreen />);
      const root = screen.getByTestId("counter-sale-screen");
      await waitFor(() => expect(root.style.getPropertyValue("--counter-bar-h")).toBe("180px"));
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get() {
          return (this as HTMLElement).dataset.testid === "counter-checkout-bar" ? 232 : 0;
        },
      });
      act(() => roCallbacks.forEach((cb) => cb()));
      await waitFor(() => expect(root.style.getPropertyValue("--counter-bar-h")).toBe("232px"));
    });
  });

  describe("row 237: one scan-focus owner", () => {
    const addNoteBtn = () => screen.getByRole("button", { name: /Add a note to Cola/ });
    const scanField = () => screen.getByLabelText("Scan or search items");

    async function withCola() {
      renderWithProviders(<CounterSaleScreen />);
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    }

    it("Enter in the note saves it, closes the editor and hands focus to the scan box", async () => {
      await withCola();
      fireEvent.click(addNoteBtn());
      const note = screen.getByLabelText("Note for Cola");
      fireEvent.change(note, { target: { value: "cold" } });
      fireEvent.keyDown(note, { key: "Enter" });
      await waitFor(() => expect(scanField()).toHaveFocus());
      expect(screen.queryByLabelText("Note for Cola")).toBeNull();
      expect(screen.getByTestId("line-note")).toHaveTextContent("cold");
    });

    it("Clear note hands focus to the scan box (not <body>)", async () => {
      await withCola();
      fireEvent.click(addNoteBtn());
      fireEvent.change(screen.getByLabelText("Note for Cola"), { target: { value: "cold" } });
      fireEvent.keyDown(screen.getByLabelText("Note for Cola"), { key: "Enter" });
      fireEvent.click(await screen.findByRole("button", { name: /Clear the note on Cola/ }));
      await waitFor(() => expect(scanField()).toHaveFocus());
      expect(document.body).not.toHaveFocus();
    });

    it("leaving the note field to nowhere (blur) saves it and returns focus to the scan box", async () => {
      await withCola();
      fireEvent.click(addNoteBtn());
      const note = screen.getByLabelText("Note for Cola");
      fireEvent.change(note, { target: { value: "cold" } });
      note.focus();
      note.blur();
      await waitFor(() => expect(scanField()).toHaveFocus());
      expect(screen.getByTestId("line-note")).toHaveTextContent("cold");
    });

    it("Tab out of the last quantity field goes to the scan box, not to Add note", async () => {
      await withCola();
      const qty = screen.getByLabelText("Set quantity of Cola");
      qty.focus();
      fireEvent.change(qty, { target: { value: "2" } });
      fireEvent.keyDown(qty, { key: "Tab" });
      await waitFor(() => expect(scanField()).toHaveFocus());
      expect(screen.getByTestId("running-total")).toHaveTextContent("$5.00");
    });

    it("a plain Tab (no typed draft) is NOT hijacked: the default Tab proceeds", async () => {
      await withCola();
      const qty = screen.getByLabelText("Set quantity of Cola");
      qty.focus();
      // fireEvent returns false when the handler called preventDefault
      const notPrevented = fireEvent.keyDown(qty, { key: "Tab" });
      expect(notPrevented).toBe(true);
      await new Promise((r) => setTimeout(r, 30));
      expect(scanField()).not.toHaveFocus();
    });

    it("Shift+Tab out of the quantity field is left alone", async () => {
      await withCola();
      const qty = screen.getByLabelText("Set quantity of Cola");
      qty.focus();
      fireEvent.keyDown(qty, { key: "Tab", shiftKey: true });
      await new Promise((r) => setTimeout(r, 30));
      expect(scanField()).not.toHaveFocus();
    });

    it("a digit typed while a button holds focus goes to the scan box", async () => {
      await withCola();
      addNoteBtn().focus();
      fireEvent.keyDown(addNoteBtn(), { key: "5" });
      expect(scanField()).toHaveFocus();
    });

    it("a digit is left alone while a listbox / menu / combobox typeahead holds focus", async () => {
      await withCola();
      for (const role of ["listbox", "menu", "combobox"]) {
        const host = document.createElement("div");
        host.setAttribute("role", role);
        const item = document.createElement("div");
        item.tabIndex = 0;
        host.appendChild(item);
        document.body.appendChild(host);
        item.focus();
        expect(item).toHaveFocus();
        fireEvent.keyDown(item, { key: "5" });
        expect(scanField()).not.toHaveFocus();
        host.remove();
      }
    });

    it("a letter is left alone (g-then-x navigation shortcuts keep working)", async () => {
      await withCola();
      addNoteBtn().focus();
      fireEvent.keyDown(addNoteBtn(), { key: "g" });
      expect(addNoteBtn()).toHaveFocus();
    });

    it("typing in a text field, or with Ctrl, is never redirected", async () => {
      await withCola();
      const qty = screen.getByLabelText("Set quantity of Cola");
      qty.focus();
      fireEvent.keyDown(qty, { key: "5" });
      expect(qty).toHaveFocus();
      addNoteBtn().focus();
      fireEvent.keyDown(addNoteBtn(), { key: "c", ctrlKey: true });
      expect(addNoteBtn()).toHaveFocus();
    });
  });

  it("a repeat scan says so: the cue names the item and its new quantity (row 188)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    expect(screen.queryByTestId("counter-scan-cue")).toBeNull(); // a new line is its own signal
    await scan("012345678905");
    await waitFor(() =>
      expect(screen.getByTestId("counter-scan-cue")).toHaveTextContent("Cola · now 2"),
    );
  });

  it("Enter on a typed quantity hands focus back to the scan field (row 188)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    const qty = screen.getByLabelText("Set quantity of Cola");
    qty.focus();
    fireEvent.change(qty, { target: { value: "4" } });
    fireEvent.keyDown(qty, { key: "Enter" });
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
    expect(screen.getByTestId("running-total")).toHaveTextContent("$10.00");
  });

  it("the repeat-scan cue still clears 2.5 s after it was SET, even when the line changes meanwhile", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("counter-scan-cue")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add one Cola" })); // a line change inside the window
    await waitFor(() => expect(screen.queryByTestId("counter-scan-cue")).toBeNull(), {
      timeout: 4000,
    });
  }, 10000);

  it("editing the tender keeps a server error on screen; only the underpaid copy clears (review nit)", async () => {
    mutateAsync.mockRejectedValue({ response: { status: 409, data: { message: "RAW" } } });
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed/);
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "$50" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/changed/);
  });

  it("the amount-due / change line is announced politely (review nit)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByTestId("change-due")).toHaveAttribute("role", "status");
  });

  it("Complete & show receipt posts a walk-in sale with the cash tendered, then shows the receipt with Print", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    // print: the wrapper drops its padding and width cap so the 72 mm printable area is the receipt's
    expect(screen.getByTestId("counter-sale-receipt").className).toEqual(
      expect.stringContaining("print:max-w-none"),
    );
    expect(screen.getByTestId("counter-sale-receipt").className).toContain("print:p-0");
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
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    };
    it("on: window.print once after Complete & show receipt, and the toggle persists locally", async () => {
      renderWithProviders(<CounterSaleScreen />);
      fireEvent.click(screen.getByLabelText("Print receipt automatically"));
      expect(window.localStorage.getItem("rf.counterSale.autoPrint")).toBe("1");
      await finishSale();
      await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    });
    it("on + Complete & next sale: prints the RECEIPT once, then resets", async () => {
      window.localStorage.setItem("rf.counterSale.autoPrint", "1");
      renderWithProviders(<CounterSaleScreen />);
      await waitFor(() =>
        expect(screen.getByLabelText("Print receipt automatically")).toBeChecked(),
      );
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      // D6: the RECEIPT is on screen when it prints (not the sale screen), and the reset follows the print.
      let receiptShown = false;
      printSpy.mockImplementationOnce(() => {
        receiptShown = screen.queryByTestId("counter-sale-receipt") !== null;
      });
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
      expect(receiptShown).toBe(true);
      await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
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
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    const banner = await screen.findByTestId("counter-outcome-unknown");
    expect(banner).toHaveTextContent(
      "We couldn't confirm the sale. Check recent sales before trying again.",
    );
    expect(banner.textContent).not.toMatch(/RAW SERVER TEXT|Nothing was charged/);
    expect(screen.queryByTestId("counter-sale-receipt")).toBeNull();
  });

  it("refuses short cash and an empty sale client-side, without calling the API", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add at least one item.");
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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

  it("'Ship this order instead' preselects SHIP for a customer whose stored ROUTE is not a method here", () => {
    customersFor = [{ id: "c1", businessName: "Acme Co", fulfillPath: "ROUTE" }];
    gate = {
      showButton: true,
      opensAsCounter: true,
      offerShipInstead: true,
      capability: { counter: "always", methods: ["SHIP"], staffDefault: "SHIP" },
    };
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Acme Co" }));
    fireEvent.click(screen.getByRole("button", { name: "Ship this order instead" }));
    expect(push).toHaveBeenCalledWith("/orders?action=new&ship=1&preselect=SHIP");
  });

  it.each([
    ["the system walk-in record", { isWalkIn: true }, false],
    ["a named customer", { isWalkIn: false }, true],
  ])("receipt Customer line when %s was picked", async (_n, flag, shown) => {
    customersFor = [{ id: "c1", businessName: "Walk-in customer", ...flag }];
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "walk" } });
    fireEvent.click(screen.getByRole("button", { name: "Walk-in customer" }));
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-sale-receipt");
    if (shown) expect(screen.getByTestId("receipt-customer")).toBeInTheDocument();
    else expect(screen.queryByTestId("receipt-customer")).toBeNull();
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
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
      expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
      await scan("WATER");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$14.50"));
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(keyOfCall(1)).not.toBe(keyOfCall(0));
    });

    it.each([401, 403, 404, 409, 422, 429])(
      "a definitive %s also releases the key: the next submit is a NEW key",
      async (status) => {
        mutateAsync.mockRejectedValueOnce({ response: { status } });
        renderWithProviders(<CounterSaleScreen />);
        await fillCola();
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
        expect(keyOfCall(1)).not.toBe(keyOfCall(0));
      },
    );

    it("a 408 is still an unknown outcome: banner, locked, same key on Try again", async () => {
      mutateAsync.mockRejectedValueOnce({ response: { status: 408 } });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(keyOfCall(1)).toBe(keyOfCall(0));
    });

    it("a reset after an unknown outcome mints a NEW key for the next sale", async () => {
      mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "New sale" }));
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "New sale" }));
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
      expect(keyOfCall(1)).not.toBe(keyOfCall(0));
    });
  });

  describe("unknown outcome (5xx / network / timeout): keep the key, lock the sale", () => {
    const goUnknown = async (failure: unknown) => {
      mutateAsync.mockRejectedValueOnce(failure);
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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
        expect(screen.getByRole("button", { name: "Complete & show receipt" })).toBeDisabled();
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

    it("a 409 COUNTER_SALE_DAY_CLOSED: the sale is saved and unpaid, so the closed-day line, the lock and the SAME key", async () => {
      const banner = await goUnknown({
        response: { status: 409, data: { code: "COUNTER_SALE_DAY_CLOSED", message: "RAW" } },
      });
      expect(banner).toBeInTheDocument();
      expect(
        screen.getByText(
          "This day is closed, so no payment was taken. The sale is saved. Ask the office to reopen the close, then use Try again.",
        ),
      ).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("RAW");
      expect(screen.queryByText(/nothing was charged/i)).toBeNull();
      expect(screen.queryByText(/something changed/i)).toBeNull();
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
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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

    it.each([
      ["a 403 (the fail-closed gate)", { response: { status: 403, data: {} } }],
      ["a 429", { response: { status: 429 } }],
      ["an uncoded 409", { response: { status: 409 } }],
      ["a 400", { response: { status: 400 } }],
    ])(
      "once UNKNOWN, a refusal to Try again (%s) keeps the lock, the key and the banner, and never says 'Nothing was charged'",
      async (_l, refusal) => {
        await goUnknown({ response: { status: 503 } });
        mutateAsync.mockRejectedValueOnce(refusal);
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
        expect(await screen.findByTestId("counter-outcome-unknown")).toHaveTextContent(
          "We couldn't confirm the sale. Check recent sales before trying again.",
        );
        expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
        expect(screen.queryByText(/nothing was charged/i)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(3));
        expect(keyOfCall(1)).toBe(keyOfCall(0));
        expect(keyOfCall(2)).toBe(keyOfCall(0));
      },
    );

    it.each([
      "COUNTER_SALE_ORDER_CHANGED",
      "IDEMPOTENCY_KEY_OTHER_ORDER",
      "IDEMPOTENCY_KEY_CART_MISMATCH",
    ])("a first-attempt 409 %s is an unknown outcome (the order exists)", async (code) => {
      const banner = await goUnknown({ response: { status: 409, data: { code } } });
      expect(banner).toBeInTheDocument();
      expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
      expect(screen.queryByText(/nothing was charged/i)).toBeNull();
    });

    it("the banner offers exactly Try again, Check sale status and Check recent sales", async () => {
      const banner = await goUnknown({ response: { status: 503 } });
      const actions = [...banner.querySelectorAll("button, a")].map((el) => el.textContent);
      expect(actions).toEqual(["Try again", "Check sale status", "Check recent sales"]);
    });

    describe("Check sale status (GET /orders/counter-sale/by-key/:key)", () => {
      const sale = {
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
      };
      const check = () =>
        fireEvent.click(screen.getByRole("button", { name: "Check sale status" }));

      it.each(["CARD", "CHECK"])(
        "the lookup sends the method THIS attempt rang (%s), as ?method=",
        async (method) => {
          mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
          renderWithProviders(<CounterSaleScreen />);
          await scan("012345678905");
          await waitFor(() =>
            expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"),
          );
          fireEvent.click(
            screen.getByRole("button", { name: method === "CARD" ? "Card" : "Check" }),
          );
          if (method === "CHECK")
            fireEvent.change(screen.getByLabelText("Check number"), { target: { value: "1001" } });
          fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
          await screen.findByTestId("counter-outcome-unknown");
          lookupAsync.mockRejectedValueOnce({ response: { status: 500 } });
          check();
          await waitFor(() => expect(lookupAsync).toHaveBeenCalledTimes(1));
          expect(lookupAsync).toHaveBeenCalledWith({ idempotencyKey: keyOfCall(0), method });
        },
      );

      const voided = {
        response: { status: 409, data: { code: "COUNTER_SALE_VOIDED", message: "RAW" } },
      };

      it("a by-key 409 COUNTER_SALE_VOIDED is FINAL: the exact copy, unlocked, key dropped, and NO POST", async () => {
        await goUnknown({ response: { status: 503 } });
        lookupAsync.mockRejectedValueOnce(voided);
        check();
        await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
        expect(screen.getByRole("alert")).toHaveTextContent("Voided — start a new sale");
        expect(screen.getByRole("alert").textContent).toBe("Voided — start a new sale");
        expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
        expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
        expect(mutateAsync).toHaveBeenCalledTimes(1); // no re-POST
        expect(screen.queryByText(/nothing was charged/i)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "$20" }));
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
        expect(keyOfCall(1)).not.toBe(keyOfCall(0));
      });

      const CHANGED_COPY = "This sale was changed after it was rung — check with the office.";
      const changed = {
        response: { status: 409, data: { code: "COUNTER_SALE_CHANGED", message: "RAW" } },
      };

      it("a by-key 409 COUNTER_SALE_CHANGED is FINAL: the exact copy, unlocked, key dropped, and NO POST", async () => {
        await goUnknown({ response: { status: 503 } });
        lookupAsync.mockRejectedValueOnce(changed);
        check();
        await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
        expect(screen.getByRole("alert").textContent).toBe(CHANGED_COPY);
        expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
        expect(mutateAsync).toHaveBeenCalledTimes(1); // no re-POST
        expect(lookupAsync).toHaveBeenCalledTimes(1);
        expect(screen.queryByText(/nothing was charged/i)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "$20" }));
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
        expect(keyOfCall(1)).not.toBe(keyOfCall(0)); // the key was dropped: a NEW sale
      });

      it("a Try again answered 409 COUNTER_SALE_CHANGED is final too (an unknown attempt unlocks)", async () => {
        await goUnknown({ response: { status: 503 } });
        mutateAsync.mockRejectedValueOnce(changed);
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
        expect(screen.getByRole("alert").textContent).toBe(CHANGED_COPY);
        expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
        expect(mutateAsync).toHaveBeenCalledTimes(2);
      });

      it("a Try again answered 409 COUNTER_SALE_VOIDED is final too (an unknown attempt unlocks)", async () => {
        await goUnknown({ response: { status: 503 } });
        mutateAsync.mockRejectedValueOnce(voided);
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
        expect(screen.getByRole("alert")).toHaveTextContent("Voided — start a new sale");
        expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
        expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
        expect(mutateAsync).toHaveBeenCalledTimes(2);
      });

      describe("a by-key 409 COUNTER_SALE_INCOMPLETE (half-written): re-POST the SAME attempt once", () => {
        const incomplete = {
          response: { status: 409, data: { code: "COUNTER_SALE_INCOMPLETE" } },
        };
        it("re-sends the same key and body and shows the receipt", async () => {
          await goUnknown({ response: { status: 503 } });
          lookupAsync.mockRejectedValueOnce(incomplete);
          check();
          await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
          expect(keyOfCall(1)).toBe(keyOfCall(0));
          expect(mutateAsync.mock.calls[1][0].dto).toEqual(mutateAsync.mock.calls[0][0].dto);
          expect(await screen.findByTestId("counter-sale-receipt")).toBeInTheDocument();
          expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
          expect(lookupAsync).toHaveBeenCalledTimes(1);
        });

        it("then a 503 on the re-POST stays locked: banner, same key, no 'Nothing was charged'", async () => {
          await goUnknown({ response: { status: 503 } });
          lookupAsync.mockRejectedValueOnce(incomplete);
          mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
          check();
          await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
          expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
          expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
          expect(screen.queryByText(/nothing was charged/i)).toBeNull();
          expect(keyOfCall(1)).toBe(keyOfCall(0));
          expect(lookupAsync).toHaveBeenCalledTimes(1); // once, not a loop
          expect(mutateAsync).toHaveBeenCalledTimes(2);
        });

        it("then a 409 COUNTER_SALE_VOIDED on the re-POST is FINAL: the exact copy, unlocked, key dropped, no further retry", async () => {
          await goUnknown({ response: { status: 503 } });
          lookupAsync.mockRejectedValueOnce(incomplete);
          mutateAsync.mockRejectedValueOnce(voided);
          check();
          await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
          await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
          expect(screen.getByRole("alert")).toHaveTextContent("Voided — start a new sale");
          expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
          expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
          expect(keyOfCall(1)).toBe(keyOfCall(0));
          expect(lookupAsync).toHaveBeenCalledTimes(1);
          expect(mutateAsync).toHaveBeenCalledTimes(2); // never a third send
          fireEvent.click(screen.getByRole("button", { name: "$20" }));
          fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
          await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(3));
          expect(keyOfCall(2)).not.toBe(keyOfCall(0)); // the key was dropped: a NEW sale
        });

        it("then a refusal on the re-POST (a 403) also stays locked", async () => {
          await goUnknown({ response: { status: 503 } });
          lookupAsync.mockRejectedValueOnce(incomplete);
          mutateAsync.mockRejectedValueOnce({ response: { status: 403 } });
          check();
          await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
          expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
          expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
          expect(screen.queryByText(/nothing was charged/i)).toBeNull();
        });
      });

      it("a 404 COUNTER_SALE_NOT_FOUND unlocks the cart, and the next submit uses a NEW key", async () => {
        await goUnknown({ response: { status: 503 } });
        lookupAsync.mockRejectedValueOnce({
          response: { status: 404, data: { code: "COUNTER_SALE_NOT_FOUND" } },
        });
        check();
        await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
        expect(lookupAsync).toHaveBeenCalledWith({ idempotencyKey: keyOfCall(0), method: "CASH" });
        expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
        expect(screen.queryByText(/nothing was charged/i)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "$20" }));
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
        expect(keyOfCall(1)).not.toBe(keyOfCall(0));
      });

      it("a 200 sale shows its receipt and clears the banner (and prints once with auto-print on)", async () => {
        window.localStorage.setItem("rf.counterSale.autoPrint", "1");
        mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
        renderWithProviders(<CounterSaleScreen />);
        await waitFor(() =>
          expect(screen.getByLabelText("Print receipt automatically")).toBeChecked(),
        );
        await fillCola();
        fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
        await screen.findByTestId("counter-outcome-unknown");
        lookupAsync.mockResolvedValueOnce(sale);
        check();
        expect(await screen.findByTestId("counter-sale-receipt")).toHaveTextContent("INV-1");
        expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
        expect(printSpy).toHaveBeenCalledTimes(1);
      });

      describe("a recovered sale reads by the tender method the server derived (M)", () => {
        const recover = async (body: Record<string, unknown>, method?: "Card") => {
          mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
          renderWithProviders(<CounterSaleScreen />);
          await fillCola();
          if (method) fireEvent.click(screen.getByRole("button", { name: method }));
          fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
          await screen.findByTestId("counter-outcome-unknown");
          lookupAsync.mockResolvedValueOnce({ ...sale, ...body });
          check();
          return screen.findByTestId("counter-sale-receipt");
        };

        it("MUST2: a recovered CASH sale the server says is NOT recorded with a balance due re-POSTs the SAME key and body to finish it", async () => {
          mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
          renderWithProviders(<CounterSaleScreen />);
          await fillCola();
          fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
          await screen.findByTestId("counter-outcome-unknown");
          lookupAsync.mockResolvedValueOnce({
            ...sale,
            paid: 0,
            balanceDue: 2.5,
            change: undefined,
            method: "CASH",
            paymentRecorded: false,
            paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
          });
          check();
          await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
          expect(lookupAsync).toHaveBeenCalledWith({ idempotencyKey: "key-1", method: "CASH" });
          expect(keyOfCall(1)).toBe(keyOfCall(0)); // never a new key
          expect(mutateAsync.mock.calls[1][0].dto).toEqual(mutateAsync.mock.calls[0][0].dto);
          await screen.findByTestId("counter-sale-receipt");
          expect(screen.queryByTestId("counter-payment-not-recorded")).toBeNull();
          expect(lookupAsync).toHaveBeenCalledTimes(1); // once, not a loop
        });

        it("MUST2: when the finishing re-POST still reports payment not recorded, the panel shows (no third send)", async () => {
          mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
          renderWithProviders(<CounterSaleScreen />);
          await fillCola();
          fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
          await screen.findByTestId("counter-outcome-unknown");
          const stored = {
            ...sale,
            paid: 0,
            balanceDue: 2.5,
            change: undefined,
            method: "CASH",
            paymentRecorded: false,
            paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
          };
          lookupAsync.mockResolvedValueOnce(stored);
          mutateAsync.mockResolvedValueOnce({ ...stored, replayed: true });
          check();
          expect(await screen.findByTestId("counter-payment-not-recorded")).toHaveTextContent(
            "Sale recorded — payment not recorded",
          );
          expect(screen.getByRole("link", { name: "Record payment" })).toHaveAttribute(
            "href",
            "/invoices/i1",
          );
          expect(mutateAsync).toHaveBeenCalledTimes(2);
        });

        it("MUST1: the SERVER's paymentRecorded wins: an intended partial the server calls recorded is not re-derived as unrecorded, and nothing re-POSTs", async () => {
          mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
          renderWithProviders(<CounterSaleScreen />);
          await scan("012345678905");
          await waitFor(() =>
            expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"),
          );
          fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "3" } });
          fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
          await screen.findByTestId("counter-outcome-unknown");
          // the server priced it higher than the screen's estimate: stored 3.00 of 5.00, server says recorded
          lookupAsync.mockResolvedValueOnce({
            ...sale,
            total: 5,
            paid: 3,
            balanceDue: 2,
            change: undefined,
            method: "CASH",
            paymentRecorded: true,
          });
          check();
          await screen.findByTestId("counter-sale-receipt");
          expect(screen.queryByTestId("counter-payment-not-recorded")).toBeNull();
          expect(screen.getByText("Paid").nextSibling).toHaveTextContent("$3.00");
          expect(screen.getByText("Balance due").nextSibling).toHaveTextContent("$2.00");
          expect(mutateAsync).toHaveBeenCalledTimes(1);
        });

        it("MUST1: stored paid below the tender but the server says recorded: the receipt follows the server", async () => {
          await recover({ paid: 1, balanceDue: 1.5, method: "CASH", paymentRecorded: true });
          expect(screen.queryByTestId("counter-payment-not-recorded")).toBeNull();
        });

        it("a recovered On account sale (the attempt WAS On account) reads as On account with the balance due", async () => {
          customersFor = [{ id: "c1", businessName: "Acme Co", fulfillPath: "ROUTE" }];
          mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
          renderWithProviders(<CounterSaleScreen />);
          fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
          fireEvent.click(screen.getByRole("button", { name: "Acme Co" }));
          await scan("012345678905");
          await waitFor(() =>
            expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"),
          );
          fireEvent.click(screen.getByRole("button", { name: "On account" }));
          fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
          await screen.findByTestId("counter-outcome-unknown");
          lookupAsync.mockResolvedValueOnce({
            ...sale,
            paid: 0,
            balanceDue: 2.5,
            change: undefined,
            method: "ON_ACCOUNT",
            paymentRecorded: true,
          });
          check();
          const receipt = await screen.findByTestId("counter-sale-receipt");
          const note = screen.getByTestId("counter-on-account");
          expect(note).toHaveTextContent("On account");
          expect(note).toHaveTextContent("$2.50");
          expect(screen.queryByTestId("counter-payment-not-recorded")).toBeNull();
          expect(receipt.textContent).not.toMatch(/Paid/);
        });

        it.each([
          ["CASH", "CASH"],
          ["CARD", "CARD"],
        ])("%s: reads as paid, with no On account note", async (_l, method) => {
          await recover(
            { paid: 2.5, balanceDue: 0, change: undefined, method },
            method === "CARD" ? "Card" : undefined,
          );
          expect(screen.getByText("Paid").nextSibling).toHaveTextContent("$2.50");
          expect(screen.queryByTestId("counter-on-account")).toBeNull();
          expect(screen.queryByTestId("counter-payment-not-recorded")).toBeNull();
        });

        describe("a recovered CASH receipt shows tendered and change (S3)", () => {
          it("without a change from the server: tendered and change come from the submitted attempt, labelled 'as entered'", async () => {
            await recover({ paid: 2.5, balanceDue: 0, change: undefined, method: "CASH" });
            const tendered = screen.getByText("Tendered").closest("div")!;
            expect(tendered).toHaveTextContent("$20.00");
            expect(tendered).toHaveTextContent("as entered");
            const change = screen.getByText("Change").closest("div")!;
            expect(change).toHaveTextContent("$17.50");
            expect(change).toHaveTextContent("as entered");
          });

          it("with the server's change: that change is shown unlabelled; the tendered stays 'as entered'", async () => {
            await recover({ paid: 2.5, balanceDue: 0, change: 17.5, method: "CASH" });
            const change = screen.getByText("Change").closest("div")!;
            expect(change).toHaveTextContent("$17.50");
            expect(change.textContent).not.toMatch(/as entered/);
            expect(screen.getByText("Tendered").closest("div")).toHaveTextContent("as entered");
          });

          it("an exact cash tender has no change line", async () => {
            mutateAsync.mockRejectedValueOnce({ response: { status: 503 } });
            renderWithProviders(<CounterSaleScreen />);
            await fillCola();
            fireEvent.click(screen.getByRole("button", { name: "Exact" }));
            fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
            await screen.findByTestId("counter-outcome-unknown");
            lookupAsync.mockResolvedValueOnce({ ...sale, change: undefined, method: "CASH" });
            check();
            await screen.findByTestId("counter-sale-receipt");
            expect(screen.queryByText("Change")).toBeNull();
            expect(screen.getByText("Tendered").closest("div")).toHaveTextContent("$2.50");
          });

          it("a CARD receipt shows no tendered and no change", async () => {
            await recover({ paid: 2.5, balanceDue: 0, change: undefined, method: "CARD" }, "Card");
            expect(screen.queryByText("Tendered")).toBeNull();
            expect(screen.queryByText("Change")).toBeNull();
          });

          it("a live (non-recovered) cash receipt: server change, Tendered = paid + change, no 'as entered'", async () => {
            renderWithProviders(<CounterSaleScreen />);
            await fillCola();
            fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
            const receipt = await screen.findByTestId("counter-sale-receipt");
            expect(screen.getByText("Change")).toBeInTheDocument();
            expect(screen.getByTestId("receipt-tendered")).toHaveTextContent("$37.50");
            expect(receipt.textContent).not.toMatch(/as entered/);
          });
        });

        it("MUST1: an unrecorded recovered sale with NO balance due (nothing to finish) follows the server's flag", async () => {
          await recover({
            paid: 2.5,
            balanceDue: 0,
            method: "CASH",
            paymentRecorded: false,
            paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
          });
          expect(screen.getByTestId("counter-payment-not-recorded")).toBeInTheDocument();
          expect(mutateAsync).toHaveBeenCalledTimes(1);
        });
      });

      it.each([
        ["a 404 without the code", { response: { status: 404 } }],
        ["a 403", { response: { status: 403 } }],
        ["a 429", { response: { status: 429 } }],
        ["a 500", { response: { status: 500 } }],
        ["a network error", new Error("Network Error")],
      ])(
        "%s shows exactly the fixed lookup-failure copy, with the lock and banner kept (S2)",
        async (_l, failure) => {
          await goUnknown({ response: { status: 503 } });
          lookupAsync.mockRejectedValueOnce(failure);
          check();
          const msg = await screen.findByText("Couldn't check the sale. Try again.");
          expect(msg.textContent).toBe("Couldn't check the sale. Try again.");
          expect(screen.getByTestId("counter-outcome-unknown")).toBeInTheDocument();
          expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
          // a later successful check clears it
          lookupAsync.mockResolvedValueOnce(sale);
          check();
          await screen.findByTestId("counter-sale-receipt");
          expect(screen.queryByText("Couldn't check the sale. Try again.")).toBeNull();
        },
      );

      it("a 404 COUNTER_SALE_NOT_FOUND shows no lookup-failure copy (it is an answer)", async () => {
        await goUnknown({ response: { status: 503 } });
        lookupAsync.mockRejectedValueOnce({
          response: { status: 404, data: { code: "COUNTER_SALE_NOT_FOUND" } },
        });
        check();
        await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
        expect(screen.queryByText("Couldn't check the sale. Try again.")).toBeNull();
      });

      it.each([
        ["a 404 without the code", { response: { status: 404 } }],
        ["a 403", { response: { status: 403 } }],
        ["a 429", { response: { status: 429 } }],
        ["a 500", { response: { status: 500 } }],
        ["a network error", new Error("Network Error")],
      ])("%s keeps the lock and the banner", async (_l, failure) => {
        await goUnknown({ response: { status: 503 } });
        lookupAsync.mockRejectedValueOnce(failure);
        check();
        await waitFor(() => expect(lookupAsync).toHaveBeenCalledTimes(1));
        expect(await screen.findByTestId("counter-outcome-unknown")).toHaveTextContent(
          "We couldn't confirm the sale. Check recent sales before trying again.",
        );
        expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
        expect(screen.queryByText(/nothing was charged/i)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
        expect(keyOfCall(1)).toBe(keyOfCall(0));
      });
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
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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

    it("Complete & next sale whose server CHANGE differs from the one the screen showed stays on the receipt with the server's figures", async () => {
      mutateAsync.mockResolvedValue({
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 2.5,
        paid: 7.5,
        balanceDue: 0,
        change: 5, // e.g. a credit was auto-applied: the screen said $17.50
        paymentRecorded: true,
      });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      expect(screen.getByTestId("change-due")).toHaveTextContent("Change $17.50");
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      const receipt = await screen.findByTestId("counter-sale-receipt");
      expect(screen.getByText("Change").nextSibling).toHaveTextContent("$5.00");
      expect(screen.getByText("Paid").nextSibling).toHaveTextContent("$7.50");
      expect(receipt.textContent).not.toMatch(/17\.50/);
      expect(screen.queryByText("No items yet.")).toBeNull();
    });

    it("a non-cash sale whose server response carries change is held too (the screen showed none)", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
      fireEvent.click(screen.getByRole("button", { name: "Card" }));
      mutateAsync.mockResolvedValue({
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 2.5,
        paid: 5,
        balanceDue: 0,
        change: 2.5,
        paymentRecorded: true,
      });
      fireEvent.click(screen.getByRole("button", { name: /Complete & next sale/ }));
      expect(await screen.findByTestId("counter-sale-receipt")).toBeInTheDocument();
      expect(screen.getByText("Change").nextSibling).toHaveTextContent("$2.50");
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

  describe("the wire line carries {boxes, pieces, qty} the way the server normalises it", () => {
    const line = (over: Record<string, unknown>) => ({
      tempId: "t",
      productId: "p",
      name: "N",
      unitPrice: 1,
      qty: 1,
      ...over,
    });
    it("a unitsPerBox=1 product sends its qty (never boxes alone, which the server reads as 0)", () => {
      expect(toSaleItem(line({ unitsPerBox: 1, boxes: 3, pieces: 0, qty: 3 }))).toEqual({
        productId: "p",
        qty: 3,
      });
    });
    it("a boxed product with boxes only sends boxes, pieces 0 and the integer piece count", () => {
      expect(toSaleItem(line({ unitsPerBox: 12, boxes: 2, pieces: 0, qty: 24 }))).toEqual({
        productId: "p",
        boxes: 2,
        pieces: 0,
        qty: 24,
      });
    });
    it("a boxed product with pieces only sends boxes 0, the pieces and the piece count", () => {
      expect(toSaleItem(line({ unitsPerBox: 12, boxes: 0, pieces: 5, qty: 5 }))).toEqual({
        productId: "p",
        boxes: 0,
        pieces: 5,
        qty: 5,
      });
    });
    it("pieces that roll over a box are normalised (13 pieces of a 12-pack = 1 box + 1 piece)", () => {
      expect(toSaleItem(line({ unitsPerBox: 12, boxes: 0, pieces: 13, qty: 13 }))).toEqual({
        productId: "p",
        boxes: 1,
        pieces: 1,
        qty: 13,
      });
    });
    it("a plain product sends qty only", () => {
      expect(toSaleItem(line({ qty: 4 }))).toEqual({ productId: "p", qty: 4 });
    });
    it("end to end: a scanned unitsPerBox=1 product and a boxed one post consistent lines", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await scan("ONE");
      await scan("WATER");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$13.00"));
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
      expect(mutateAsync.mock.calls[0][0].dto.items).toEqual([
        { productId: "p-one", qty: 1 },
        { productId: "p-water", boxes: 1, pieces: 0, qty: 12 },
      ]);
    });
  });

  describe("line quantities read right on the cart and the receipt (N1, N2)", () => {
    const completeAndReceipt = async () => {
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      return screen.findByTestId("counter-sale-receipt");
    };

    it("N1: a pack-of-1 line shows pieces, never '1 box', in the cart and on the receipt", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await scan("ONE");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$1.00"));
      const cart = screen.getByRole("list", { name: "Items" });
      expect(cart).toHaveTextContent("Single · × 1");
      expect(cart.textContent).not.toMatch(/box/i);
      const receipt = await completeAndReceipt();
      expect(receipt).toHaveTextContent("Single");
      expect(receipt).toHaveTextContent("1 × $1.00");
      expect(receipt.textContent).not.toMatch(/box/i);
    });

    it("N2: ONE label serves the cart and the receipt: boxes, then loose pieces (1 box + 5 pcs)", () => {
      const line = (over: Record<string, unknown>) =>
        ({ tempId: "t", productId: "p", name: "Water", unitPrice: 1, qty: 1, ...over }) as never;
      expect(lineQtyLabel(line({ unitsPerBox: 12, boxes: 1, pieces: 5, qty: 17 }))).toBe(
        "1 box + 5 pcs",
      );
      expect(lineQtyLabel(line({ unitsPerBox: 12, boxes: 2, pieces: 0, qty: 24 }))).toBe("2 boxes");
      expect(lineQtyLabel(line({ unitsPerBox: 12, boxes: 0, pieces: 5, qty: 5 }))).toBe(
        "0 boxes + 5 pcs",
      );
      expect(lineQtyLabel(line({ unitsPerBox: 1, boxes: 1, pieces: 0, qty: 1 }))).toBe("× 1");
      expect(lineQtyLabel(line({ qty: 3 }))).toBe("× 3");
    });

    it("N2: a boxed line reads the same on the receipt as in the cart", async () => {
      renderWithProviders(<CounterSaleScreen />);
      await scan("WATER");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$12.00"));
      expect(screen.getByRole("list", { name: "Items" })).toHaveTextContent("Water · 1 box");
      const receipt = await completeAndReceipt();
      expect(receipt).toHaveTextContent("1 box × $12.00 per box");
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
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(screen.getByText(/Order ORD-1/)).toHaveTextContent("Invoice INV-1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("fixed error copy by status", () => {
    const failWith = async (response: unknown) => {
      mutateAsync.mockRejectedValue({ response });
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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

    // POS-1 guards (green before and after: the cash Enter already completes and stays on the receipt).
    it("POS-1: cash Enter completes and STAYS on the receipt (no auto-reset to a fresh sale)", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CounterSaleScreen />);
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
      await user.type(screen.getByLabelText("Amount tendered"), "20{Enter}");
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      expect(screen.getByRole("heading", { name: "Receipt" })).toBeInTheDocument();
      expect(screen.queryByText("No items yet.")).toBeNull();
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    });

    it("POS-1: two rapid Enters in the cash field send exactly ONE sale POST", async () => {
      let release: (v: unknown) => void = () => {};
      mutateAsync.mockReturnValueOnce(new Promise((r) => (release = r)));
      renderWithProviders(<CounterSaleScreen />);
      await fillCola();
      const tender = screen.getByLabelText("Amount tendered");
      fireEvent.keyDown(tender, { key: "Enter" });
      fireEvent.keyDown(tender, { key: "Enter" });
      expect(mutateAsync).toHaveBeenCalledTimes(1);
      release({
        orderId: "o",
        orderNumber: "O",
        invoiceId: "i",
        invoiceNumber: "I",
        total: 2.5,
        paid: 20,
        balanceDue: 0,
        change: 17.5,
        paymentRecorded: true,
      });
      await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    });

    it("POS-1: the main button is exactly 'Complete & show receipt'; 'Complete & next sale' is unchanged", () => {
      renderWithProviders(<CounterSaleScreen />);
      expect(screen.getByRole("button", { name: "Complete & show receipt" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Complete & next sale" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Complete sale" })).toBeNull();
    });

    it("POS-1: after completing, keyboard focus lands on the receipt heading", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CounterSaleScreen />);
      await scan("012345678905");
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
      await user.type(screen.getByLabelText("Amount tendered"), "20{Enter}");
      const heading = await screen.findByRole("heading", { name: "Receipt" });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(heading).toHaveAttribute("tabindex", "-1");
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
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
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

describe("CounterSaleScreen: held attempt hardening", () => {
  const STORE_KEY = "rf.counterSale.heldAttempt:acme:u-a";
  const fillCola = async () => {
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
  };
  const keyOfCall = (i: number) => mutateAsync.mock.calls[i][0].idempotencyKey as string;
  const goUnknown = async (failure: unknown = { response: { status: 503 } }) => {
    mutateAsync.mockRejectedValueOnce(failure);
    const view = renderWithProviders(<CounterSaleScreen />);
    await fillCola();
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await screen.findByTestId("counter-outcome-unknown");
    return view;
  };
  beforeEach(() => window.sessionStorage.clear());

  it("MUST1: while the outcome is unknown, 'Ship this order instead' is disabled and keeps the key and cart", async () => {
    gate = { ...gate, offerShipInstead: true };
    await goUnknown();
    const ship = screen.getByRole("button", { name: "Ship this order instead" });
    expect(ship).toBeDisabled();
    fireEvent.click(ship);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(keyOfCall(1)).toBe(keyOfCall(0));
  });

  it("MUST2: unknown -> unmount -> remount restores the locked screen and the retry uses the SAME key and body", async () => {
    const view = await goUnknown();
    view.unmount();
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
    expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Cola" })).toBeInTheDocument();
    expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(keyOfCall(1)).toBe(keyOfCall(0));
    expect(mutateAsync.mock.calls[1][0].dto).toEqual(mutateAsync.mock.calls[0][0].dto);
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
  });

  it("MUST2: a known outcome clears the stored attempt (success, and a definitive 404 from the lookup)", async () => {
    const view = await goUnknown();
    expect(window.sessionStorage.getItem(STORE_KEY)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
    view.unmount();
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
  });

  it("MUST2: a lookup 404 (nothing written) clears the stored attempt", async () => {
    await goUnknown();
    lookupAsync.mockRejectedValueOnce({
      response: { status: 404, data: { code: "COUNTER_SALE_NOT_FOUND" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check sale status" }));
    await waitFor(() => expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull());
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
  });

  it.each([
    ["corrupt JSON", () => "{not json"],
    [
      "a non-numeric quantity",
      () =>
        JSON.stringify({
          key: "k",
          dto: { payment: { method: "CASH" } },
          lines: [{ tempId: "t", productId: "p", name: "C", unitPrice: 1, qty: "x" }],
          method: "CASH",
        }),
    ],
    [
      "a missing key",
      () =>
        JSON.stringify({
          dto: { payment: { method: "CASH" } },
          lines: [],
          method: "CASH",
        }),
    ],
  ])(
    "MUST2: %s stays locked on check-recent-sales, no crash, marker kept until Discard",
    (_n, payload) => {
      window.sessionStorage.setItem(STORE_KEY, payload());
      const first = renderWithProviders(<CounterSaleScreen />);
      expect(screen.getByTestId("counter-outcome-unknown")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Check recent sales" })).toBeInTheDocument();
      expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
      expect(JSON.parse(window.sessionStorage.getItem(STORE_KEY) as string)).toEqual({
        state: "unknown",
      });
      // a reload (remount) is STILL locked
      first.unmount();
      renderWithProviders(<CounterSaleScreen />);
      expect(screen.getByTestId("counter-outcome-unknown")).toBeInTheDocument();
      expect(screen.getByLabelText("Scan or search items")).toBeDisabled();
      // the Discard copy says the sale may have gone through
      expect(
        screen.getByText(
          "The previous sale may have gone through. Check recent sales before ringing it again.",
        ),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Discard and start a new sale" }));
      expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
      expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
      expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
    },
  );

  it("restores the locked sale with a slimmed customer (name still shown)", async () => {
    window.sessionStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        key: "k",
        dto: { payment: { method: "CASH" } },
        next: false,
        estimate: { total: 2.5, change: 0 },
        lines: [{ tempId: "t", productId: "p", name: "Cola", unitPrice: 2.5, qty: 1 }],
        customer: { id: "c1", businessName: "Acme Foods", pricingTier: 1, fulfillPath: null },
        method: "CASH",
        tendered: "",
        reference: "",
      }),
    );
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
    expect(screen.getByText("Acme Foods")).toBeInTheDocument();
  });

  it("a held attempt never restores for another user or tenant, and restores again for the owner", async () => {
    const view = await goUnknown();
    view.unmount();
    authUser = { id: "u-b", tenantSlug: "acme" };
    const b = renderWithProviders(<CounterSaleScreen />);
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
    b.unmount();
    authUser = { id: "u-a", tenantSlug: "other" };
    const c = renderWithProviders(<CounterSaleScreen />);
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    c.unmount();
    authUser = { id: "u-a", tenantSlug: "acme" };
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
  });

  it("with no known tenant or user nothing is stored or restored", async () => {
    authUser = { id: "u-a", tenantSlug: null };
    await goUnknown();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("MUST3: the cash amount sent is rounded to cents", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "10.005" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.payment.amount).toBe(roundMoney(10.005));
    expect(mutateAsync.mock.calls[0][0].dto.payment.amount).toBe(10.01);
  });

  it("SHOULD a: a double click on Complete & show receipt sends ONE POST", async () => {
    let release: (v: unknown) => void = () => {};
    mutateAsync.mockReturnValueOnce(new Promise((r) => (release = r)));
    renderWithProviders(<CounterSaleScreen />);
    await fillCola();
    const btn = screen.getByRole("button", { name: "Complete & show receipt" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.keyDown(screen.getByLabelText("Amount tendered"), { key: "Enter" });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    release({
      orderId: "o",
      orderNumber: "O",
      invoiceId: "i",
      invoiceNumber: "I",
      total: 2.5,
      paid: 20,
      balanceDue: 0,
      change: 17.5,
      paymentRecorded: true,
    });
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("SHOULD b: a first-attempt WALK_IN_OPEN_CREDIT says what to do", async () => {
    mutateAsync.mockRejectedValueOnce({
      response: { status: 409, data: { code: "WALK_IN_OPEN_CREDIT" } },
    });
    renderWithProviders(<CounterSaleScreen />);
    await fillCola();
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This walk-in has open credit. Resolve it on the customer, then ring the sale again.",
    );
  });

  it("SHOULD b: a FIRST-attempt COUNTER_SALE_KEY_CONFLICT is definitive: new key, clear copy", async () => {
    mutateAsync.mockRejectedValueOnce({
      response: { status: 409, data: { code: "COUNTER_SALE_KEY_CONFLICT" } },
    });
    renderWithProviders(<CounterSaleScreen />);
    await fillCola();
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That sale reference was already used. Ring the sale again.",
    );
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("SHOULD b: COUNTER_SALE_KEY_CONFLICT on a RETRY stays the unknown-outcome path", async () => {
    await goUnknown();
    mutateAsync.mockRejectedValueOnce({
      response: { status: 409, data: { code: "COUNTER_SALE_KEY_CONFLICT" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
  });
});

describe("CounterSaleScreen: the live cart survives a refresh (SA-748 section 1)", () => {
  const LIVE_KEY = "rf.counterSale.liveCart:acme:u-a";
  const HELD_KEY = "rf.counterSale.heldAttempt:acme:u-a";
  // A refresh keeps the tab's sessionStorage, so the cart's writer id is this tab's id.
  beforeEach(() =>
    window.sessionStorage.setItem("rf.counterSale.tabId", "tab-from-before-the-refresh"),
  );
  const colaLine = {
    tempId: "p-cola-0",
    productId: "p-cola",
    name: "Cola",
    unitPrice: 2.5,
    qty: 3,
    listPrice: 2.5,
    unit: "each",
    priceType: "STANDARD",
  };
  const liveCart = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      owner: "tab-from-before-the-refresh",
      lines: [colaLine],
      customer: null,
      method: "CASH",
      tendered: "10",
      reference: "",
      ...over,
    });

  it("saves the cart (debounced) as the clerk rings it", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).not.toBeNull());
    const saved = JSON.parse(window.localStorage.getItem(LIVE_KEY) as string);
    expect(saved.lines).toHaveLength(1);
    expect(saved.lines[0]).toMatchObject({ productId: "p-cola", qty: 1 });
    expect(saved.method).toBe("CASH");
  });

  it("puts the cart back UNLOCKED with a banner after a refresh", async () => {
    window.localStorage.setItem(LIVE_KEY, liveCart());
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByTestId("counter-cart-restored")).toBeInTheDocument();
    expect(screen.getByTestId("running-total")).toHaveTextContent("$7.50");
    // the cash is NOT restored: prices may have moved, so the clerk taps the amount against today's total
    expect(screen.getByLabelText("Amount tendered")).toHaveValue("");
    expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
    expect(screen.queryByTestId("counter-outcome-unknown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByTestId("counter-cart-restored")).toBeNull();
  });

  it("a held attempt always wins: the live cart is not restored over it, and is dropped", async () => {
    window.sessionStorage.setItem(
      HELD_KEY,
      JSON.stringify({
        key: "k1",
        dto: { walkIn: true, items: [], payment: { method: "CASH", amount: 5 } },
        next: false,
        estimate: { total: 2.5, change: 2.5 },
        lines: [{ ...colaLine, qty: 1 }],
        customer: null,
        method: "CASH",
        tendered: "5",
        reference: "",
      }),
    );
    window.localStorage.setItem(LIVE_KEY, liveCart());
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
    expect(screen.queryByTestId("counter-cart-restored")).toBeNull();
    expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"); // the held cart, not the live one
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).toBeNull());
  });

  it("an unreadable stored cart is dropped and never locks the till", async () => {
    window.localStorage.setItem(LIVE_KEY, "{not json");
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
    expect(screen.queryByTestId("counter-cart-restored")).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).toBeNull());
  });

  it("a completed sale leaves nothing behind to restore", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).toBeNull());
    await new Promise((r) => setTimeout(r, 600)); // past the save delay: still nothing
    expect(window.localStorage.getItem(LIVE_KEY)).toBeNull();
  });

  it("a cart cleared by the clerk clears the stored one", async () => {
    window.localStorage.setItem(LIVE_KEY, liveCart());
    renderWithProviders(<CounterSaleScreen />);
    await screen.findByTestId("counter-cart-restored");
    fireEvent.click(screen.getByRole("button", { name: "Remove Cola" }));
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).toBeNull());
  });

  it("a cart stored under an unknown schema version is dropped, not restored", async () => {
    window.localStorage.setItem(LIVE_KEY, liveCart({ v: 99 }));
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByLabelText("Scan or search items")).not.toBeDisabled();
    expect(screen.queryByTestId("counter-cart-restored")).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).toBeNull());
  });

  it("a refresh MID-SEND cannot write the cart back (pagehide flush stays quiet)", async () => {
    mutateAsync.mockReturnValue(new Promise(() => undefined)); // the POST never answers
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(window.localStorage.getItem(LIVE_KEY)).toBeNull(); // cleared synchronously, before the POST can answer
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 600));
    expect(window.localStorage.getItem(LIVE_KEY)).toBeNull();
  });

  it("an UNKNOWN outcome keeps the cart out of live storage (the held attempt owns it)", async () => {
    mutateAsync.mockRejectedValue({ message: "Network Error" });
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByTestId("counter-outcome-unknown")).toBeInTheDocument();
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 600));
    expect(window.localStorage.getItem(LIVE_KEY)).toBeNull();
  });

  it("a definitive refusal puts the cart back into storage (nothing was written)", async () => {
    mutateAsync.mockRejectedValue({ response: { status: 400, data: { message: "RAW" } } });
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/as entered/);
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).not.toBeNull());
  });

  it("Discard on the leave dialog drops the stored cart too, so it is not restored next visit (SA-748 MEDIUM)", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).not.toBeNull());
    const proceed = jest.fn();
    expect(guardCounterLeave(proceed)).toBe(true); // the "Discard this sale?" dialog opens
    expect(window.localStorage.getItem(LIVE_KEY)).not.toBeNull(); // Keep selling would still have it
    confirmCounterLeave(); // Discard
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(LIVE_KEY)).toBeNull();
    await new Promise((r) => setTimeout(r, 600));
    expect(window.localStorage.getItem(LIVE_KEY)).toBeNull();
  });

  it("Keep selling leaves the stored cart alone", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("012345678905");
    await waitFor(() => expect(window.localStorage.getItem(LIVE_KEY)).not.toBeNull());
    expect(guardCounterLeave(jest.fn())).toBe(true);
    cancelCounterLeave();
    await new Promise((r) => setTimeout(r, 600));
    expect(window.localStorage.getItem(LIVE_KEY)).not.toBeNull();
  });

  describe("two tabs", () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "locks");
    const installLocks = (granted: boolean) => {
      Object.defineProperty(window.navigator, "locks", {
        configurable: true,
        value: {
          request: (_name: string, _opts: unknown, cb: (lock: unknown) => unknown) =>
            Promise.resolve(cb(granted ? { name: "held" } : null)),
        },
      });
    };
    afterEach(() => {
      if (original) Object.defineProperty(window.navigator, "locks", original);
      else delete (window.navigator as unknown as Record<string, unknown>).locks;
    });

    it("a second live tab does NOT restore the cart, says so, and leaves the stored cart alone", async () => {
      installLocks(false); // another tab holds the till's lock
      window.localStorage.setItem(LIVE_KEY, liveCart());
      renderWithProviders(<CounterSaleScreen />);
      expect(await screen.findByTestId("counter-cart-other-tab")).toBeInTheDocument();
      expect(screen.queryByTestId("counter-cart-restored")).toBeNull();
      expect(screen.getByTestId("running-total")).toHaveTextContent("$0.00");
      await new Promise((r) => setTimeout(r, 600));
      expect(window.localStorage.getItem(LIVE_KEY)).not.toBeNull();
      // and what this tab rings never overwrites the other tab's cart
      await scan("012345678905");
      await new Promise((r) => setTimeout(r, 600));
      expect(JSON.parse(window.localStorage.getItem(LIVE_KEY) as string).lines[0].qty).toBe(3);
    });

    it("a non-owner tab ringing its own sale never deletes the owner tab's stored cart", async () => {
      installLocks(false);
      window.localStorage.setItem(LIVE_KEY, liveCart());
      mutateAsync.mockReturnValue(new Promise(() => undefined));
      renderWithProviders(<CounterSaleScreen />);
      await screen.findByTestId("counter-cart-other-tab");
      await scan("012345678905");
      fireEvent.click(screen.getByRole("button", { name: "$20" }));
      fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      await new Promise((r) => setTimeout(r, 600));
      expect(JSON.parse(window.localStorage.getItem(LIVE_KEY) as string).lines[0].qty).toBe(3);
    });

    it("the tab that wins the lock restores, even from a closed tab's cart", async () => {
      installLocks(true);
      window.localStorage.setItem(LIVE_KEY, liveCart());
      renderWithProviders(<CounterSaleScreen />);
      expect(await screen.findByTestId("counter-cart-restored")).toBeInTheDocument();
      expect(screen.getByTestId("running-total")).toHaveTextContent("$7.50");
    });

    it("an untouched restored cart is dropped when another tab clears the stored one", async () => {
      installLocks(true);
      window.localStorage.setItem(LIVE_KEY, liveCart());
      renderWithProviders(<CounterSaleScreen />);
      await screen.findByTestId("counter-cart-restored");
      window.localStorage.removeItem(LIVE_KEY);
      fireEvent(window, new StorageEvent("storage", { key: LIVE_KEY, newValue: null }));
      await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$0.00"));
      expect(screen.getByTestId("counter-cart-cleared-elsewhere")).toBeInTheDocument();
    });
  });
});

/**
 * SA-751r on the live receipt: Email receipt right after Print, a closed inline row, a walk-in opens empty, a named customer's
 * address is only a suggestion, and the next sale is never gated by it.
 */
describe("digital receipt on the live receipt (SA-751r)", () => {
  const { apiClient: api } = jest.requireMock("@/lib/api-client") as {
    apiClient: { post: jest.Mock };
  };
  const finishCashSale = async () => {
    await scan("012345678905");
    await waitFor(() => expect(screen.getByTestId("running-total")).toHaveTextContent("$2.50"));
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
  };
  beforeEach(() => {
    api.post.mockReset();
    api.post.mockResolvedValue({ data: { channel: "email", to: "x" } });
  });

  it("the receipt's row reads Print · Email receipt · New sale, and the email row is closed", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await finishCashSale();
    const root = screen.getByTestId("counter-sale-receipt");
    const names = Array.from(root.querySelectorAll("button")).map((b) => b.textContent);
    expect(names).toEqual(["Print", "Email receipt", "New sale"]);
    expect(screen.queryByRole("textbox", { name: "Email address" })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("a walk-in sale: the row opens empty and focused; typing an address and pressing Enter posts to this sale's order", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CounterSaleScreen />);
    await finishCashSale();
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    const input = screen.getByRole("textbox", { name: "Email address" }) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input).toHaveFocus();
    await user.type(input, "someone@example.com{Enter}");
    expect(await screen.findByText("Sent to someone@example.com.")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/orders/o1/receipt", {
      channel: "email",
      to: "someone@example.com",
    });
    // only the receipt endpoint was written: the typed address never reaches a customer
    expect(api.post.mock.calls.map((c) => c[0])).toEqual(["/orders/o1/receipt"]);
  });

  it("a named customer: their address is pre-filled with Send focused, and nothing is sent until the cashier presses it", async () => {
    customersFor = [
      { id: "c1", businessName: "Acme Co", email: "buyer@example.com", fulfillPath: "ROUTE" },
    ];
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Acme Co" }));
    await finishCashSale();
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    expect((screen.getByRole("textbox", { name: "Email address" }) as HTMLInputElement).value).toBe(
      "buyer@example.com",
    );
    expect(screen.getByRole("button", { name: "Send" })).toHaveFocus();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sent to buyer@example.com.")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1); // 2 presses from the receipt: Email receipt, Send
  });

  it("New sale stays enabled while the email is still sending, and starts a fresh walk-in sale", async () => {
    let resolve!: (v: unknown) => void;
    api.post.mockReturnValue(new Promise((r) => (resolve = r)));
    customersFor = [
      { id: "c1", businessName: "Acme Co", email: "buyer@example.com", fulfillPath: "ROUTE" },
    ];
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Acme Co" }));
    await finishCashSale();
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Sending…" });
    expect(screen.getByRole("button", { name: "New sale" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "New sale" }));
    expect(screen.getByText("Walk-in customer")).toBeInTheDocument();
    expect(screen.queryByTestId("counter-sale-receipt")).toBeNull();
    resolve({ data: {} });
  });

  it("a named customer whose own email is empty but whose sign-in account has one: that address is pre-filled with Send focused", async () => {
    customersFor = [
      {
        id: "c1",
        businessName: "Acme Co",
        email: null,
        user: { id: "u1", email: "login@example.com" },
        fulfillPath: "ROUTE",
      },
    ];
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Acme Co" }));
    await finishCashSale();
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    expect((screen.getByRole("textbox", { name: "Email address" }) as HTMLInputElement).value).toBe(
      "login@example.com",
    );
    expect(screen.getByRole("button", { name: "Send" })).toHaveFocus();
  });

  it("Print is still the receipt's one primary action and still prints once", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await finishCashSale();
    printSpy.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Email receipt" }).className).not.toBe(
      screen.getByRole("button", { name: "Print" }).className,
    );
  });
});
