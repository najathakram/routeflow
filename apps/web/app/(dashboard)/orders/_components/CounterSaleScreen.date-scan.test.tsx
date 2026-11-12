import * as React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import { TOUCH_FIRST_QUERY } from "@/lib/touch-first";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-1188 round 4: a scan while the order date picker is open, on the real till. NO timing anywhere in the feature, so
 * none in these tests: no real sleeps, no thresholds. Each scan case runs at S0 (no timer between keys), S400 (timers
 * fire between keys), LATE (a long wait before the Enter) and GAP (a pause mid-code, 65 ms and 2000 ms), and the expected
 * result is identical at every speed. Focus positions are read from the DOM, so a control added later is covered.
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
const PRODUCTS: Record<string, unknown> = { [KNOWN]: COLA, Ab12cd: COLA };
const resolved: string[] = [];
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) => {
    resolved.push(code);
    return PRODUCTS[code] ? { product: PRODUCTS[code], source: "sku" } : { notFound: true };
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
const CHIP_NAME = "Order date: today. Change";
const SPEEDS = ["S0", "S400", "LATE", "GAP65", "GAP2000"] as const;
type Speed = (typeof SPEEDS)[number];

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  resolved.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  get.mockImplementation((url: string) => {
    if (url === "/settings")
      return Promise.resolve({ data: { taxRate: 0, timezone: "America/New_York" } });
    if (url === "/orders/counter-sale/parked")
      return Promise.resolve({ data: { data: [], total: 0, page: 1, pageSize: 20 } });
    if (url === "/drafts") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
});
afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  delete (window as unknown as Record<string, unknown>).matchMedia;
});

const advance = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });
const userAt = (delay: number | null) =>
  userEvent.setup({ delay, advanceTimers: jest.advanceTimersByTime });
const scanBox = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const chip = () => screen.getByTestId("counter-date-chip");
const itemNames = () =>
  Array.from(document.querySelectorAll('ul[aria-label="Items"] > li')).map(
    (li) => li.textContent ?? "",
  );

/** every focus position in the picker, from the DOM: the grid plus each enabled button outside the grid */
const positions = (picker: HTMLElement): HTMLElement[] => {
  const dialog = picker.closest('[role="dialog"]') as HTMLElement;
  const grid = within(picker).getByRole("grid", { name: /^Calendar/ });
  return [
    grid,
    ...Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])")).filter(
      (b) => !grid.contains(b),
    ),
  ];
};
const labelOf = (el: HTMLElement) => el.getAttribute("aria-label") || el.textContent || "grid";

async function openPicker(user: ReturnType<typeof userAt>) {
  renderTill(<CounterSaleScreen />);
  const button = await screen.findByRole("button", { name: CHIP_NAME });
  await waitFor(() => expect(button).toBeEnabled()); // the business's day has loaded
  await user.click(button);
  return screen.findByTestId("counter-date-picker");
}
/** types `code` then Enter the way each speed does it; the keys go to whatever holds focus */
async function type(speed: Speed, code: string, enter = true) {
  const user = userAt(speed === "S400" ? 400 : null);
  const tail = enter ? "{Enter}" : "";
  if (speed === "LATE") {
    await user.keyboard(code);
    advance(1000);
    if (enter) await user.keyboard("{Enter}");
  } else if (speed === "GAP65" || speed === "GAP2000") {
    await user.keyboard(code.slice(0, 6));
    advance(speed === "GAP65" ? 65 : 2000);
    await user.keyboard(code.slice(6) + tail);
  } else await user.keyboard(code + tail);
}
const settle = async () => {
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
};

describe("T1 a scan at every focus position adds the item and picks no date", () => {
  it.each(SPEEDS)("digits at every position (%s)", async (speed) => {
    const user = userAt(null);
    const picker = await openPicker(user);
    const labels = positions(picker).map(labelOf);
    expect(labels.length).toBeGreaterThanOrEqual(8);
    cleanup();
    for (let i = 0; i < labels.length; i++) {
      resolved.length = 0;
      const p = await openPicker(user);
      act(() => positions(p)[i].focus());
      await type(speed, KNOWN);
      await settle();
      await waitFor(() => expect(itemNames()).toHaveLength(1));
      expect(chip()).toHaveAttribute("data-direction", "TODAY");
      expect(screen.queryByTestId("counter-date-picker")).toBeNull();
      expect(resolved).toEqual([KNOWN]); // the lookup was made once, with the whole code
      expect(scanBox().value).toBe("");
      expect(document.activeElement).toBe(scanBox());
      cleanup();
    }
  });
});

