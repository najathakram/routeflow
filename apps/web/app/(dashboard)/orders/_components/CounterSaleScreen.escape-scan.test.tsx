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
const mockCreate = jest.fn();
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
  useCreateCounterSale: () => ({ mutateAsync: mockCreate, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const get = apiClient.get as unknown as jest.Mock;
const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "n:0",
          productId: "p-water",
          displayName: "Water",
          outcome: "BLOCK",
          rules: [{ id: "r1", states: ["CA"], legal: true, reasonText: "Restricted in CA." }],
        },
      ],
    },
  },
};
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
      return Promise.resolve({
        data: {
          taxRate: 0,
          timezone: "America/New_York",
          quickKeys: { counter: { default: { pinned: [], hidden: [] }, windowDays: 14, cap: 12 } },
        },
      });
    if (url === "/orders/counter-sale/quick-keys") return Promise.resolve({ data: { keys: [] } });
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
    name: "Quick keys: find a product to pin (search box)",
    exitWindow: false,
    open: async () => {
      const user = userEvent.setup({ delay: null, advanceTimers: jest.advanceTimersByTime });
      await user.click(await screen.findByRole("button", { name: "Edit keys" }));
      await settle();
      const field = await screen.findByLabelText("Find a product to pin");
      await user.click(field); // nothing autofocuses it: a clerk clicks into it
      return field;
    },
  },
  {
    name: "Restricted items warning (reason box)",
    exitWindow: true,
    open: async () => {
      const user = userEvent.setup({ delay: null, advanceTimers: jest.advanceTimersByTime });
      await user.click(scanBox());
      await user.keyboard("Zz99yy{Enter}"); // Water, the restricted line
      await settle();
      mockCreate.mockRejectedValueOnce(warning409);
      await user.click(await screen.findByRole("button", { name: "$20" }));
      await user.click(screen.getByRole("button", { name: "Complete & show receipt" }));
      const reason = await screen.findByLabelText(/reason/i);
      await settle();
      resolved.length = 0;
      return reason;
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
 * THE PIN: every file that renders a Modal or a *Dialog / *Modal component is accounted for: its cells are in CASES above, or
 * it has a stated reason (read from the code) why a text field cannot hold focus while its window closes on the till view.
 * A new window file fails this until it is added to one or the other.
 */
const NOT_IN_THE_SCAN_TEST: Record<string, string> = {
  "CounterDayClose.tsx":
    "opens inside Today's sales (its own API mocks); same Modal, same predicate",
  "CounterTodaysSales.tsx": "no text field of its own; its Close day dialog is the line above",
  "CounterVoidSaleDialog.tsx":
    "reason box on the receipt view: the receipt has no scan box, the redirect is off",
  "CounterReturnAction.tsx": "receipt view, as above",
  "CounterReceiptActions.tsx": "receipt view, as above",
  "ParkedSales.tsx":
    "mounts ParkedSalesDialog and the Park prompt: lists and buttons, no text field",
  "ParkedSalesDialog.tsx": "a list and a Park prompt, no text field",
  "useNewCustomerDoor.tsx": "CustomerFormModal; same Modal, same predicate",
  "QuickKeysGrid.tsx": "only mounts QuickKeysEditModal (a CASES row below)",
  "ZReportView.tsx": "inside Close day, a read-only report",
  "BatchShipActions.tsx": "the orders list, not the till",
  "CreateOrderModal.tsx": "the office order builder (its own scan rules), not the till",
  "DraftConflictDialog.tsx": "office order builder only (imported by CreateOrderModal)",
  "ResumeUnsentOrderDialog.tsx": "office order builder only (imported by CreateOrderModal)",
  "LicenseGuardModal.tsx": "office order builder and the order page, not the till",
  "SplitInvoiceModal.tsx": "invoice and order pages, not the till",
};
// covered by a CASES row: CounterDatePicker, CounterLinePriceEdit, CounterNewItem, QuickKeysEditModal, RestrictionWarningDialog
const IN_CASES = [
  "CounterDatePicker.tsx",
  "CounterLinePriceEdit.tsx",
  "CounterNewItem.tsx",
  "QuickKeysEditModal.tsx",
  "RestrictionWarningDialog.tsx",
];
// a window component that is not a file in this folder is read from where it lives
const EXTRA_FILES = [path.join(__dirname, "../../../../components/RestrictionWarningDialog.tsx")];
const WINDOW = /<\w*(Modal|Dialog)\b/;

describe("the inventory covers every till window", () => {
  const listed = () => {
    const dir = __dirname;
    const files = fs
      .readdirSync(dir)
      .filter((n) => /\.tsx$/.test(n) && !/\.test\.tsx$/.test(n))
      .map((n) => path.join(dir, n));
    return [...files, ...EXTRA_FILES]
      .filter((p) => WINDOW.test(fs.readFileSync(p, "utf8")))
      .map((p) => path.basename(p));
  };
  it("the word boundary is a real one (no control byte in the pattern)", () => {
    expect(WINDOW.source).toBe(String.raw`<\w*(Modal|Dialog)\b`);
    expect(WINDOW.test("<Modal open>")).toBe(true);
    expect(WINDOW.test("<ModalFooter>")).toBe(false);
  });
  it("every file that renders a Modal or dialog is in CASES or has a stated reason", () => {
    const accounted = new Set([...IN_CASES, ...Object.keys(NOT_IN_THE_SCAN_TEST)]);
    const found = listed();
    expect(found.length).toBeGreaterThanOrEqual(IN_CASES.length);
    expect(found.filter((n) => !accounted.has(n))).toEqual([]);
  });
  it("every file named in the pin still renders a window (a stale entry is removed)", () => {
    const found = new Set(listed());
    expect(
      [...IN_CASES, ...Object.keys(NOT_IN_THE_SCAN_TEST)].filter((n) => !found.has(n)),
    ).toEqual([]);
  });
});
