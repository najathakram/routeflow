import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { handleMutationError } from "@/lib/mutation-error-toast";
import { PickupCompleteDialog } from "./PickupCompleteDialog";
import { PickupHandOverDialog } from "./PickupHandOver";

/**
 * Order ahead: "Picked up" hands a PICKUP order over (POST /orders/:id/pickup-complete). One
 * Idempotency-Key per dialog open, kept across retries; a paid order has no tender step; the tender
 * rules are the till's (validatePayment, change, check number); a payment that was not recorded is
 * retried under the SAME key.
 */
let authUser: { id: string; tenantSlug: string | null; role?: string } | null = {
  id: "u-a",
  tenantSlug: "acme",
  role: "OPERATOR",
};
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: authUser }),
}));
const get = jest.fn();
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

const result = (over: Record<string, unknown> = {}) => ({
  data: {
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 25,
    paid: 25,
    balanceDue: 0,
    paymentRecorded: true,
    ...over,
  },
});

const invoices = (_balanceDue: number, status = "SENT") => [
  { id: "i1", invoiceNumber: "INV-1", status, total: 25 },
];

function mount(props: Partial<React.ComponentProps<typeof PickupCompleteDialog>> = {}) {
  const onClose = jest.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = jest.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <PickupCompleteDialog
        open
        onClose={onClose}
        orderId="o1"
        orderNumber="ORD-1"
        total={25}
        invoices={invoices(25)}
        isWalkIn={false}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onClose, invalidate };
}

const balance = (n: number, status = "SENT") =>
  get.mockResolvedValue({ data: { id: "i1", status, total: 25, balanceDue: n } });
const confirm = () =>
  fireEvent.click(screen.getByRole("button", { name: /^(confirm )?picked up$/i }));

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  authUser = { id: "u-a", tenantSlug: "acme", role: "OPERATOR" };
  post.mockResolvedValue(result());
});

describe("PickupCompleteDialog — nothing to collect", () => {
  it("a settled order shows no tender step, and the confirm posts with no payment", async () => {
    balance(0, "PAID");
    mount();
    expect(await screen.findByText("Paid — nothing to collect")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cash" })).toBeNull();
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe("/orders/o1/pickup-complete");
    expect(body).toEqual({});
    expect(config.headers["Idempotency-Key"]).toEqual(expect.any(String));
  });

  it("an order with no invoice yet collects the order total", async () => {
    mount({ invoices: [] });
    expect(await screen.findByRole("button", { name: "Cash" })).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("PickupCompleteDialog — hand-over copy (row 345)", () => {
  it("the hand-over title drops the dash: 'Hand over ORD-00008'", async () => {
    balance(0, "PAID");
    mount({ handOver: true, orderNumber: "ORD-00008" });
    expect(await screen.findByRole("dialog", { name: "Hand over ORD-00008" })).toBeInTheDocument();
  });

  it("a fully paid hand-over reads 'Picked up and paid.'", async () => {
    balance(0, "PAID");
    post.mockResolvedValue(result({ balanceDue: 0 }));
    mount();
    expect(await screen.findByText("Paid — nothing to collect")).toBeInTheDocument();
    confirm();
    expect(await screen.findByTestId("pickup-outcome")).toHaveTextContent("Picked up and paid.");
  });

  it("a hand-over with a balance left reads 'Picked up. $7.58 still due.'", async () => {
    balance(0, "PAID");
    post.mockResolvedValue(result({ balanceDue: 7.58, paid: 17.42 }));
    mount();
    expect(await screen.findByText("Paid — nothing to collect")).toBeInTheDocument();
    confirm();
    expect(await screen.findByTestId("pickup-outcome")).toHaveTextContent(
      "Picked up. $7.58 still due.",
    );
  });
});

describe("PickupCompleteDialog — tender", () => {
  it("cash: a short tender is refused with the till's copy and nothing is posted", async () => {
    balance(25);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "10" } });
    confirm();
    // names what to enter: the order's amount due, through the shared money formatter
    expect(await screen.findByText("Enter at least $25.00.")).toBeVisible();
    expect(post).not.toHaveBeenCalled();
  });

  it("cash: sends method + amount, and shows the change from the server", async () => {
    balance(25);
    post.mockResolvedValue(result({ change: 15, paid: 25 }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "40" } });
    expect(screen.getByTestId("pickup-change-due")).toHaveTextContent("$15.00");
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual({ payment: { method: "CASH", amount: 40 } });
    expect(await screen.findByTestId("pickup-change")).toHaveTextContent("$15.00");
    // owner ruling 10-12 wording: no em dash, a full sentence
    expect(screen.getByTestId("pickup-outcome")).toHaveTextContent("Picked up and paid.");
    expect(screen.getByRole("dialog", { name: "Picked up ORD-1" })).toBeInTheDocument();
  });

  it("a balance still due after the hand-over reads 'Picked up. $7.58 still due.'", async () => {
    balance(25);
    post.mockResolvedValue(result({ balanceDue: 7.58, paid: 17.42, change: 0 }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "25" } });
    confirm();
    expect(await screen.findByText("Picked up. $7.58 still due.")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Picked up —/);
  });

  it("quick tender fills the amount", async () => {
    balance(25);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Exact" }));
    expect(screen.getByLabelText("Amount tendered")).toHaveValue("25");
  });

  it("check: needs a number, and sends the reference with NO amount", async () => {
    balance(25);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    confirm();
    expect(await screen.findByText("Enter the check number.")).toBeVisible();
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Check number"), { target: { value: " 1042 " } });
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual({ payment: { method: "CHECK", reference: "1042" } });
  });

  it("card and on account send the method alone", async () => {
    balance(25);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual({ payment: { method: "CARD" } });
  });

  it("a walk-in is never offered On account (hidden, not just disabled)", async () => {
    balance(25);
    mount({ isWalkIn: true });
    expect(await screen.findByRole("button", { name: "Cash" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "On account" })).toBeNull();
  });

  it("a non-walk-in is offered On account, and it posts the method alone", async () => {
    balance(25);
    mount({ isWalkIn: false });
    fireEvent.click(await screen.findByRole("button", { name: "On account" }));
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual({ payment: { method: "ON_ACCOUNT" } });
  });
});