describe("T2 letters reach the lookup whole, capitals and lowercase", () => {
  it.each(SPEEDS)("a mixed-case code at the grid and at Yesterday (%s)", async (speed) => {
    const user = userAt(null);
    for (const label of ["grid", "Yesterday"]) {
      resolved.length = 0;
      const p = await openPicker(user);
      const target =
        label === "grid"
          ? within(p).getByRole("grid", { name: /^Calendar/ })
          : within(p).getByRole("button", { name: "Yesterday" });
      act(() => target.focus());
      await type(speed, "Ab12cd");
      await settle();
      await waitFor(() => expect(itemNames()).toHaveLength(1));
      expect(resolved).toEqual(["Ab12cd"]);
      expect(chip()).toHaveAttribute("data-direction", "TODAY");
      cleanup();
    }
  });
});

describe("T3 an unknown code takes the unknown-scan path", () => {
  it.each(SPEEDS)("New product opens with the code filled in (%s)", async (speed) => {
    const user = userAt(null);
    const p = await openPicker(user);
    act(() =>
      within(p)
        .getByRole("grid", { name: /^Calendar/ })
        .focus(),
    );
    await type(speed, "9999999999994");
    await settle();
    await screen.findByRole("heading", { name: "New product" });
    expect((screen.getByPlaceholderText("Scan or type") as HTMLInputElement).value).toBe(
      "9999999999994",
    );
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
  });
});

describe("T4 the date text box", () => {
  it.each(SPEEDS)("a scan of 13 digits or COLA123 never becomes a date (%s)", async (speed) => {
    const user = userAt(null);
    for (const code of [KNOWN, "COLA123"]) {
      resolved.length = 0;
      const p = await openPicker(user);
      act(() => within(p).getByTestId("counter-date-input").focus());
      await type(speed, code);
      await settle();
      expect(chip()).toHaveAttribute("data-direction", "TODAY");
      expect(screen.queryByTestId("counter-date-picker")).toBeNull();
      expect(resolved).toEqual([code]);
      cleanup();
    }
  });
});

describe("T5 an Alt-coded scan is never kept (stated limit)", () => {
  it("Alt+1,2,3 then Enter at the grid and at Yesterday: nothing pressed, no lookup, the note shows, the next scan is x1", async () => {
    const user = userAt(null);
    for (const label of ["grid", "Yesterday"]) {
      resolved.length = 0;
      const p = await openPicker(user);
      const target =
        label === "grid"
          ? within(p).getByRole("grid", { name: /^Calendar/ })
          : within(p).getByRole("button", { name: "Yesterday" });
      act(() => target.focus());
      await user.keyboard("{Alt>}123{/Alt}{Enter}");
      expect(resolved).toEqual([]);
      expect(chip()).toHaveAttribute("data-direction", "TODAY");
      expect(screen.getByTestId("counter-date-scan-note")).toBeInTheDocument();
      expect(screen.getByTestId("counter-date-picker")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      await settle();
      expect(screen.queryByTestId("counter-date-picker")).toBeNull();
      fireEvent.change(scanBox(), { target: { value: KNOWN } });
      fireEvent.submit(scanBox().closest("form")!);
      await waitFor(() => expect(itemNames()).toHaveLength(1));
      expect(resolved).toEqual([KNOWN]);
      cleanup();
    }
  });
});

describe("T6 the hand-over ends when the clerk does something else", () => {
  it.each(["Escape", "Tab", "pointer"])(
    "after the first key, %s ends it: a later Enter on a button presses that button",
    async (how) => {
      const user = userAt(null);
      const p = await openPicker(user);
      act(() =>
        within(p)
          .getByRole("grid", { name: /^Calendar/ })
          .focus(),
      );
      await user.keyboard("4"); // the picker closes, the till holds the hand-over
      await settle();
      if (how === "pointer") fireEvent.pointerDown(document.body);
      else await user.keyboard(`{${how}}`);
      act(() => screen.getByRole("button", { name: CHIP_NAME }).focus());
      await user.keyboard("{Enter}");
      expect(await screen.findByTestId("counter-date-picker")).toBeInTheDocument();
      expect(resolved).toEqual([]);
    },
  );
});

describe("T7 a touch-first till: no focus in the scan box, the whole code still arrives", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q === TOUCH_FIRST_QUERY,
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }),
    });
  });
  it.each(["S0", "S400"] as const)("the code goes through state (%s)", async (speed) => {
    const user = userAt(null);
    const p = await openPicker(user);
    act(() =>
      within(p)
        .getByRole("grid", { name: /^Calendar/ })
        .focus(),
    );
    await type(speed, KNOWN);
    await settle();
    await waitFor(() => expect(itemNames()).toHaveLength(1));
    expect(resolved).toEqual([KNOWN]);
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
  });
});

describe("T8 focus never goes back to the chip after a hand-over", () => {
  it.each(SPEEDS)("(%s)", async (speed) => {
    const user = userAt(null);
    const p = await openPicker(user);
    act(() => within(p).getByRole("button", { name: "Yesterday" }).focus());
    await type(speed, KNOWN);
    await settle();
    await waitFor(() => expect(itemNames()).toHaveLength(1));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: CHIP_NAME }));
    expect(document.activeElement).toBe(scanBox());
    expect(screen.queryByTestId("counter-date-picker")).toBeNull();
  });
});
