import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import { InlineReturnSection, type InlineReturnSectionState } from "./InlineReturnSection";
import {
  ALREADY_RETURNED_NOTHING_LEFT_MESSAGE,
  buildCaptureRequest,
  NOTHING_BOUGHT_BEFORE_MESSAGE,
} from "@routeflow/returns";
import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";

/**
 * R-1 (SA-1069 section A): one-step return capture. The section is ONE render: add, enter a quantity, and the credit is
 * worked out live under the list. There is no "Get quote" and no "Back". Each row of the SA-1069 table is named in its
 * test. The quote API is mocked at the hook boundary, as in InlineReturnSection.test.tsx; time is faked so the
 * 350 ms debounce is exact.
 */
const DEBOUNCE = 350; // RETURN_QUOTE_DEBOUNCE_MS in SA-1069 M3

let mockEntryOrder: unknown;
jest.mock("@/lib/api/orders", () => ({
  useOrder: (id: string) => ({ data: id ? mockEntryOrder : undefined }),
}));

const WIDGET = { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null };
const GADGET = { id: "prod-2", name: "Gadget", unit: "each", unitsPerBox: null };
let productResults: (typeof WIDGET)[] = [];
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: productResults } }),
}));

const quoteMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
}));

// the section's scan handler deps are captured (and the real hook still runs), so a scan can be fired without a camera
let mockScanDeps: { addLineItem: (product: unknown) => unknown } | undefined;
jest.mock("@/app/(dashboard)/orders/_components/scan/useScanCodeHandler", () => {
  const actual = jest.requireActual("@/app/(dashboard)/orders/_components/scan/useScanCodeHandler");
  return {
    ...actual,
    useScanCodeHandler: (deps: { addLineItem: (product: unknown) => unknown }) => {
      mockScanDeps = deps;
      return actual.useScanCodeHandler(deps);
    },
  };
});

let authRole: string | undefined;
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => (authRole ? { user: { role: authRole } } : null),
}));

function chunk(overrides: Partial<InlineReturnQuoteChunk> = {}): InlineReturnQuoteChunk {
  return {
    sourceOrderId: "order-newest",
    sourceInvoiceItemId: "inv-item-1",
    sourceOrderItemId: "order-item-1",
    productId: "prod-1",
    pieces: 10,
    subtotal: 20,
    taxAmount: 2,
    categoryTax: 0,
    priceSource: "SOURCE_INVOICE",
    unitPrice: 2,
    ...overrides,
  };
}
const noSale = (overrides: Partial<InlineReturnQuoteChunk> = {}) =>
  chunk({ sourceOrderId: null, sourceInvoiceItemId: null, sourceOrderItemId: null, ...overrides });

function quoteResponse(chunks: InlineReturnQuoteChunk[]): InlineReturnQuoteResponse {
  return {
    chunks,
    subtotal: chunks.reduce((s, c) => s + c.subtotal, 0),
    taxAmount: chunks.reduce((s, c) => s + c.taxAmount, 0),
    categoryTax: chunks.reduce((s, c) => s + c.categoryTax, 0),
    total: chunks.reduce((s, c) => s + c.subtotal + c.taxAmount + c.categoryTax, 0),
    productBreakdown: {},
    canRefund: false,
    paidInFull: false,
    paidMethods: [],
    paidWithStoreCredit: false,
    customerIsWalkIn: false,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  productResults = [WIDGET, GADGET];
  authRole = undefined;
  mockEntryOrder = undefined;
});
afterEach(() => {
  jest.useRealTimers();
});

function renderSection(props: Partial<React.ComponentProps<typeof InlineReturnSection>> = {}) {
  const states: InlineReturnSectionState[] = [];
  const view = renderWithProviders(
    <InlineReturnSection customerId="cust-1" onStateChange={(s) => states.push(s)} {...props} />,
  );
  return { states, last: () => states[states.length - 1], ...view };
}

/** Search for a product and pick it from the list. */
async function pick(name = "Widget", term = name.slice(0, 3).toLowerCase()) {
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: term } });
  fireEvent.click(await screen.findByRole("button", { name }));
}
const qtyInputs = () => screen.getAllByLabelText(/^pieces$/i) as HTMLInputElement[];
function setQty(value: string, index = 0) {
  fireEvent.change(qtyInputs()[index], { target: { value } });
}
function wait(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}
const quoteCall = (n = quoteMutate.mock.calls.length - 1) => quoteMutate.mock.calls[n];
function answer(data: InlineReturnQuoteResponse, n?: number) {
  act(() => quoteCall(n)[1].onSuccess(data));
}
function refuse(error: unknown, n?: number) {
  act(() => quoteCall(n)[1].onError(error));
}
const row = (productId: string) => screen.getByTestId(`return-line-${productId}`);
const summary = (productId: string) => screen.getByTestId(`return-line-summary-${productId}`);
const optionsToggle = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`options for ${name}`, "i") });