describe("PickupCompleteDialog — results, retries, errors", () => {
  it("payment not recorded: says so, and Retry reposts under the SAME key", async () => {
    balance(25);
    post.mockResolvedValueOnce(result({ paymentRecorded: false, paymentErrorCode: "X", paid: 0 }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    expect(await screen.findByText("Payment not recorded")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][2].headers["Idempotency-Key"]).toBe(
      post.mock.calls[0][2].headers["Idempotency-Key"],
    );
    expect(post.mock.calls[1][1]).toEqual(post.mock.calls[0][1]);
  });

  it("alreadyPickedUp is shown as information", async () => {
    balance(0, "PAID");
    post.mockResolvedValue(result({ alreadyPickedUp: true }));
    mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    expect(await screen.findByText("This order was already picked up.")).toBeVisible();
  });

  it.each([
    [
      409,
      "PICKUP_NOT_READY",
      "This order isn't ready for pickup yet. Confirm it and mark it ready first.",
    ],
    [400, "PICKUP_ONLY", "Only a pickup order can be handed over this way."],
  ])("%s %s shows fixed copy, never the server message", async (status, code, copy) => {
    balance(0, "PAID");
    post.mockRejectedValueOnce({ response: { status, data: { code, message: "raw text" } } });
    mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(screen.queryByText(/raw text/)).toBeNull();
  });

  it("a failed attempt retried from the form reuses the same key", async () => {
    balance(0, "PAID");
    post.mockRejectedValueOnce({ response: { status: 500, data: {} } });
    mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    await screen.findByRole("alert");
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][2].headers["Idempotency-Key"]).toBe(
      post.mock.calls[0][2].headers["Idempotency-Key"],
    );
  });

  it("success invalidates the order and invoices, and Done closes", async () => {
    balance(0, "PAID");
    const { invalidate, onClose } = mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    await screen.findByRole("button", { name: "Done" });
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["orders"] }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("a new open gets a new key", async () => {
    balance(0, "PAID");
    const first = mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    first.unmount();
    mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][2].headers["Idempotency-Key"]).not.toBe(
      post.mock.calls[0][2].headers["Idempotency-Key"],
    );
  });
});

