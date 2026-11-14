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
const WATER = { id: "p-water", name: "Water", pricePerUnit: 1, unit: "each", unitsPerBox: null };
const PRODUCTS: Record<string, unknown> = { [KNOWN]: COLA, Ab12cd: COLA, Zz99yy: WATER };
const resolved: string[] = [];
// a held lookup: "Hold99x" answers (as an archived item: a message with no dialog) only when the test releases it
let mockReleaseHold: (() => void) | null = null;
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) => {
    resolved.push(code);
    if (code === "Hold99x") {
      await new Promise<void>((r) => {
        mockReleaseHold = r;
      });
      return {
        product: { id: "p-old", name: "Old stock", pricePerUnit: 1 },
        source: "sku",
        archived: true,
      };
    }
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
    offerShipInstead: mockOfferShip,
    capability: { counter: "always", methods: ["PICKUP"], staffDefault: "PICKUP" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: mockSalePending }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

let mockOfferShip = false;
let mockSalePending = false;
const get = apiClient.get as unknown as jest.Mock;
const CHIP_NAME = "Order date: today. Change";
const SPEEDS = ["S0", "S400", "LATE", "GAP65", "GAP2000"] as const;
type Speed = (typeof SPEEDS)[number];

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  resolved.length = 0;
  mockOfferShip = false;
  mockSalePending = false;
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
// the empty cart renders one "No items yet." row: it is not a line
const itemNames = () =>
  Array.from(document.querySelectorAll('ul[aria-label="Items"] > li'))
    .map((li) => li.textContent ?? "")
    .filter((t) => t !== "No items yet.");

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
      expect(itemNames()[0]).toContain("× 1");
      expect(itemNames()[0]).not.toContain("× 123"); // x1, never the Alt-code's x123
      cleanup();
    }
  });

  it("Alt-code then two Enters (CR+LF) at the grid and at Yesterday presses nothing and sets no day", async () => {
    const user = userAt(null);
    for (const label of ["grid", "Yesterday"]) {
      resolved.length = 0;
      const p = await openPicker(user);
      const target =
        label === "grid"
          ? within(p).getByRole("grid", { name: /^Calendar/ })
          : within(p).getByRole("button", { name: "Yesterday" });
      act(() => target.focus());
      await user.keyboard("{Alt>}123{/Alt}{Enter}{Enter}");
      expect(chip()).toHaveAttribute("data-direction", "TODAY");
      expect(resolved).toEqual([]);
      expect(screen.getByTestId("counter-date-picker")).toBeInTheDocument();
      cleanup();
    }
  });

  it("a stray Alt-code, then a click into the text box and fri, applies Friday on the till", async () => {
    const user = userAt(null);
    const p = await openPicker(user);
    act(() =>
      within(p)
        .getByRole("grid", { name: /^Calendar/ })
        .focus(),
    );
    await user.keyboard("{Alt>}1{/Alt}");
    await user.click(within(p).getByTestId("counter-date-input"));
    await user.keyboard("fri{Enter}");
    expect(chip()).toHaveAttribute("data-direction", "BACK");
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

/** a walk-in cart waits for its customer: the till's own refocus puts the cursor in "Find a customer" */
describe("T9 a code is never split: ship intent (refocus target = the customer search)", () => {
  beforeEach(() => {
    mockOfferShip = true;
  });
  const ONE = "Zz99yy";
  async function awaitCustomer(user: ReturnType<typeof userAt>) {
    renderTill(<CounterSaleScreen />);
    const box = scanBox();
    fireEvent.change(box, { target: { value: KNOWN } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(itemNames()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Ship this order instead" }));
    await settle();
    await screen.findByLabelText("Find a customer");
    const button = await screen.findByRole("button", { name: CHIP_NAME });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    return screen.findByTestId("counter-date-picker");
  }

  it("the state accepts a typed scan in the scan box (the picker case must end the same way)", async () => {
    const user = userAt(null);
    renderTill(<CounterSaleScreen />);
    fireEvent.change(scanBox(), { target: { value: KNOWN } });
    fireEvent.submit(scanBox().closest("form")!);
    await waitFor(() => expect(itemNames()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Ship this order instead" }));
    await settle();
    fireEvent.change(scanBox(), { target: { value: ONE } });
    fireEvent.submit(scanBox().closest("form")!);
    await waitFor(() => expect(itemNames()).toHaveLength(2));
  });

  it.each(SPEEDS)(
    "the whole code reaches the lookup, none in the customer search (%s)",
    async (speed) => {
      const user = userAt(null);
      const p = await awaitCustomer(user);
      act(() =>
        within(p)
          .getByRole("grid", { name: /^Calendar/ })
          .focus(),
      );
      await type(speed, ONE);
      await settle();
      await waitFor(() => expect(itemNames()).toHaveLength(2));
      expect(resolved).toEqual([KNOWN, ONE]);
      expect((screen.getByLabelText("Find a customer") as HTMLInputElement).value).toBe("");
      expect(chip()).toHaveAttribute("data-direction", "TODAY");
    },
  );
});

describe("T10 the append follows the scan box's own rules", () => {
  it("a key pressed while a sale is in flight is dropped: nothing piles up to prefix the next scan", async () => {
    const user = userAt(null);
    const view = renderTill(<CounterSaleScreen />);
    const button = await screen.findByRole("button", { name: CHIP_NAME });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const p = await screen.findByTestId("counter-date-picker");
    act(() =>
      within(p)
        .getByRole("grid", { name: /^Calendar/ })
        .focus(),
    );
    mockSalePending = true; // a sale goes out while the picker is still open
    view.rerender(<CounterSaleScreen />);
    await user.keyboard("4");
    await user.keyboard("00638{Enter}");
    await settle();
    expect(scanBox().value).toBe("");
    expect(resolved).toEqual([]);
  });
});

describe("T6b touch-first: a disarm outside the scan box (focus on BODY)", () => {
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
  it.each(["Escape", "Tab"])(
    "%s on BODY ends the hand-over: a later Enter submits nothing",
    async (key) => {
      const user = userAt(null);
      const p = await openPicker(user);
      act(() =>
        within(p)
          .getByRole("grid", { name: /^Calendar/ })
          .focus(),
      );
      await user.keyboard("4");
      await settle();
      expect(document.activeElement === document.body || document.activeElement === null).toBe(
        true,
      );
      await user.keyboard(`{${key}}`);
      await user.keyboard("{Enter}");
      expect(resolved).toEqual([]);
    },
  );
});

describe("T11 focus left on BODY while the picker is open (a month button at its limit)", () => {
  it.each(SPEEDS)("the scan is kept whole at the edge of the range (%s)", async (speed) => {
    const user = userAt(null);
    const picker = await openPicker(user);
    const next = within(picker).getByRole("button", { name: "Next month" });
    for (let i = 0; i < 20 && next.getAttribute("aria-disabled") !== "true"; i++) {
      await user.click(next);
    }
    expect(document.activeElement).toBe(next); // the limit keeps focus: nothing is thrown out to BODY
    act(() => (document.activeElement as HTMLElement).blur()); // and if something does leave focus behind
    expect(document.activeElement).toBe(document.body);
    resolved.length = 0;
    await type(speed, KNOWN);
    await settle();
    await waitFor(() => expect(itemNames()).toHaveLength(1));
    expect(chip()).toHaveAttribute("data-direction", "TODAY");
    expect(screen.queryByTestId("counter-date-picker")).toBeNull();
    expect(resolved).toEqual([KNOWN]);
  });
});

describe("T12 the armed append dismisses a stale scan message, like the scan box's own onChange", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q === TOUCH_FIRST_QUERY, // no standing focus in the scan box: the hand-over's keys go through state
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }),
    });
  });
  it("a message that arrives while the hand-over is armed goes at the NEXT appended key (not only at the first)", async () => {
    const user = userAt(null);
    renderTill(<CounterSaleScreen />);
    await waitFor(() => expect(screen.getByRole("button", { name: CHIP_NAME })).toBeEnabled());
    await user.click(scanBox());
    await user.keyboard("Hold99x{Enter}"); // the lookup is held
    await user.click(screen.getByRole("button", { name: CHIP_NAME }));
    const p = await screen.findByTestId("counter-date-picker");
    act(() =>
      within(p)
        .getByRole("grid", { name: /^Calendar/ })
        .focus(),
    );
    await user.keyboard("4"); // the first key: the picker closes, the hand-over is armed, no message yet
    await settle();
    expect(screen.queryByText(/is archived/)).toBeNull();
    await act(async () => {
      mockReleaseHold?.(); // the held lookup answers now: a message appears mid-scan
    });
    expect(await screen.findByText(/Old stock is archived/)).toBeInTheDocument();
    await user.keyboard("0"); // the second key is an armed append: it must dismiss the message
    await settle();
    expect(screen.queryByText(/is archived/)).toBeNull();
  });
});