describe("R-1 M1: one render, no second step", () => {
  it("has no Get quote and no Back, with or without a product", async () => {
    renderSection();
    expect(screen.queryByRole("button", { name: /get quote/i })).toBeNull();
    await pick();
    expect(screen.queryByRole("button", { name: /get quote/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
  });
});

describe("R-2 M2: adding", () => {
  it("a search pick adds the line at 1 piece with the Qty selected, so typing replaces it", async () => {
    // a number input reports no selectionStart (HTML spec), so the select() call itself is what is watched
    const select = jest.spyOn(HTMLInputElement.prototype, "select");
    renderSection();
    await pick();
    const qty = qtyInputs()[0];
    expect(qty.value).toBe("1");
    expect(document.activeElement).toBe(qty);
    expect(select.mock.instances).toContain(qty);
    select.mockRestore();
  });

  it("picking a product that is already listed adds a piece to its line, never a second line", async () => {
    renderSection();
    await pick();
    await pick();
    expect(qtyInputs()).toHaveLength(1);
    expect(qtyInputs()[0].value).toBe("2");
  });

  it("Enter in Qty returns focus to the add box, ready for the next product", async () => {
    renderSection();
    await pick();
    fireEvent.keyDown(qtyInputs()[0], { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByLabelText(/add another product/i));
  });

  it("rows seeded from the entry order stay blank: nothing sold is presumed returned, and nothing is quoted", () => {
    mockEntryOrder = {
      id: "order-1",
      lineItems: [{ productId: "prod-1", qty: 5, product: { name: "Widget", unit: "each" } }],
    };
    renderSection({ entryOrderId: "order-1" });
    expect(qtyInputs()[0].value).toBe("");
    wait(DEBOUNCE * 3);
    expect(quoteMutate).not.toHaveBeenCalled();
  });
});

describe("R-1 M3: the live quote", () => {
  it("waits 350 ms after the last keystroke, then asks once with the lines' request", async () => {
    renderSection();
    await pick();
    wait(DEBOUNCE - 1);
    expect(quoteMutate).not.toHaveBeenCalled();
    wait(1);
    expect(quoteMutate).toHaveBeenCalledTimes(1);
    expect(quoteCall()[0]).toEqual({
      customerId: "cust-1",
      items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 1 }],
    });
  });

  it("a keystroke inside the window restarts it, and only the newest quantity is asked", async () => {
    renderSection();
    await pick();
    setQty("10");
    wait(200);
    setQty("12");
    wait(200);
    expect(quoteMutate).not.toHaveBeenCalled();
    wait(150);
    expect(quoteMutate).toHaveBeenCalledTimes(1);
    expect(quoteCall()[0].items[0].pieces).toBe(12);
  });

  it("sends the sale the return is from when the host names one", async () => {
    renderSection({ sourceOrderId: "sale-9" });
    await pick();
    wait(DEBOUNCE);
    expect(quoteCall()[0].sourceOrderId).toBe("sale-9");
  });

  it("R-9: a slow old reply landing after a new one is ignored", async () => {
    const { last } = renderSection();
    await pick();
    setQty("10");
    wait(DEBOUNCE); // request A (10) is in flight
    setQty("11");
    wait(DEBOUNCE); // newer key: held until A comes back, one request at a time
    expect(quoteMutate).toHaveBeenCalledTimes(1);
    answer(quoteResponse([chunk({ pieces: 10, subtotal: 20 })]), 0); // A lands: stale, dropped
    expect(last().quote).toBeNull();
    expect(last().quoteStatus).toBe("pending");
    expect(quoteMutate).toHaveBeenCalledTimes(2); // B goes out now
    expect(quoteCall(1)[0].items[0].pieces).toBe(11);
    answer(quoteResponse([chunk({ pieces: 11, subtotal: 22, taxAmount: 0 })]), 1);
    expect(last().quoteStatus).toBe("current");
    expect(last().quote?.total).toBe(22);
  });
});

describe("R-1 M4: a quote is current or it is nothing", () => {
  it("R-1: after a quote lands, changing a quantity drops it at once, before the new one is asked", async () => {
    const { last } = renderSection();
    await pick();
    setQty("10");
    wait(DEBOUNCE);
    answer(quoteResponse([chunk()]));
    expect(last().quoteStatus).toBe("current");
    expect(last().quote).not.toBeNull();
    setQty("11");
    expect(last().quoteStatus).toBe("pending");
    expect(last().quote).toBeNull();
  });

  it("no sendable quantity means no quote: status none", async () => {
    const { last } = renderSection();
    await pick();
    setQty("");
    wait(DEBOUNCE * 2);
    expect(last().quoteStatus).toBe("none");
    expect(last().quote).toBeNull();
    expect(quoteMutate).toHaveBeenCalledTimes(0);
  });
});

describe("R-3: add another after the credit is worked out", () => {
  it("the add box stays, a second product prices alongside the first", async () => {
    const { last } = renderSection();
    await pick();
    setQty("10");
    wait(DEBOUNCE);
    answer(quoteResponse([chunk()]));
    await pick("Gadget");
    expect(qtyInputs()).toHaveLength(2);
    wait(DEBOUNCE);
    expect(quoteCall()[0].items.map((i: { productId: string }) => i.productId)).toEqual([
      "prod-1",
      "prod-2",
    ]);
    answer(
      quoteResponse([
        chunk(),
        chunk({ productId: "prod-2", pieces: 1, subtotal: 5, taxAmount: 0 }),
      ]),
    );
    expect(last().quoteStatus).toBe("current");
    expect(summary("prod-1")).toHaveTextContent("$22.00");
    expect(summary("prod-2")).toHaveTextContent("$5.00");
  });
});

describe("R-5 M7: the reason starts on the server's own default", () => {
  it("a return no one has touched the reason of is already EXCESS_ORDER", () => {
    const { last } = renderSection();
    expect(last().captureReason).toBe("EXCESS_ORDER");
  });

  it("one control, 'Reason for all items', with no 'Choose a reason' placeholder", () => {
    renderSection();
    const reason = screen.getByLabelText(/reason for all items/i);
    expect(reason).toHaveValue("EXCESS_ORDER");
    expect(within(reason).queryByText(/choose a reason/i)).toBeNull();
    expect(screen.getAllByLabelText(/reason for all items/i)).toHaveLength(1);
  });

  it("reads 'Bought too many' at the counter and 'Excess / Overdelivery' elsewhere", () => {
    const counter = renderSection({ reasonContext: "counter" });
    expect(screen.getByLabelText(/reason for all items/i)).toHaveDisplayValue("Bought too many");
    counter.unmount();
    renderSection({ reasonContext: "delivery" });
    expect(screen.getByLabelText(/reason for all items/i)).toHaveDisplayValue(
      "Excess / Overdelivery",
    );
  });
});

describe("R-6 M7: the closed row says where the goods go", () => {
  it("shows the options in words, with 'Back to stock' by default", async () => {
    renderSection({ reasonContext: "counter" });
    await pick();
    expect(summary("prod-1")).toHaveTextContent("Bought too many");
    expect(summary("prod-1")).toHaveTextContent("Back to stock");
  });

  it("DAMAGED on one line reads 'Not added to stock' on that line only", async () => {
    renderSection({ reasonContext: "counter" });
    await pick();
    await pick("Gadget");
    fireEvent.click(optionsToggle("Widget"));
    fireEvent.change(within(row("prod-1")).getByLabelText(/reason \(optional\)/i), {
      target: { value: "DAMAGED" },
    });
    expect(summary("prod-1")).toHaveTextContent("Not added to stock");
    expect(summary("prod-1")).not.toHaveTextContent("Back to stock");
    expect(summary("prod-2")).toHaveTextContent("Back to stock");
  });

  it("changing 'Reason for all items' moves every line that has no reason of its own", async () => {
    renderSection({ reasonContext: "counter" });
    await pick();
    fireEvent.change(screen.getByLabelText(/reason for all items/i), {
      target: { value: "QUALITY_ISSUE" },
    });
    expect(summary("prod-1")).toHaveTextContent("Not added to stock");
  });
});

describe("R-4 M8: goods past what was bought, line by line", () => {
  async function twoLinesPastBought() {
    const view = renderSection();
    await pick();
    await pick("Gadget");
    setQty("10", 0);
    setQty("8", 1);
    wait(DEBOUNCE);
    answer(
      quoteResponse([
        chunk({ productId: "prod-1", pieces: 4 }),
        noSale({ productId: "prod-1", pieces: 6, subtotal: 12, taxAmount: 0 }),
        chunk({ productId: "prod-2", pieces: 3 }),
        noSale({ productId: "prod-2", pieces: 5, subtotal: 10, taxAmount: 0 }),
      ]),
    );
    return view;
  }

  it("a line with goods past what was bought says so in amber on its closed row, with its default", async () => {
    await twoLinesPastBought();
    expect(within(row("prod-1")).getByTestId("return-line-flag-prod-1")).toHaveTextContent(
      "6 not on any invoice · Credit at current price",
    );
    expect(within(row("prod-2")).getByTestId("return-line-flag-prod-2")).toHaveTextContent(
      "5 not on any invoice · Credit at current price",
    );
  });

  it("there is no section-wide choice any more", async () => {
    await twoLinesPastBought();
    expect(screen.queryByRole("radio")).toBeNull(); // options are closed: nothing to pick yet
    fireEvent.click(optionsToggle("Widget"));
    expect(screen.getAllByRole("radio")).toHaveLength(2); // this line's two, not four
  });

  it("R-4: 'Return only what was bought' on one line trims that line only, and the live quote follows", async () => {
    const { last } = await twoLinesPastBought();
    fireEvent.click(optionsToggle("Widget"));
    const credit = within(row("prod-1")).getByRole("radio", { name: /credit at current price/i });
    expect(credit).toBeChecked();
    fireEvent.click(
      within(row("prod-1")).getByRole("radio", { name: /return only what was bought/i }),
    );
    expect(qtyInputs().map((q) => q.value)).toEqual(["4", "8"]); // Widget trimmed, Gadget untouched
    expect(last().quoteStatus).toBe("pending");
    wait(DEBOUNCE);
    expect(quoteCall()[0].items).toEqual([
      { productId: "prod-1", qty: 1, boxes: 0, pieces: 4 },
      { productId: "prod-2", qty: 1, boxes: 0, pieces: 8 },
    ]);
  });

  it("typing the number back, or choosing 'Credit at current price', undoes the trim", async () => {
    await twoLinesPastBought();
    fireEvent.click(optionsToggle("Widget"));
    const only = () =>
      within(row("prod-1")).getByRole("radio", { name: /return only what was bought/i });
    fireEvent.click(only());
    expect(only()).toBeChecked();
    fireEvent.click(within(row("prod-1")).getByRole("radio", { name: /credit at current price/i }));
    expect(qtyInputs()[0].value).toBe("10");
    fireEvent.click(only());
    setQty("10", 0);
    expect(only()).not.toBeChecked();
    expect(
      within(row("prod-1")).getByRole("radio", { name: /credit at current price/i }),
    ).toBeChecked();
  });

  it("with nothing bought before, the choice is disabled and says why, and no trim is ever asked", async () => {
    renderSection();
    await pick();
    setQty("6");
    wait(DEBOUNCE);
    answer(quoteResponse([noSale({ pieces: 6, subtotal: 15, taxAmount: 0 })]));
    fireEvent.click(optionsToggle("Widget"));
    const only = within(row("prod-1")).getByRole("radio", { name: /return only what was bought/i });
    expect(only).toBeDisabled();
    expect(within(row("prod-1")).getByText(NOTHING_BOUGHT_BEFORE_MESSAGE)).toBeInTheDocument();
    fireEvent.click(only);
    wait(DEBOUNCE * 2);
    expect(quoteMutate).toHaveBeenCalledTimes(1);
  });
});

describe("R-1 M6: every quote fact has a place", () => {
  it("the closed row's figure is the line's credit; the open options carry the chunk and its order", async () => {
    mockEntryOrder = { id: "order-newest", orderNumber: "1042", orderDate: "2026-10-01T00:00:00Z" };
    renderSection();
    await pick();
    setQty("10");
    wait(DEBOUNCE);
    answer(quoteResponse([chunk()]));
    expect(summary("prod-1")).toHaveTextContent("$22.00");
    fireEvent.click(optionsToggle("Widget"));
    expect(within(row("prod-1")).getByText(/from order #1042/i)).toBeInTheDocument();
    expect(within(row("prod-1")).getByText("Net $20.00")).toBeInTheDocument();
  });

  it("a lowered credit is shown in the line's options and the closed figure is the lowered one", async () => {
    authRole = "OPERATOR";
    renderSection();
    await pick();
    setQty("10");
    wait(DEBOUNCE);
    answer(
      quoteResponse([
        chunk({
          priceSource: "MANUAL",
          unitPrice: 1.5,
          originalPrice: 2,
          overrideReason: "Dented",
          subtotal: 15,
          taxAmount: 0,
        }),
      ]),
    );
    expect(summary("prod-1")).toHaveTextContent("$15.00");
    expect(
      within(row("prod-1")).getByText(/credit lowered to \$1\.50 each from \$2\.00 each/i),
    ).toBeInTheDocument();
  });

  it("the multi-order note shows on the line that spans orders", async () => {
    renderSection();
    await pick();
    setQty("10");
    wait(DEBOUNCE);
    answer(
      quoteResponse([
        chunk({ pieces: 5, sourceOrderId: "order-a" }),
        chunk({ pieces: 5, sourceOrderId: "order-b" }),
      ]),
    );
    fireEvent.click(optionsToggle("Widget"));
    expect(within(row("prod-1")).getByText(/more than one earlier order/i)).toBeInTheDocument();
  });

  it("the summary under the list is the quote's own Subtotal, Tax, Total and the credit line", async () => {
    renderSection({ customerName: "Acme Co", creditContext: "thisOrder" });
    await pick();
    setQty("10");
    wait(DEBOUNCE);
    answer(quoteResponse([chunk({ categoryTax: 1 })]));
    const summaryBox = screen.getByTestId("return-summary");
    expect(summaryBox).toHaveTextContent("Subtotal$20.00");
    expect(summaryBox).toHaveTextContent("Tax$2.00");
    expect(summaryBox).toHaveTextContent("Category levy$1.00");
    expect(summaryBox).toHaveTextContent("Total$23.00");
    expect(summaryBox).toHaveTextContent(/credit/i);
  });

  it("shows a working-on-it summary while a new quote is pending, never the old figures as current", async () => {
    renderSection();
    await pick();
    setQty("10");
    wait(DEBOUNCE);
    answer(quoteResponse([chunk()]));
    setQty("11");
    expect(screen.getByTestId("return-summary")).toHaveAttribute("aria-busy", "true");
    // the credit sentence is for a current quote only: pending, it names no amount at all
    expect(screen.getByTestId("return-summary")).not.toHaveTextContent(/store credit|credit note/i);
  });
});

describe("R-12 M9: a decision that is not optional opens by itself", () => {
  const alreadyReturned = () =>
    quoteResponse([
      chunk({ pieces: 4 }),
      noSale({ pieces: 2, subtotal: 5, taxAmount: 0, alreadyReturned: true }),
    ]);

  it("staff: the line says so in amber, its options open, and the reason is asked there", async () => {
    authRole = "OPERATOR";
    const { last } = renderSection();
    await pick();
    setQty("6");
    wait(DEBOUNCE);
    answer(alreadyReturned());
    expect(within(row("prod-1")).getByTestId("return-line-flag-prod-1")).toHaveTextContent(
      "Already returned or credited",
    );
    expect(optionsToggle("Widget")).toHaveAttribute("aria-expanded", "true");
    const why = within(row("prod-1")).getByLabelText(/why credit widget again \(required\)/i);
    expect(why).toBeVisible();
    fireEvent.change(why, { target: { value: "Customer returned a second batch" } });
    expect(last().lines[0].alreadyReturnedReason).toBe("Customer returned a second batch");
  });

  it("review-b FAIL 3: a line past what was bought because it was already returned is offered 'Return only what was bought'", async () => {
    authRole = "OPERATOR";
    renderSection();
    await pick();
    setQty("6");
    wait(DEBOUNCE);
    answer(alreadyReturned());
    const only = within(row("prod-1")).getByRole("radio", { name: /return only what was bought/i });
    expect(only).toBeEnabled();
    fireEvent.click(only);
    expect(qtyInputs()[0].value).toBe("4");
  });

  it("a driver is told the return is held, with no reason to type", async () => {
    authRole = "DRIVER";
    renderSection();
    await pick();
    setQty("6");
    wait(DEBOUNCE);
    answer(alreadyReturned());
    expect(screen.queryByLabelText(/why credit widget again/i)).toBeNull();
    expect(screen.getByText(/held for the office to confirm/i)).toBeInTheDocument();
  });

  it("a typed note or price is never out of sight: the options stay open while they hold a value", async () => {
    renderSection();
    await pick();
    fireEvent.click(optionsToggle("Widget"));
    fireEvent.change(within(row("prod-1")).getByLabelText(/note \(optional\)/i), {
      target: { value: "Dented" },
    });
    expect(optionsToggle("Widget")).toHaveAttribute("aria-expanded", "true");
    // review-b Low 1: forced open does not disable the toggle, so the summary it holds is neither dimmed nor out of focus order
    expect(optionsToggle("Widget")).toHaveAttribute("aria-disabled", "true");
    expect(optionsToggle("Widget")).toBeEnabled();
    fireEvent.click(optionsToggle("Widget"));
    expect(optionsToggle("Widget")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("R-10 M11: a refused quote keeps the work", () => {
  const refusal = {
    response: {
      status: 400,
      data: {
        message: "That is more than was sold",
        code: "RETURN_EXCEEDS_SALE",
        productId: "prod-1",
      },
    },
  };

  it("keeps every line and the add box, shows the server's message under the list, and blocks", async () => {
    const { last } = renderSection();
    await pick();
    await pick("Gadget");
    setQty("99", 0);
    wait(DEBOUNCE);
    refuse(refusal);
    expect(qtyInputs()).toHaveLength(2);
    expect(qtyInputs()[0].value).toBe("99");
    expect(screen.getByLabelText(/add another product/i)).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("That is more than was sold");
    expect(last().quoteStatus).toBe("refused");
    expect(last().quote).toBeNull();
  });

  it("marks the row the refusal names", async () => {
    renderSection();
    await pick();
    await pick("Gadget");
    wait(DEBOUNCE);
    refuse(refusal);
    expect(qtyInputs()[0]).toHaveAttribute("aria-invalid", "true");
    expect(qtyInputs()[1]).toHaveAttribute("aria-invalid", "false");
  });

  it("the refusal clears as soon as the lines change and a new quote is on its way", async () => {
    const { last } = renderSection();
    await pick();
    wait(DEBOUNCE);
    refuse(refusal);
    setQty("2");
    expect(last().quoteStatus).toBe("pending");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a quote that did not come back at all is 'failed', says so once, and Try again asks again", async () => {
    const { last } = renderSection();
    await pick();
    wait(DEBOUNCE);
    refuse(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }));
    expect(last().quoteStatus).toBe("failed");
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(quoteMutate).toHaveBeenCalledTimes(2);
    expect(last().quoteStatus).toBe("pending");
  });
});

describe("R-11 M10: the host's footer and actions, and locking", () => {
  it("renders the host's footer and actions under the summary only while the quote is current", async () => {
    renderSection({
      renderQuoteFooter: () => <p>host footer</p>,
      renderQuoteActions: () => <button type="button">Take back items</button>,
    });
    await pick();
    expect(screen.queryByText("host footer")).toBeNull();
    wait(DEBOUNCE);
    expect(screen.queryByText("host footer")).toBeNull(); // asked, not answered
    answer(quoteResponse([chunk({ pieces: 1 })]));
    expect(screen.getByText("host footer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take back items" })).toBeInTheDocument();
    setQty("2");
    expect(screen.queryByRole("button", { name: "Take back items" })).toBeNull();
  });

  it("locked: every input, the add box, Remove and the options' fields are disabled", async () => {
    const { rerender, states } = renderSection();
    await pick();
    fireEvent.click(optionsToggle("Widget"));
    rerender(
      <InlineReturnSection customerId="cust-1" locked onStateChange={(s) => states.push(s)} />,
    );
    expect(qtyInputs()[0]).toBeDisabled();
    expect(screen.getByLabelText(/add another product/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeDisabled();
    expect(screen.getByLabelText(/reason for all items/i)).toBeDisabled();
    expect(within(row("prod-1")).getByLabelText(/reason \(optional\)/i)).toBeDisabled();
    expect(within(row("prod-1")).getByLabelText(/note \(optional\)/i)).toBeDisabled();
  });

  it("while locked a quantity can no longer start a new quote", async () => {
    const { rerender, states } = renderSection();
    await pick();
    wait(DEBOUNCE);
    answer(quoteResponse([chunk({ pieces: 1 })]));
    rerender(
      <InlineReturnSection customerId="cust-1" locked onStateChange={(s) => states.push(s)} />,
    );
    fireEvent.change(qtyInputs()[0], { target: { value: "9" } }); // disabled: React still lets a test fire it
    wait(DEBOUNCE * 2);
    expect(quoteMutate).toHaveBeenCalledTimes(1);
  });

  it("a host that is not ready (getQuoteEnabled false) asks nothing and says what it is waiting for", async () => {
    renderSection({
      getQuoteEnabled: false,
      waitingFor: "Choose the order above to see the credit.",
    });
    await pick();
    wait(DEBOUNCE * 2);
    expect(quoteMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Choose the order above to see the credit.")).toBeInTheDocument();
  });
});

describe("M14 to M16 (SA-1069 A-2)", () => {
  it("M14: a half-typed credit price asks nothing, is not current, and reports its sentence", async () => {
    authRole = "OPERATOR";
    const onStateChange = jest.fn();
    renderSection({ onStateChange });
    await pick();
    setQty("2");
    fireEvent.click(optionsToggle("Widget"));
    fireEvent.change(screen.getByLabelText(/^credit price$/i), { target: { value: "1.00" } });
    wait(DEBOUNCE * 2);
    expect(quoteMutate).not.toHaveBeenCalled();
    const state = onStateChange.mock.calls[onStateChange.mock.calls.length - 1][0];
    expect(state.quoteStatus).toBe("refused");
    expect(state.quote).toBeNull();
    expect(state.problem).toMatch(/^Widget: /);
  });

  it("M15: an over-cap refusal marks the row it names and keeps the lines and the add box", async () => {
    renderSection();
    await pick();
    setQty("2");
    wait(DEBOUNCE);
    refuse({
      response: {
        status: 400,
        data: { code: "RETURN_CREDIT_OVER_CAP", productId: "prod-1", message: "Widget: too high" },
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Widget: too high");
    expect(qtyInputs()[0]).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/add another product/i)).toBeInTheDocument();
  });

  it("M16: no '(s)' in the line's text; the count agrees with its noun", async () => {
    const { container } = renderSection();
    await pick();
    setQty("3");
    wait(DEBOUNCE);
    answer(quoteResponse([chunk({ pieces: 2 }), noSale({ pieces: 1, subtotal: 2, taxAmount: 0 })]));
    fireEvent.click(optionsToggle("Widget"));
    expect(container.textContent).not.toMatch(/\(s\)/);
    expect(container.textContent).toMatch(/1 piece priced at the customer/);
  });
});

describe("review-c on #4036 (T1, four MUSTs and the mutants they left)", () => {
  it("mutant L: the closed row shows no credit while the next quote is pending", async () => {
    renderSection();
    await pick();
    setQty("10");
    wait(DEBOUNCE);
    answer(quoteResponse([chunk()]));
    expect(summary("prod-1")).toHaveTextContent("Credit $22.00");
    setQty("11");
    expect(summary("prod-1")).not.toHaveTextContent(/Credit/);
  });

  it("MUST 2: locked, Scan barcode and Undo are disabled, and a scan or a pick adds nothing", async () => {
    const { rerender, states } = renderSection();
    await pick();
    await pick("Gadget");
    fireEvent.click(screen.getAllByRole("button", { name: /^remove$/i })[0]);
    expect(screen.getByRole("button", { name: /^undo$/i })).toBeEnabled(); // unlocked: Undo works
    rerender(
      <InlineReturnSection customerId="cust-1" locked onStateChange={(s) => states.push(s)} />,
    );
    expect(screen.getByRole("button", { name: /scan barcode/i })).toBeDisabled();
    const undo = screen.getByRole("button", { name: /^undo$/i });
    expect(undo).toBeDisabled();
    fireEvent.click(undo);
    expect(qtyInputs()).toHaveLength(1);
    act(() => {
      mockScanDeps?.addLineItem(WIDGET); // a scan the camera or wedge delivered after the save
    });
    expect(qtyInputs()).toHaveLength(1);
  });

  it("MUST 4: a second row of one product shows the first row's reason and stock outcome, and takes none of its own", async () => {
    mockEntryOrder = {
      id: "order-1",
      lineItems: [
        { productId: "prod-1", qty: 5, product: { name: "Widget", unit: "each" } },
        { productId: "prod-1", qty: 2, product: { name: "Widget", unit: "each" } },
      ],
    };
    renderSection({ entryOrderId: "order-1", reasonContext: "counter" });
    const rows = () => screen.getAllByTestId("return-line-prod-1");
    expect(rows()).toHaveLength(2);
    const toggles = screen.getAllByRole("button", { name: /options for widget/i });
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    // the first row says DAMAGED: buildCaptureRequest keeps the first row's reason for the merged item
    fireEvent.change(within(rows()[0]).getByLabelText("Reason (optional)"), {
      target: { value: "DAMAGED" },
    });
    const second = within(rows()[1]);
    const secondReason = second.getByLabelText("Reason (same as the first row)");
    expect(secondReason).toBeDisabled();
    expect((secondReason as HTMLSelectElement).value).toBe("DAMAGED");
    for (const r of rows()) {
      expect(within(r).getByTestId("return-line-summary-prod-1")).toHaveTextContent(
        "Not added to stock",
      );
    }
  });

  it("MUST 4: a first row left on the default reads the default on both rows, whatever the second row once held", async () => {
    mockEntryOrder = {
      id: "order-1",
      lineItems: [
        { productId: "prod-1", qty: 5, product: { name: "Widget", unit: "each" } },
        { productId: "prod-1", qty: 2, product: { name: "Widget", unit: "each" } },
      ],
    };
    renderSection({ entryOrderId: "order-1", reasonContext: "counter" });
    for (const r of screen.getAllByTestId("return-line-prod-1")) {
      expect(within(r).getByTestId("return-line-summary-prod-1")).toHaveTextContent(
        "Back to stock",
      );
    }
  });
});

describe("review-c on #4036 at 852bb08fce", () => {
  const twoRows = () => {
    mockEntryOrder = {
      id: "order-1",
      lineItems: [
        { productId: "prod-1", qty: 5, product: { name: "Widget", unit: "each" } },
        { productId: "prod-1", qty: 2, product: { name: "Widget", unit: "each" } },
      ],
    };
  };
  const sentReason = (lines: InlineReturnSectionState["lines"]) =>
    buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines,
      returnKey: "k",
      reason: "EXCESS_ORDER",
    }).items[0]?.reason;

  it("MUST 4, blank first row: the row that counts rules, on screen and in what is sent", async () => {
    twoRows();
    const { last } = renderSection({ entryOrderId: "order-1", reasonContext: "counter" });
    const rows = () => screen.getAllByTestId("return-line-prod-1");
    const toggles = screen.getAllByRole("button", { name: /options for widget/i });
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    // the clerk sets DAMAGED on row 1 (no counts yet, so it rules), then counts on row 2 and leaves row 1 blank
    fireEvent.change(within(rows()[0]).getByLabelText("Reason (optional)"), {
      target: { value: "DAMAGED" },
    });
    setQty("3", 1);
    // row 1 has no quantity, so the capture drops it: it neither rules nor reads DAMAGED
    const first = within(rows()[0]).getByLabelText("Reason (same as the first row with a count)");
    expect(first).toBeDisabled();
    expect((first as HTMLSelectElement).value).toBe("");
    const second = within(rows()[1]).getByLabelText("Reason (optional)");
    expect(second).toBeEnabled();
    for (const r of rows()) {
      expect(within(r).getByTestId("return-line-summary-prod-1")).toHaveTextContent(
        "Back to stock",
      );
      expect(within(r).getByTestId("return-line-summary-prod-1")).not.toHaveTextContent(
        "Not added to stock",
      );
    }
    expect(sentReason(last().lines)).toBeUndefined();
    // the reason set on the row that counts is the one both rows read and the one that is sent
    fireEvent.change(second, { target: { value: "DAMAGED" } });
    for (const r of rows()) {
      expect(within(r).getByTestId("return-line-summary-prod-1")).toHaveTextContent(
        "Not added to stock",
      );
    }
    expect(sentReason(last().lines)).toBe("DAMAGED");
  });

  it("MUST 4, both rows counted: the first row still rules and says 'the first row'", async () => {
    twoRows();
    renderSection({ entryOrderId: "order-1", reasonContext: "counter" });
    const rows = () => screen.getAllByTestId("return-line-prod-1");
    fireEvent.click(screen.getAllByRole("button", { name: /options for widget/i })[1]);
    expect(within(rows()[1]).getByLabelText("Reason (same as the first row)")).toBeDisabled();
  });

  it("an already-returned line with nothing covered does not say the customer hasn't bought it", async () => {
    authRole = "OPERATOR";
    renderSection();
    await pick();
    setQty("6");
    wait(DEBOUNCE);
    answer(
      quoteResponse([noSale({ pieces: 6, subtotal: 12, taxAmount: 0, alreadyReturned: true })]),
    );
    const line = within(row("prod-1"));
    const only = line.getByRole("radio", { name: /return only what was bought/i });
    expect(only).toBeDisabled();
    expect(line.getByText(ALREADY_RETURNED_NOTHING_LEFT_MESSAGE)).toBeInTheDocument();
    expect(line.queryByText(NOTHING_BOUGHT_BEFORE_MESSAGE)).toBeNull();
    expect(line.queryByText(/hasn't bought/i)).toBeNull();
  });

  it("a line that was never bought still says so, and not the already-returned sentence", async () => {
    renderSection();
    await pick();
    setQty("6");
    wait(DEBOUNCE);
    answer(quoteResponse([noSale({ pieces: 6, subtotal: 15, taxAmount: 0 })]));
    fireEvent.click(optionsToggle("Widget"));
    const line = within(row("prod-1"));
    expect(line.getByText(NOTHING_BOUGHT_BEFORE_MESSAGE)).toBeInTheDocument();
    expect(line.queryByText(ALREADY_RETURNED_NOTHING_LEFT_MESSAGE)).toBeNull();
  });
});

describe("review-c on #4036 at d2d62cf335: the already-returned reason follows the ruling row", () => {
  it("count on row 2: the reason box and the credit sit on row 2, and what is typed there is sent", async () => {
    authRole = "OPERATOR";
    mockEntryOrder = {
      id: "order-1",
      lineItems: [
        { productId: "prod-1", qty: 5, product: { name: "Widget", unit: "each" } },
        { productId: "prod-1", qty: 2, product: { name: "Widget", unit: "each" } },
      ],
    };
    const { last } = renderSection({ entryOrderId: "order-1", reasonContext: "counter" });
    setQty("6", 1);
    wait(DEBOUNCE);
    answer(
      quoteResponse([
        chunk({ pieces: 4 }),
        noSale({ pieces: 2, subtotal: 5, taxAmount: 0, alreadyReturned: true }),
      ]),
    );
    const rows = () => screen.getAllByTestId("return-line-prod-1");
    // row 1 has no count, so the capture drops it: it must not carry the box or the credit
    expect(within(rows()[0]).queryByLabelText(/why credit widget again/i)).toBeNull();
    expect(within(rows()[0]).queryByText(/^Credit \$/)).toBeNull();
    const why = within(rows()[1]).getByLabelText(/why credit widget again \(required\)/i);
    expect(within(rows()[1]).getByTestId("return-line-summary-prod-1")).toHaveTextContent(
      "Credit $",
    );
    fireEvent.change(why, { target: { value: "Customer returned a second batch" } });
    expect(
      buildCaptureRequest({
        customerId: "cust-1",
        orderId: "order-1",
        lines: last().lines,
        returnKey: "k",
        reason: "EXCESS_ORDER",
      }).items[0]?.alreadyReturnedReason,
    ).toBe("Customer returned a second batch");
  });
});
