import * as React from "react";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";
import { LINE_UNDO_MS } from "./useCounterLineUndo";

/**
 * POS-3: per-line editing, the two-column layout, 44 px touch targets and the timed "Removed <name>. Undo" bar. The API is
 * mocked at the module boundary exactly as CounterSaleScreen.test.tsx does. RTL cannot measure pixels, so the layout and
 * size pins are CLASS pins (Playwright verifies the rendered 390 / lg layout).
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: jest.fn() }) }));

const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const WATER = { id: "p-water", name: "Water", pricePerUnit: 12, unit: "case", unitsPerBox: 12 };
const productFor: Record<string, unknown> = { COLA, WATER };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    productFor[code] ? { product: productFor[code], source: "sku" } : { notFound: true },
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
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
let gate: Record<string, unknown> = {};
const mutateAsync = jest.fn();
let pending = false;
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => gate,
  useCreateCounterSale: () => ({ mutateAsync, isPending: pending }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  pending = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.print = jest.fn();
  gate = {
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP", "PICKUP"], staffDefault: "PICKUP" },
  };
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
});
afterEach(() => jest.useRealTimers());

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};
const UNDO = /^Undo: put back /;
const TENDERS = /^(Cash|Card|Check|On account)$/;
const click = (name: string | RegExp) =>
  fireEvent.click(
    screen.getByRole(typeof name === "string" && TENDERS.test(name) ? "radio" : "button", { name }),
  );

/** Cola x2 (first line, plain) and Water 1 box + 3 pcs (second line, boxed). */
async function buildCart() {
  renderWithProviders(<CounterSaleScreen />);
  await scan("COLA");
  await scan("COLA");
  await scan("WATER");
  await waitFor(() => expect(screen.getByText(/Water/)).toBeInTheDocument());
  for (let i = 0; i < 3; i++) click("Add a piece to Water");
}
const itemNames = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");