describe("PickupCompleteDialog — the API's pickup codes", () => {
  it("PICKUP_PAYMENT_REQUIRED: fixed copy, tender step, then the SAME key with the payment", async () => {
    balance(0, "PAID");
    post.mockResolvedValueOnce(
      result({
        paymentRecorded: false,
        paymentErrorCode: "PICKUP_PAYMENT_REQUIRED",
        paid: 0,
        balanceDue: 25,
      }),
    );
    mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A balance is due on this order now. Take payment to finish.",
    );
    expect(screen.queryByText("Payment not recorded")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toEqual({ payment: { method: "CARD" } });
    expect(post.mock.calls[1][2].headers["Idempotency-Key"]).toBe(
      post.mock.calls[0][2].headers["Idempotency-Key"],
    );
  });

  it("400 COUNTER_TENDER_SHORT: fixed copy, stays on the tender step", async () => {
    balance(25);
    post.mockRejectedValueOnce({
      response: { status: 400, data: { code: "COUNTER_TENDER_SHORT", message: "raw text" } },
    });
    mount({ isWalkIn: true });
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A walk-in customer must pay the full balance.",
    );
    expect(screen.queryByText(/raw text/)).toBeNull();
    expect(screen.getByRole("button", { name: "Cash" })).toBeVisible();
  });

  it("200 COUNTER_TENDER_SHORT: fixed copy, stays on the tender step", async () => {
    balance(25);
    post.mockResolvedValueOnce(
      result({ paymentRecorded: false, paymentErrorCode: "COUNTER_TENDER_SHORT", balanceDue: 25 }),
    );
    mount({ isWalkIn: true });
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A walk-in customer must pay the full balance.",
    );
    expect(screen.getByRole("button", { name: "Cash" })).toBeVisible();
    expect(screen.queryByText("Payment not recorded")).toBeNull();
  });

  it("409 PICKUP_KEY_CONFLICT: fixed copy, Reload invalidates the order and closes", async () => {
    balance(0, "PAID");
    post.mockRejectedValueOnce({
      response: { status: 409, data: { code: "PICKUP_KEY_CONFLICT", message: "raw text" } },
    });
    const { invalidate, onClose } = mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Already picked up. Record any payment on the invoice.",
    );
    expect(screen.queryByText(/raw text/)).toBeNull();
    invalidate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["orders"] }));
    expect(onClose).toHaveBeenCalled();
  });

  it("409 COUNTER_SALE_DAY_CLOSED: the order IS handed over; fixed copy, never the server text, Reload (no retry)", async () => {
    balance(25);
    post.mockRejectedValueOnce({
      response: { status: 409, data: { code: "COUNTER_SALE_DAY_CLOSED", message: "raw text" } },
    });
    const { invalidate, onClose } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "25" } });
    confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent("Handed over. $25.00 still due.");
    expect(screen.queryByText(/raw text/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    invalidate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["orders"] }));
    expect(onClose).toHaveBeenCalled();
  });

  // W-776 (SA-925): the pre-check refused before any write: nothing changed, the tender step stays (Cancel + confirm), no Reload
  it("409 COUNTER_COMPLETE_DAY_CLOSED: says nothing changed and locks the tender step, Close not Reload", async () => {
    balance(25);
    post.mockRejectedValueOnce({
      response: { status: 409, data: { code: "COUNTER_COMPLETE_DAY_CLOSED", message: "raw text" } },
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "25" } });
    confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nothing changed. This register's day is closed. Ask a manager or owner to reopen it.",
    );
    expect(screen.queryByText(/Handed over/)).toBeNull();
    expect(screen.queryByText(/raw text/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(1); // W-778: the footer's one live action
  });

  it("409 PICKUP_INVOICE_MISSING: fixed copy, Retry reposts under the SAME key", async () => {
    balance(0, "PAID");
    post.mockRejectedValueOnce({
      response: { status: 409, data: { code: "PICKUP_INVOICE_MISSING", message: "raw text" } },
    });
    mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The order may be picked up, but its invoice isn't ready yet. Retry to finish.",
    );
    expect(screen.queryByText(/raw text/)).toBeNull();
    expect(screen.queryByText(/nothing was/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][2].headers["Idempotency-Key"]).toBe(
      post.mock.calls[0][2].headers["Idempotency-Key"],
    );
  });

  it("409 WALK_IN_OPEN_CREDIT: fixed copy, never the server text", async () => {
    balance(0, "PAID");
    post.mockRejectedValueOnce({
      response: { status: 409, data: { code: "WALK_IN_OPEN_CREDIT", message: "raw text" } },
    });
    mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This walk-in has open credit. Resolve it on the customer before handing over.",
    );
    expect(screen.queryByText(/raw text/)).toBeNull();
  });
});

