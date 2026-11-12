import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * A scan that starts while a dialog is closing. Escape in a dialog's text field puts the content in data-state="closed" and
 * keeps it mounted for its exit animation (150 ms in the real app); focus stays in the field the whole time. A text field in
 * a closing dialog is not a typing target: the till's refocus and key redirect must not stand down for it, so the scan is
 * looked up once, whole, whatever moment it starts at.
 *
 * jsdom has no CSS animation, so Radix Presence would unmount the content at once. HARNESS: getComputedStyle reports an
 * animation name for dialog content, and a MutationObserver dispatches `animationend` 150 ms (fake clock) after the content
 * turns data-state="closed". Presence then does exactly what it does in a browser: stays mounted for 150 ms, then unmounts.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme", role: "TENANT_ADMIN" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const KNOWN = "4006381333931";
const UNKNOWN = "9999999999994";
const WATER = { id: "p-water", name: "Water", pricePerUnit: 1, unit: "each", unitsPerBox: null };
const resolved: string[] = [];
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) => {
    resolved.push(code);
    if (code === KNOWN) return { product: COLA, source: "sku" };
    if (code === "Zz99yy") return { product: WATER, source: "sku" };
    return { notFound: true };
  },
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
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
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always", methods: ["PICKUP"], staffDefault: "PICKUP" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const get = apiClient.get as unknown as jest.Mock;
const EXIT_MS = 150;
const STARTS = [0, 40, 100, 125, 150, 200] as const;
const ENDINGS = { LF: "{Enter}", CRLF: "{Enter}{Enter}" } as const;

let observer: MutationObserver | null = null;
let realComputedStyle: typeof window.getComputedStyle;
function installExitAnimation() {
  realComputedStyle = window.getComputedStyle;
  window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
    const style = realComputedStyle.call(window, el, pseudo);
    if (el.getAttribute?.("role") !== "dialog") return style;
    return new Proxy(style, {
      // like the real CSS: an exit animation runs only while the content is data-state="closed" (Presence compares names)
      get: (t, p) =>
        p === "animationName"
          ? el.getAttribute("data-state") === "closed"
            ? "rf-exit"
            : "none"
          : Reflect.get(t, p),
    });
  }) as typeof window.getComputedStyle;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as HTMLElement;
      if (el.getAttribute?.("role") !== "dialog" || el.getAttribute("data-state") !== "closed")
        continue;
      setTimeout(() => {
        const ev = new Event("animationend", { bubbles: true });
        Object.defineProperty(ev, "animationName", { value: "rf-exit" });
        el.dispatchEvent(ev);
      }, EXIT_MS);
    }
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  resolved.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  installExitAnimation();
  get.mockImplementation((url: string) => {
    if (url === "/settings")
      return Promise.resolve({ data: { taxRate: 0, timezone: "America/New_York" } });
    if (url === "/orders/counter-sale/parked")
      return Promise.resolve({ data: { data: [], total: 0, page: 1, pageSize: 20 } });
    return Promise.resolve({ data: [] });
  });
});
afterEach(() => {
  observer?.disconnect();
  window.getComputedStyle = realComputedStyle;
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

const scanBox = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const itemNames = () =>
  Array.from(document.querySelectorAll('ul[aria-label="Items"] > li'))
    .map((li) => li.textContent ?? "")
    .filter((t) => t !== "No items yet.");
const advance = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });
const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(1500);
  });
const dialogs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));

/**
 * THE INVENTORY: every till dialog whose text field holds focus when it closes with Escape. `open` brings the dialog up with
 * focus in the field and returns that field. A dialog added to the till with a text field is listed here (and the source
 * pin below fails until it is).
 */
