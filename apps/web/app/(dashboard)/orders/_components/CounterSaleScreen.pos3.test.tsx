import * as React from "react";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * POS-3: per-line editing, the two-column layout, 44 px touch targets and the 5 s "Removed <name>. Undo" bar. The API is
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
jest.mock("@/lib/api/customers", () => ({ useCustomers: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
let gate: Record<string, unknown> = {};
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => gate,
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
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
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

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
      "Complete sale",
      "Complete & next sale",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
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
  it("shows a 'Removed <name>. Undo' bar and drops the line from the cart and the total", async () => {
    await buildCart();
    click("Remove Cola");
    const bar = screen.getByRole("status", { name: "Removed item" });
    expect(bar).toHaveTextContent("Removed Cola.");
    expect(within(bar).getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(itemNames()).toHaveLength(1);
    expect(itemNames()[0]).toMatch(/Water/);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$15.00");
  });

  it("Undo restores the line exactly (qty, boxes/pieces, price) in its position", async () => {
    await buildCart();
    click("Remove Cola");
    click("Undo");
    expect(screen.queryByRole("status", { name: "Removed item" })).toBeNull();
    const names = itemNames();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/Cola · × 2/);
    expect(names[1]).toMatch(/Water · 1 box \+ 3 pcs/);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$20.00");

    // a boxed line, removed from the END, comes back with its box/piece split intact
    click("Remove Water");
    click("Undo");
    expect(itemNames()[1]).toMatch(/Water · 1 box \+ 3 pcs/);
    expect(screen.getByTestId("running-total")).toHaveTextContent("$20.00");
  });

  it("after 5 s the removal is final: the bar goes and Undo is gone", async () => {
    await buildCart();
    jest.useFakeTimers();
    click("Remove Cola");
    act(() => {
      jest.advanceTimersByTime(4900);
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("status", { name: "Removed item" })).toBeNull();
    expect(itemNames()).toHaveLength(1);
  });

  it("Complete sale during the undo window posts the cart WITHOUT the removed line", async () => {
    await buildCart();
    click("Remove Cola");
    click("Exact");
    click("Complete sale");
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { dto } = mutateAsync.mock.calls[0][0];
    expect(dto.items).toEqual([{ productId: "p-water", boxes: 1, pieces: 3, qty: 15 }]);
    await waitFor(() => expect(screen.getByTestId("counter-sale-receipt")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a second removal makes the first final (one bar, for the latest line)", async () => {
    await buildCart();
    click("Remove Cola");
    click("Remove Water");
    expect(screen.getByRole("status", { name: "Removed item" })).toHaveTextContent(
      "Removed Water.",
    );
    click("Undo");
    expect(itemNames()).toHaveLength(1);
    expect(itemNames()[0]).toMatch(/Water/);
  });
});

describe("POS-3 layout and touch targets", () => {
  it("is two columns at lg (cart left, payment right) and stacked below it, with no fixed width", async () => {
    await buildCart();
    const screenEl = screen.getByTestId("counter-sale-screen");
    expect(screenEl.className).toMatch(/\bmax-w-5xl\b/);
    expect(screenEl.className).not.toMatch(/overflow-x-(auto|scroll)/);
    const grid = screen.getByTestId("counter-sale-columns");
    expect(grid.className).toMatch(/\blg:grid-cols-2\b/);
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-2\b/); // stacked below lg
    const cart = screen.getByTestId("counter-cart-column");
    const pay = screen.getByTestId("counter-payment-column");
    expect(grid.firstElementChild).toBe(cart);
    expect(grid.lastElementChild).toBe(pay);
    expect(cart.className).toMatch(/\bmin-w-0\b/);
    expect(pay.className).toMatch(/\bmin-w-0\b/);
    expect(within(cart).getByRole("list", { name: "Items" })).toBeInTheDocument();
    expect(within(cart).getByLabelText("Scan or search items")).toBeInTheDocument();
    expect(within(pay).getByRole("button", { name: "Cash" })).toBeInTheDocument();
    expect(within(pay).getByRole("button", { name: "Complete sale" })).toBeInTheDocument();
    expect(within(cart).queryByRole("button", { name: "Cash" })).toBeNull();
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
    for (const name of ["Add a box to Water", "Remove Water", "Undo"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/min-w-\[44px\]/);
    }
    const autoPrint = screen.getByLabelText("Print receipt automatically").closest("label")!;
    expect(autoPrint.className).toMatch(/min-h-\[44px\]/);
  });
});