describe("PickupCompleteDialog — tender rounding", () => {
  it("sends roundMoney(tendered) as the cash amount, like the till", async () => {
    balance(5);
    mount({ total: 5 });
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "10.005" } });
    confirm();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual({ payment: { method: "CASH", amount: 10.01 } });
  });
});

describe("PickupHandOverDialog — the held key survives close and reopen", () => {
  const order = { id: "o1", orderNumber: "ORD-1", total: 25, invoices: [], customer: {} } as never;
  const tree = (open: boolean) => (
    <QueryClientProvider client={qc}>
      <PickupHandOverDialog order={order} open={open} onClose={() => undefined} />
    </QueryClientProvider>
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const send = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
  };
  const keyOf = (i: number) => post.mock.calls[i][2].headers["Idempotency-Key"];

  it("an UNKNOWN outcome, Cancel, reopen: the retry carries the SAME key", async () => {
    post.mockRejectedValueOnce(new Error("Network Error"));
    const { rerender } = render(tree(true));
    await send();
    await screen.findByRole("alert");
    rerender(tree(false));
    rerender(tree(true));
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("a 5xx is unknown too", async () => {
    post.mockRejectedValueOnce({ response: { status: 503, data: {} } });
    const { rerender } = render(tree(true));
    await send();
    await screen.findByRole("alert");
    rerender(tree(false));
    rerender(tree(true));
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("a known success, then a fresh open: a NEW key", async () => {
    const { rerender } = render(tree(true));
    await send();
    await screen.findByRole("button", { name: "Done" });
    rerender(tree(false));
    rerender(tree(true));
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("a known 4xx failure clears the held key", async () => {
    post.mockRejectedValueOnce({ response: { status: 409, data: { code: "PICKUP_NOT_READY" } } });
    const { rerender } = render(tree(true));
    await send();
    await screen.findByRole("alert");
    rerender(tree(false));
    rerender(tree(true));
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });
});

describe("PickupHandOverDialog — the held key survives a reload (sessionStorage)", () => {
  const order = { id: "o1", orderNumber: "ORD-1", total: 25, invoices: [], customer: {} } as never;
  const fresh = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <PickupHandOverDialog order={order} open onClose={() => undefined} />
      </QueryClientProvider>
    );
  };
  const send = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
  };
  const keyOf = (i: number) => post.mock.calls[i][2].headers["Idempotency-Key"];
  const stored = () =>
    Object.keys(window.sessionStorage).filter((k) => k.startsWith("rf.pickup.heldKey:"));

  it("unknown outcome, remount (reload): the retry carries the SAME key", async () => {
    post.mockRejectedValueOnce(new Error("Network Error"));
    const first = render(fresh());
    await send();
    await screen.findByRole("alert");
    expect(stored()).toEqual(["rf.pickup.heldKey:acme:u-a:o1"]);
    first.unmount();
    render(fresh());
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("a known outcome clears the stored key", async () => {
    post.mockRejectedValueOnce(new Error("Network Error"));
    const first = render(fresh());
    await send();
    await screen.findByRole("alert");
    expect(stored()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    confirm();
    await screen.findByRole("button", { name: "Done" });
    expect(stored()).toHaveLength(0);
    first.unmount();
    render(fresh());
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it("a garbage stored value is ignored (a new key) and storage failures never throw", async () => {
    window.sessionStorage.setItem("rf.pickup.heldKey:acme:u-a:o1", "{not json");
    render(fresh());
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(keyOf(0)).toEqual(expect.any(String));
  });

  it("with no known tenant or user nothing is stored", async () => {
    authUser = { id: "u-a", tenantSlug: null };
    post.mockRejectedValueOnce(new Error("Network Error"));
    render(fresh());
    await send();
    await screen.findByRole("alert");
    expect(stored()).toHaveLength(0);
  });
});

describe("PickupCompleteDialog — the global error toast", () => {
  const toast = jest.fn();
  const mountWithToast = () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      mutationCache: new MutationCache({
        onError: (error, _v, _c, mutation) =>
          handleMutationError(error, mutation, toast, { push: jest.fn() }),
      }),
    });
    return render(
      <QueryClientProvider client={qc}>
        <PickupCompleteDialog
          open
          onClose={() => undefined}
          orderId="o1"
          total={25}
          invoices={[]}
          isWalkIn={false}
        />
      </QueryClientProvider>,
    );
  };

  it.each([
    "PICKUP_PAYMENT_REQUIRED",
    "COUNTER_TENDER_SHORT",
    "PICKUP_KEY_CONFLICT",
    "PICKUP_INVOICE_MISSING",
    "WALK_IN_OPEN_CREDIT",
    "WALK_IN_NO_ACCOUNT",
    "COUNTER_CHECK_NUMBER_REQUIRED",
    "PICKUP_NOT_READY",
    "PICKUP_ONLY",
    "COUNTER_SALE_DAY_CLOSED",
    "COUNTER_COMPLETE_SHIPPED",
    "COUNTER_COMPLETE_ON_RUN",
    "COUNTER_COMPLETE_STOP_STARTED",
    "COUNTER_COMPLETE_DAY_CLOSED",
    "COUNTER_COMPLETE_UNAVAILABLE",
    "ORDER_ON_ACTIVE_RUN",
    "ORDER_RUN_LINK_CHANGED",
  ])("%s: the dialog's own copy shows and NO global toast fires", async (code) => {
    toast.mockClear();
    post.mockRejectedValueOnce({ response: { status: 409, data: { code } } });
    mountWithToast();
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    await screen.findByRole("alert");
    expect(toast).not.toHaveBeenCalled();
  });

  it("an unhandled 500 keeps the existing global toast", async () => {
    toast.mockClear();
    post.mockRejectedValueOnce({ response: { status: 500, data: {} } });
    mountWithToast();
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    await screen.findByRole("alert");
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe("PickupCompleteDialog: SA-837b Record anyway on a duplicate payment reference", () => {
  const SENTENCE =
    "A payment with this reference was already recorded on Oct 1, 2026 for $25.00 (INV-0042).";
  const dupResult = () =>
    result({
      paymentRecorded: false,
      paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
      paymentCauseCode: "DUPLICATE_PAYMENT_REF",
      existingPayment: {
        id: "pay-1",
        paymentNumber: "PAY-A-0001",
        paidAt: "2026-10-01T12:00:00.000Z",
        amount: 25,
        invoiceId: "inv-9",
        invoiceNumber: "INV-0042",
      },
      paid: 0,
      balanceDue: 25,
    });

  it("names the existing payment and Record anyway reposts the SAME key and body with payment.recordAnyway", async () => {
    balance(25);
    post.mockResolvedValueOnce(dupResult());
    post.mockResolvedValueOnce(result());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    expect(await screen.findByText(SENTENCE)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Record anyway" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][2].headers["Idempotency-Key"]).toBe(
      post.mock.calls[0][2].headers["Idempotency-Key"],
    );
    expect(post.mock.calls[0][1].payment).not.toHaveProperty("recordAnyway");
    expect(post.mock.calls[1][1].payment).toEqual({
      ...post.mock.calls[0][1].payment,
      recordAnyway: true,
    });
  });

  it("a role that may not use the flag sees the sentence and no Record anyway", async () => {
    authUser = { id: "u-a", tenantSlug: "acme", role: "DRIVER" };
    balance(25);
    post.mockResolvedValueOnce(dupResult());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    expect(await screen.findByText(SENTENCE)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Record anyway" })).toBeNull();
  });
});

describe("PickupCompleteDialog: I-120 the hand-over's credit-over-limit line (SA-849 on the hand-over)", () => {
  const over = () =>
    result({
      paymentRecorded: false,
      paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
      paid: 0,
      balanceDue: 25,
      creditOverLimit: { limit: 20, exposure: 25 },
    });

  it("a netted tender that did not record: the one sentence inside the not-recorded state", async () => {
    balance(25);
    post.mockResolvedValueOnce(over());
    mount({ customerName: "Acme Co" });
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    expect(await screen.findByTestId("pickup-credit-over-limit")).toHaveTextContent(
      "Until this payment is recorded, Acme Co is over their credit limit ($25.00 of $20.00).",
    );
  });

  it("nothing without the field, and nothing once the payment is recorded", async () => {
    balance(25);
    post.mockResolvedValueOnce(result({ paymentRecorded: false, paid: 0, balanceDue: 25 }));
    mount({ customerName: "Acme Co" });
    fireEvent.click(await screen.findByRole("button", { name: "Card" }));
    confirm();
    expect(await screen.findByText("Payment not recorded")).toBeVisible();
    expect(screen.queryByTestId("pickup-credit-over-limit")).toBeNull();
  });
});

// W-775 (W-773's client half): a hand-over the API answers with 409 RESTRICTION_WARNING (nothing written, pre-judged before
// the claim) opens the warning dialog; "Sell anyway" re-sends the SAME hand-over (same key, same body) plus the
// acknowledgement; "Go back" leaves the dialog as it was. Head: the 409 was only a generic error line, no way to proceed.
const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "l:li1",
          productId: "p1",
          displayName: "Cola",
          outcome: "BLOCK",
          rules: [
            {
              id: "r1",
              states: ["CA"],
              legal: true,
              reasonText: "This product is banned in CA by law.",
            },
          ],
        },
      ],
    },
  },
};

describe("PickupCompleteDialog — W-775 restriction warning", () => {
  it("warns, then re-sends the same hand-over with the same key and the acknowledgement", async () => {
    const user = userEvent.setup();
    balance(0, "PAID");
    post.mockRejectedValueOnce(warning409);
    post.mockResolvedValueOnce(result());
    mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    expect(await screen.findByText("This product is banned in CA by law.")).toBeInTheDocument();
    // not the generic refusal line, and the hand-over is not held as an unknown outcome
    expect(screen.queryByRole("alert")).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    await user.type(screen.getByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const [first, second] = post.mock.calls;
    expect(second[2].headers["Idempotency-Key"]).toBe(first[2].headers["Idempotency-Key"]);
    expect(second[1]).toEqual({
      ...first[1],
      restrictionOverrides: [{ lineKey: "l:li1", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    });
  });

  it("Go back sends nothing more and shows no error", async () => {
    const user = userEvent.setup();
    balance(0, "PAID");
    post.mockRejectedValueOnce(warning409);
    mount();
    await screen.findByText("Paid — nothing to collect");
    confirm();
    await screen.findByText("This product is banned in CA by law.");
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("This product is banned in CA by law.")).toBeNull();
  });
});

describe("PickupCompleteDialog: W-778 complete-at-counter refusals (apple-ux 2026-10-24)", () => {
  const refuse = async (code: string, extra: Record<string, unknown> = {}) => {
    balance(25);
    post.mockRejectedValueOnce({ response: { status: 409, data: { code, ...extra } } });
    const utils = mount({ completeMode: true });
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    await screen.findByRole("alert");
    return utils;
  };

  // item 2 + MUST 1: a closed day asks for a reopen and promises no till link (the plain Reopen day has not landed)
  it("COUNTER_COMPLETE_DAY_CLOSED: asks a manager to reopen it and links nowhere", async () => {
    await refuse("COUNTER_COMPLETE_DAY_CLOSED");
    expect(screen.getByRole("alert")).toHaveTextContent("Ask a manager or owner to reopen it.");
    expect(screen.queryByRole("link", { name: "Open the till" })).toBeNull();
  });

  // item 6 + B-3: after a hard refusal nothing looks ready to retry
  it.each([
    "COUNTER_COMPLETE_DAY_CLOSED",
    "COUNTER_COMPLETE_STOP_STARTED",
    "COUNTER_COMPLETE_SHIPPED",
    "COUNTER_COMPLETE_UNAVAILABLE",
    "ORDER_ON_ACTIVE_RUN",
  ])(
    "%s: no Complete, the tender controls are disabled and Close is the one live action",
    async (code) => {
      const { onClose } = await refuse(code);
      expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
      expect(screen.getByRole("button", { name: "Cash" })).toBeDisabled();
      expect(screen.getByLabelText("Amount tendered")).toBeDisabled();
      expect(screen.queryByTestId("pickup-change-due")).toBeNull(); // W-778 wording: no "Change $X" beside "Nothing changed"
      expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2); // W-778: the header X + the footer's one live action
      fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
      expect(onClose).toHaveBeenCalled();
    },
  );

  // MUST 3: the run link changed under the dialog: Reload is the one live action (a footer Close would hide the stale page)
  it("ORDER_RUN_LINK_CHANGED: no Complete, controls locked, Reload is the only live action and refetches orders", async () => {
    const { onClose, invalidate } = await refuse("ORDER_RUN_LINK_CHANGED");
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cash" })).toBeDisabled();
    expect(screen.getByLabelText("Amount tendered")).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1); // only the header X: the footer action is Reload
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orders"] });
    expect(onClose).toHaveBeenCalledTimes(1); // Reload refetches, then closes
  });

  it("B-3: pressing a method after the refusal does not hide the error", async () => {
    await refuse("COUNTER_COMPLETE_DAY_CLOSED");
    fireEvent.click(screen.getByRole("button", { name: "Cash" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing changed.");
  });

  // item 7: the way out of a started stop
  it("COUNTER_COMPLETE_STOP_STARTED with a run id: links to the route", async () => {
    await refuse("COUNTER_COMPLETE_STOP_STARTED", { runId: "run-9" });
    expect(screen.getByRole("link", { name: "Open the route" })).toHaveAttribute(
      "href",
      "/routes/run-9",
    );
  });

  it("ORDER_ON_ACTIVE_RUN with a run id: links to the run it must come off", async () => {
    await refuse("ORDER_ON_ACTIVE_RUN", { runId: "run-4" });
    expect(screen.getByRole("link", { name: "Open the route" })).toHaveAttribute(
      "href",
      "/routes/run-4",
    );
  });

  it("COUNTER_COMPLETE_STOP_STARTED without a run id: no route link", async () => {
    await refuse("COUNTER_COMPLETE_STOP_STARTED");
    expect(screen.queryByRole("link", { name: "Open the route" })).toBeNull();
  });

  // item 8: the run confirm is a warning the clerk can answer, not an error
  it("COUNTER_COMPLETE_ON_RUN: amber warning, no 'Nothing changed', the confirm stays live", async () => {
    await refuse("COUNTER_COMPLETE_ON_RUN", { driverName: "Sam" });
    const box = screen.getByRole("alert");
    expect(box).toHaveTextContent("This order is on Sam's run.");
    expect(box).not.toHaveTextContent("Nothing changed");
    expect(box.className).toMatch(/amber/);
    expect(box.className).not.toMatch(/danger/);
    expect(screen.getByRole("button", { name: "Take off run and complete" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cash" })).toBeEnabled();
  });

  // item 5 + B-2: the short-cash line is live
  it("a short cash amount shows 'Enter at least' as it is typed, and clears when enough", async () => {
    balance(25);
    mount({ completeMode: true });
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    const amount = screen.getByLabelText("Amount tendered");
    fireEvent.change(amount, { target: { value: "3" } });
    expect(screen.getByTestId("pickup-short-hint")).toHaveTextContent("Enter at least $25.00.");
    fireEvent.change(amount, { target: { value: "30" } });
    expect(screen.queryByTestId("pickup-short-hint")).toBeNull();
  });

  it("B-2: a stale 'Enter at least' error from an empty Complete goes when an amount is chosen", async () => {
    balance(25);
    mount({ completeMode: true });
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter at least $25.00.");
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "50" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
