import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderTill } from "@/test-utils/render-till";
import { fireEvent, screen, waitFor, within } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";
import { QTY_TOO_LARGE_COPY } from "./counter-qty-refusal";

/**
 * SA-1262 PR A / W-1336: the counter holds a qty box's text until Enter, Tab or blur and commits it once (a scan into a
 * focused box used to commit each digit prefix). Pins C9, C10 (jsdom half), C11, C13, C14, C15, C16, C17, C18.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const WATER = { id: "p-water", name: "Water", pricePerUnit: 12, unit: "case", unitsPerBox: 24 };
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
// every typed quantity goes through setLineQty: record what it was asked to apply
const asked: Array<Record<string, string | undefined>> = [];
jest.mock("./counter-sale-line-edit", () => {
  const actual = jest.requireActual("./counter-sale-line-edit");
  return {
    ...actual,
    setLineQty: (l: unknown, typed: Record<string, string | undefined>) => {
      asked.push(typed);
      return actual.setLineQty(l, typed);
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  asked.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
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

const scanField = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const scan = async (text: string) => {
  fireEvent.change(scanField(), { target: { value: text } });
  fireEvent.submit(scanField().closest("form")!);
  await waitFor(() => expect(scanField().value).toBe(""));
};
const qty = () => screen.getByLabelText("Set quantity of Cola") as HTMLInputElement;
const lineOf = (name: string) =>
  within(screen.getByRole("list", { name: "Items" }))
    .getAllByRole("listitem")
    .find((li) => li.textContent?.includes(name))!;
const boxes = () => within(lineOf("Water")).getByTitle(/^Number of whole /) as HTMLInputElement;
const pieces = () =>
  within(lineOf("Water")).getByRole("spinbutton", { name: /^Extra / }) as HTMLInputElement;
const typeIn = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } });

async function colaTill() {
  renderTill(<CounterSaleScreen />);
  await scan("COLA");
  await screen.findByLabelText("Set quantity of Cola");
}
async function waterTill() {
  renderTill(<CounterSaleScreen />);
  await scan("WATER");
  await screen.findByRole("list", { name: "Items" });
  fireEvent.click(within(lineOf("Water")).getByRole("button", { name: /^\+ .*: add extra / }));
}

describe("the counter holds qty-box text until Enter, Tab or blur (SA-1262 PR A)", () => {
  it("C9: typed digits are held, no commit before Enter", async () => {
    await colaTill();
    qty().focus();
    typeIn(qty(), "1");
    typeIn(qty(), "12");
    expect(asked).toEqual([]);
    expect(qty().value).toBe("12");
    fireEvent.keyDown(qty(), { key: "Enter" });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((t) => t.qty === "12")).toBe(true);
  });

  it("C14: type 5, no Enter, click Exact then Complete: the sale carries 5", async () => {
    await colaTill();
    const user = userEvent.setup();
    await user.click(qty());
    typeIn(qty(), "5");
    await user.click(screen.getByRole("button", { name: "Exact" }));
    await user.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].dto.items[0]).toEqual({ productId: "p-cola", qty: 5 });
  });

  it("C15: pieces 30 at 24 a box, Enter then blur: committed once, 2 boxes 6 pieces", async () => {
    await waterTill();
    pieces().focus();
    typeIn(pieces(), "3");
    typeIn(pieces(), "30");
    fireEvent.keyDown(pieces(), { key: "Enter" });
    fireEvent.blur(pieces());
    // typeQty reads the line once to check and once to apply: that pair is ONE commit
    expect(asked.map((t) => t.pieces)).toEqual(["30", "30"]);
    expect([boxes().value, pieces().value]).toEqual(["2", "6"]);
  });

  it("C16: Ctrl+Enter with held 7 commits once and starts no payment", async () => {
    await colaTill();
    qty().focus();
    typeIn(qty(), "7");
    fireEvent.keyDown(qty(), { key: "Enter", ctrlKey: true });
    fireEvent.blur(qty());
    expect(asked.map((t) => t.qty)).toEqual(["7", "7"]);
    expect(qty().value).toBe("7");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("C17: Enter after a plain number returns focus to the scan box", async () => {
    await colaTill();
    qty().focus();
    typeIn(qty(), "4");
    fireEvent.keyDown(qty(), { key: "Enter" });
    await waitFor(() => expect(scanField()).toHaveFocus());
    expect(qty().value).toBe("4");
  });

  it("C17: a plain Tab moves on; Tab out of the last typed field returns to the scan box", async () => {
    await waterTill();
    boxes().focus();
    typeIn(boxes(), "3");
    fireEvent.keyDown(boxes(), { key: "Tab" }); // not the last field
    expect(scanField()).not.toHaveFocus();
    pieces().focus();
    typeIn(pieces(), "2");
    fireEvent.keyDown(pieces(), { key: "Tab" });
    await waitFor(() => expect(scanField()).toHaveFocus());
  });

  it("C18: Esc after typing 40 puts back the focus-time value and calls nothing", async () => {
    await colaTill();
    qty().focus();
    typeIn(qty(), "40");
    fireEvent.keyDown(qty(), { key: "Escape" });
    fireEvent.blur(qty());
    expect(qty().value).toBe("1");
    expect(asked).toEqual([]);
  });

  it("C13: held text is dropped when the line changes under it, and the blur commits nothing", async () => {
    await colaTill();
    qty().focus();
    typeIn(qty(), "9");
    fireEvent.click(screen.getByRole("button", { name: "Add one Cola" })); // the line becomes 2
    await waitFor(() => expect(qty().value).toBe("2"));
    fireEvent.blur(qty());
    expect(asked.some((t) => t.qty === "9")).toBe(false);
    expect(qty().value).toBe("2");
  });

  it("C11: every counter qty box carries data-qty-box (plain, boxes, pieces)", async () => {
    await colaTill();
    expect(qty()).toHaveAttribute("data-qty-box");
  });

  it("C11: the boxed boxes and pieces fields carry data-qty-box", async () => {
    await waterTill();
    expect(boxes()).toHaveAttribute("data-qty-box");
    expect(pieces()).toHaveAttribute("data-qty-box");
  });

  it("C11: the unit-mode box carries data-qty-box; unparseable text is refused, never sent as 0", async () => {
    await waterTill();
    fireEvent.click(lineOf("Water").querySelector("button.border-l")!); // the Unit side of the Case | Unit toggle
    const unitBox = within(lineOf("Water")).getByTitle(/^Total /) as HTMLInputElement;
    expect(unitBox).toHaveAttribute("data-qty-box");
    unitBox.focus();
    typeIn(unitBox, "");
    fireEvent.blur(unitBox);
    expect(asked).toEqual([]);
  });

  it("G7: a visible note says press Enter while text is held, gone after Enter or Esc", async () => {
    await colaTill();
    expect(screen.queryByText("press Enter")).toBeNull();
    qty().focus();
    typeIn(qty(), "12");
    expect(screen.getByText("press Enter")).toBeInTheDocument();
    fireEvent.keyDown(qty(), { key: "Enter" });
    expect(screen.queryByText("press Enter")).toBeNull();
    typeIn(qty(), "13");
    expect(screen.getByText("press Enter")).toBeInTheDocument();
    fireEvent.keyDown(qty(), { key: "Escape" });
    expect(screen.queryByText("press Enter")).toBeNull();
  });

  it("C10 (jsdom half): a scanned 12-digit code in a qty box is refused whole at Enter", async () => {
    await colaTill();
    qty().focus();
    typeIn(qty(), "012345678905");
    expect(asked).toEqual([]);
    fireEvent.keyDown(qty(), { key: "Enter" });
    expect(await screen.findByText(QTY_TOO_LARGE_COPY)).toBeInTheDocument();
    expect(qty().value).toBe("1");
  });
});