type Case = {
  name: string;
  /** false: not a Radix dialog (W-1042 scan-pause window): it unmounts at once, there is no closing window to test */
  exitWindow: boolean;
  open: () => Promise<HTMLElement>;
};
const CASES: Case[] = [
  {
    name: "order date picker (date text box)",
    exitWindow: true,
    open: async () => {
      const chip = await screen.findByRole("button", { name: "Order date: today. Change" });
      await waitFor(() => expect(chip).toBeEnabled());
      await userEvent.setup({ delay: null, advanceTimers: jest.advanceTimersByTime }).click(chip);
      const picker = await screen.findByTestId("counter-date-picker");
      return within(picker).getByTestId("counter-date-input");
    },
  },
  {
    name: "Change the price (value field)",
    exitWindow: true,
    open: async () => {
      const user = userEvent.setup({ delay: null, advanceTimers: jest.advanceTimersByTime });
      await user.click(scanBox());
      await user.keyboard("Zz99yy{Enter}"); // a first line: Water, whose price is edited
      await user.click(await screen.findByRole("button", { name: "Change price for Water" }));
      const heading = await screen.findByRole("heading", { name: /Change the price for Water/ });
      await settle();
      resolved.length = 0;
      const dialog = heading.closest('[role="dialog"]') as HTMLElement;
      return dialog.querySelector('input:not([type="radio"])') as HTMLElement;
    },
  },
  {
    name: "New product (name field)",
    exitWindow: false,
    open: async () => {
      const user = userEvent.setup({ delay: null, advanceTimers: jest.advanceTimersByTime });
      await user.click(scanBox());
      await user.keyboard(`${UNKNOWN}{Enter}`);
      const heading = await screen.findByRole("heading", { name: "New product" });
      await settle();
      resolved.length = 0;
      const dialog = heading.closest('[role="dialog"],[data-scan-pause]') as HTMLElement;
      const label = Array.from(dialog.querySelectorAll("label")).find((l) =>
        /^Name/.test(l.textContent ?? ""),
      );
      return label?.parentElement?.querySelector("input") as HTMLElement;
    },
  },
];

describe("a scan that starts while a dialog is closing is looked up once, whole", () => {
  describe.each(CASES)("$name", ({ open, exitWindow }) => {
    describe.each(Object.entries(ENDINGS))("ending %s", (_n, ending) => {
      it.each(STARTS)("scan starts %i ms after Escape", async (start) => {
        renderTill(<CounterSaleScreen />);
        const field = await open();
        act(() => field.focus());
        expect(document.activeElement).toBe(field);
        const dialogBefore = field.closest('[role="dialog"],[data-scan-pause]') as HTMLElement;
        const user = userEvent.setup({ delay: 5, advanceTimers: jest.advanceTimersByTime });
        await user.keyboard("{Escape}");
        // the content is closing but still mounted (focus may already have moved to the scan box: that is the fix)
        if (exitWindow) {
          expect(dialogBefore.getAttribute("data-state")).toBe("closed");
          expect(dialogBefore.isConnected).toBe(true);
        }
        if (start > 0) advance(start);
        const typedInto: string[] = [];
        field.addEventListener("input", () => typedInto.push((field as HTMLInputElement).value));
        await user.keyboard(`${KNOWN}${ending}`);
        await settle();
        await waitFor(() => expect(itemNames().filter((n) => n.includes("Cola"))).toHaveLength(1));
        expect(resolved).toEqual([KNOWN]); // one lookup, the whole code: no suffix lookup
        expect(itemNames().find((n) => n.includes("Cola"))).toContain("× 1");
        expect(scanBox().value).toBe("");
        // nothing a person would have typed is left in the dying field
        expect(
          typedInto.filter((v) => v !== "" && v !== (field as HTMLInputElement).defaultValue),
        ).toEqual([]);
        cleanup();
      });
    });
  });
});

/**
 * THE PIN: every till window that is a Radix Modal or the New product window is accounted for. A new one fails this until it
 * is added to CASES above or given a reason here.
 */
const NOT_IN_THE_SCAN_TEST: Record<string, string> = {
  "CounterDayClose.tsx":
    "opens inside Today's sales (its own API mocks); same Modal, same predicate",
  "CounterTodaysSales.tsx": "no text field of its own; its Close day dialog is the line above",
  "CounterVoidSaleDialog.tsx":
    "reason box on the receipt view: the receipt has no scan box, the redirect is off",
  "CounterReturnAction.tsx": "receipt view, as above",
  "ParkedSalesDialog.tsx": "a list and a Park prompt, no text field",
  "useNewCustomerDoor.tsx": "CustomerFormModal; same Modal, same predicate",
};
describe("the inventory covers every till window", () => {
  it("every file that renders a Modal or dialog is in CASES or has a stated reason", () => {
    const dir = __dirname;
    const files = fs
      .readdirSync(dir)
      .filter((n) => /^(Counter|Parked|useCounter|useNewCustomer).*.tsx$/.test(n))
      .filter((n) => !/.test.tsx$/.test(n));
    const withWindow = files.filter((n) =>
      /<(Modal|RecordInlineReturnDialog|ParkedSalesDialog|CustomerFormModal|InlineCreateProductModal)/.test(
        fs.readFileSync(path.join(dir, n), "utf8"),
      ),
    );
    const covered = new Set([
      "CounterDatePicker.tsx",
      "CounterLinePriceEdit.tsx",
      "CounterNewItem.tsx",
      ...Object.keys(NOT_IN_THE_SCAN_TEST),
    ]);
    expect(withWindow.filter((n) => !covered.has(n))).toEqual([]);
  });
});