describe("POS-3 control inventory (nothing removed or hidden)", () => {
  it("keeps every counter control: customer, scan, steppers, remove, payment, tender, auto-print, complete", async () => {
    await buildCart();
    for (const name of [
      "Ship this order instead",
      "Remove one Cola",
      "Add one Cola",
      "Remove Cola",
      "Remove a box from Water",
      "Add a box to Water",
      "Remove a piece from Water",
      "Add a piece to Water",
      "Remove Water",
      "Cash",
      "Card",
      "Check",
      "On account",
      "Exact",
      "$20",
      "$50",
      "$100",
      "Complete & show receipt",
      "Complete & next sale",
    ]) {
      expect(
        screen.getByRole(TENDERS.test(name) ? "radio" : "button", { name }),
      ).toBeInTheDocument();
    }
    for (const label of ["Find a customer", "Scan or search items", "Amount tendered"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Print receipt automatically")).toBeInTheDocument();
    expect(screen.getByTestId("running-total")).toBeInTheDocument();
    expect(screen.getByTestId("change-due")).toBeInTheDocument();
    click("Check");
    expect(screen.getByLabelText("Check number")).toBeInTheDocument();
  });
});

describe("POS-3 line edit", () => {
  it("editing a quantity updates the line and the running total", async () => {
    await buildCart();
    expect(screen.getByTestId("running-total")).toHaveTextContent("$20.00"); // 2 x 2.50 + (1 box + 3 pcs of a $12 box of 12)
    click("Add one Cola");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$22.50");
    click("Remove one Cola");
    click("Remove one Cola");
    expect(screen.getByTestId("running-total")).toHaveTextContent("$17.50");
  });
});

describe("POS-3 remove with Undo", () => {
  it("shows a 'Line removed. Undo' bar and drops the line from the cart and the total", async () => {
    await buildCart();
    click("Remove Cola");
    const bar = screen.getByRole("status", { name: "Removed item" });
    expect(bar).toHaveTextContent("Line removed.");
    expect(within(bar).getByRole("button", { name: UNDO })).toBeInTheDocument();
    expect(itemNames()).toHaveLength(1);
    expect(itemNames()[0]).toMatch(/Water/);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$15.00");
  });

  it("Undo restores the line exactly (qty, boxes/pieces, price) in its position", async () => {
    await buildCart();
    click("Remove Cola");
    click(UNDO);
    expect(screen.getByRole("status", { name: "Removed item" })).toBeEmptyDOMElement();
    const names = itemNames();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/Cola · × 2/);
    expect(names[1]).toMatch(/Water · 1 box \+ 3 pcs/);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$20.00");

    // a boxed line, removed from the END, comes back with its box/piece split intact
    click("Remove Water");
    click(UNDO);
    expect(itemNames()[1]).toMatch(/Water · 1 box \+ 3 pcs/);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$20.00");
  });

  // CQ-27: ten seconds at least, so a clerk who looks away to serve someone can still take the line back.
  it("the removal can still be taken back almost ten seconds later", async () => {
    expect(LINE_UNDO_MS).toBeGreaterThanOrEqual(10_000);
    await buildCart();
    jest.useFakeTimers();
    click("Remove Cola");
    act(() => {
      jest.advanceTimersByTime(9_900);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument();
    click(UNDO);
    expect(itemNames()).toHaveLength(2);
  });

  it("after the undo window the removal is final: the bar goes and Undo is gone", async () => {
    await buildCart();
    jest.useFakeTimers();
    click("Remove Cola");
    act(() => {
      jest.advanceTimersByTime(LINE_UNDO_MS - 100);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("button", { name: UNDO })).toBeNull();
    expect(screen.getByRole("status", { name: "Removed item" })).toBeEmptyDOMElement();
    expect(itemNames()).toHaveLength(1);
  });

  it("mouse-leave does NOT resume the countdown while focus is still inside the bar; it resumes when hover AND focus are gone", async () => {
    await buildCart();
    jest.useFakeTimers();
    click("Remove Cola");
    act(() => {
      jest.advanceTimersByTime(1); // let the scan-field refocus (0 ms) run BEFORE focus goes into the bar
    });
    const bar = screen.getByTestId("line-undo-bar");
    const undoBtn = screen.getByRole("button", { name: UNDO });
    fireEvent.mouseEnter(bar);
    act(() => undoBtn.focus());
    fireEvent.mouseLeave(bar); // the pointer is gone, the keyboard focus is not
    act(() => {
      jest.advanceTimersByTime(8000);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument();
    act(() => undoBtn.blur()); // now both are gone: the undo window runs again
    act(() => {
      jest.advanceTimersByTime(LINE_UNDO_MS - 100);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("button", { name: UNDO })).toBeNull();
  });

  it("a removal while the pointer is over the bar does not start the countdown, even after Undo ended the first one", async () => {
    await buildCart();
    jest.useFakeTimers();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    const bar = screen.getByTestId("line-undo-bar");
    fireEvent.mouseEnter(bar);
    click("Remove Cola");
    act(() => {
      jest.advanceTimersByTime(8000);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument(); // hovered: paused from the start
    click(UNDO); // ends this removal (the pointer is STILL over the bar)
    click("Remove Cola");
    act(() => {
      jest.advanceTimersByTime(8000);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument(); // still hovered: still paused
    fireEvent.mouseLeave(bar);
    act(() => {
      jest.advanceTimersByTime(LINE_UNDO_MS + 100);
    });
    expect(screen.queryByRole("button", { name: UNDO })).toBeNull();
  });

  it("blur does NOT resume while the pointer is still over the bar", async () => {
    await buildCart();
    jest.useFakeTimers();
    click("Remove Cola");
    act(() => {
      jest.advanceTimersByTime(1); // let the scan-field refocus (0 ms) run BEFORE focus goes into the bar
    });
    const bar = screen.getByTestId("line-undo-bar");
    const undoBtn = screen.getByRole("button", { name: UNDO });
    fireEvent.mouseEnter(bar);
    act(() => undoBtn.focus());
    act(() => undoBtn.blur());
    act(() => {
      jest.advanceTimersByTime(8000);
    });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument();
    fireEvent.mouseLeave(bar);
    act(() => {
      jest.advanceTimersByTime(LINE_UNDO_MS + 100);
    });
    expect(screen.queryByRole("button", { name: UNDO })).toBeNull();
  });

  it("Complete & show receipt during the undo window posts the cart WITHOUT the removed line", async () => {
    await buildCart();
    click("Remove Cola");
    click("Exact");
    click("Complete & show receipt");
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.items).toEqual([{ productId: "p-water", boxes: 1, pieces: 3, qty: 15 }]);
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: UNDO })).toBeNull();
  });

  it("a second removal makes the first final (one bar, for the latest line)", async () => {
    await buildCart();
    click("Remove Cola");
    click("Remove Water");
    expect(screen.getAllByRole("button", { name: UNDO })).toHaveLength(1); // ONE slot
    click(UNDO);
    expect(itemNames()).toHaveLength(1);
    expect(itemNames()[0]).toMatch(/Water/);
  });
});

describe("POS-3 layout and touch targets", () => {
  it("is two columns from md (cart left, sticky payment right) and one column below it, with no fixed width", async () => {
    await buildCart();
    const screenEl = screen.getByTestId("counter-sale-screen");
    expect(screenEl.className).toMatch(/\bmax-w-5xl\b/);
    expect(screenEl.className).not.toMatch(/overflow-x-(auto|scroll)/);
    const grid = screen.getByTestId("counter-sale-columns");
    expect(grid.className).toMatch(/\bmd:grid\b/);
    expect(grid.className).toMatch(/\bmd:grid-cols-\[minmax\(0,1fr\)_320px\]/); // 320 px right column from 768
    expect(grid.className).toMatch(/\bxl:grid-cols-\[minmax\(0,1fr\)_380px\]/); // 380 px at 1440
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-/); // one column below md
    expect(grid.className).toMatch(/\bflex-col\b/);
    const cart = screen.getByTestId("counter-cart-column");
    const pay = screen.getByTestId("counter-payment-column");
    expect(grid.firstElementChild).toBe(cart);
    expect(grid.lastElementChild).toBe(pay);
    expect(cart.className).toMatch(/\bmin-w-0\b/);
    expect(pay.className).toMatch(/\bmd:sticky\b/);
    expect(pay.className).toMatch(/\bcontents\b/); // below md its children flow in the one column
    expect(within(cart).getByRole("list", { name: "Items" })).toBeInTheDocument();
    expect(within(cart).getByLabelText("Scan or search items")).toBeInTheDocument();
    expect(within(pay).getByRole("radio", { name: "Cash" })).toBeInTheDocument();
    expect(
      within(pay).getByRole("button", { name: "Complete & show receipt" }),
    ).toBeInTheDocument();
    expect(within(pay).getByTestId("running-total")).toBeInTheDocument();
    expect(within(cart).queryByRole("radio", { name: "Cash" })).toBeNull();
  });

  it("below md the scan field and the checkout bar (total + both Complete buttons) are sticky", async () => {
    await buildCart();
    expect(screen.getByTestId("counter-scan-bar").className).toMatch(/\bsticky\b.*\btop-0\b/);
    const bar = screen.getByTestId("counter-checkout-bar");
    expect(bar.className).toMatch(/\bsticky\b.*\bbottom-0\b/);
    expect(bar.className).toMatch(/\bmd:static\b/);
    expect(bar.parentElement).toBe(screen.getByTestId("counter-payment-column"));
    expect(within(bar).getByTestId("running-total")).toBeInTheDocument();
    expect(
      within(bar).getByRole("button", { name: "Complete & show receipt" }),
    ).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Complete & next sale" })).toBeInTheDocument();
  });

  it("every counter button, input and the auto-print row is at least 44 px", async () => {
    await buildCart();
    click("Remove Cola"); // the Undo bar is a counter control too
    const root = screen.getByTestId("counter-sale-screen");
    const small: string[] = [];
    for (const b of within(root).getAllByRole("button")) {
      if (!/min-h-\[44px\]/.test(b.className)) small.push(`button:${b.textContent}`);
    }
    for (const i of within(root).getAllByRole("textbox")) {
      if (!/min-h-\[44px\]/.test(i.className)) small.push(`input:${i.getAttribute("aria-label")}`);
    }
    expect(small).toEqual([]);
    // compact controls (stepper, remove, Undo) are 44 wide as well, not just tall
    for (const name of ["Add a box to Water", "Remove Water", UNDO, "Cash", "Exact"]) {
      expect(
        screen.getByRole(TENDERS.test(String(name)) ? "radio" : "button", { name }).className,
      ).toMatch(/min-w-\[44px\]/);
    }
    const autoPrint = screen.getByLabelText("Print receipt automatically").closest("label")!;
    expect(autoPrint.className).toMatch(/min-h-\[44px\]/);
  });
});

describe("POS-3 line notes", () => {
  const noteBox = (name: string) => screen.getByLabelText(`Note for ${name}`);

  it("add, edit and clear a note; it goes out on the ring as items[].note", async () => {
    await buildCart();
    click("Add a note to Cola");
    fireEvent.change(noteBox("Cola"), { target: { value: "  no ice " } });
    expect(screen.getByRole("button", { name: "Edit the note on Cola" })).toBeInTheDocument();
    fireEvent.change(noteBox("Cola"), { target: { value: "extra cold" } }); // edit
    click("Edit the note on Cola"); // collapse: the note shows as text
    expect(screen.getByTestId("line-note")).toHaveTextContent("extra cold");
    click("Exact");
    click("Complete & show receipt");
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.items[0]).toEqual({ productId: "p-cola", qty: 2, note: "extra cold" });
    expect(dto.items[1]).not.toHaveProperty("note"); // a line with no note sends none
  });

  it("Clear note removes it from the line and from the wire", async () => {
    await buildCart();
    click("Add a note to Cola");
    fireEvent.change(noteBox("Cola"), { target: { value: "no ice" } });
    click("Clear the note on Cola");
    expect(screen.queryByTestId("line-note")).toBeNull();
    expect(screen.getByRole("button", { name: "Add a note to Cola" })).toBeInTheDocument();
    click("Exact");
    click("Complete & show receipt");
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.items[0]).not.toHaveProperty("note");
  });

  it("caps the note at 200 characters", async () => {
    await buildCart();
    click("Add a note to Cola");
    expect(noteBox("Cola")).toHaveAttribute("maxlength", "200");
  });

  it("a removed line's note comes back with Undo", async () => {
    await buildCart();
    click("Add a note to Cola");
    fireEvent.change(noteBox("Cola"), { target: { value: "no ice" } });
    click("Remove Cola");
    click(UNDO);
    expect(screen.getByTestId("line-note")).toHaveTextContent("no ice");
  });
});

describe("POS-3 undo: merge, keyboard, one slot", () => {
  it("re-scanning the same product meanwhile: Undo MERGES into that line", async () => {
    await buildCart();
    click("Remove Cola");
    await scan("COLA"); // a fresh Cola x1
    expect(itemNames().some((n) => /Cola · × 1/.test(n))).toBe(true);
    click(UNDO);
    const colas = itemNames().filter((n) => /Cola/.test(n));
    expect(colas).toHaveLength(1);
    expect(colas[0]).toMatch(/Cola · × 3/);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$22.50");
  });

  it("Ctrl+Z with an empty scan field undoes; with text in the field it does not", async () => {
    await buildCart();
    click("Remove Cola");
    const field = screen.getByLabelText("Scan or search items");
    fireEvent.change(field, { target: { value: "abc" } });
    fireEvent.keyDown(field, { key: "z", ctrlKey: true });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.keyDown(field, { key: "z", metaKey: true });
    expect(screen.queryByRole("button", { name: UNDO })).toBeNull();
    expect(itemNames()[0]).toMatch(/Cola · × 2/);
  });

  it("Undo is a real button in the tab order, right after the cart", async () => {
    await buildCart();
    click("Remove Cola");
    expect(screen.getByRole("button", { name: UNDO }).tabIndex).toBe(0);
    expect(screen.getByRole("list", { name: "Items" }).nextElementSibling).toBe(
      screen.getByTestId("line-undo-bar"),
    );
  });
});

describe("POS-3 lines are frozen while the sale POST is in flight", () => {
  it("disables steppers, remove, note and Undo (and shows them still) until the POST answers", async () => {
    await buildCart();
    click("Add a note to Cola");
    click("Remove Water"); // leaves an Undo showing
    for (const n of ["Remove one Cola", "Add one Cola", "Remove Cola", UNDO]) {
      expect(screen.getByRole("button", { name: n })).toBeEnabled();
    }
    pending = true;
    click("Card"); // any state change re-reads the in-flight flag
    for (const n of ["Remove one Cola", "Add one Cola", "Remove Cola", UNDO]) {
      expect(screen.getByRole("button", { name: n })).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: /note (to|on) Cola/ })).toBeDisabled();
    expect(screen.getByLabelText("Note for Cola")).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("Scan or search items"), { key: "z", ctrlKey: true });
    expect(screen.getByRole("button", { name: UNDO })).toBeInTheDocument(); // Ctrl+Z is frozen too
    pending = false;
    click("Cash");
    expect(screen.getByRole("button", { name: UNDO })).toBeEnabled();
  });
});
