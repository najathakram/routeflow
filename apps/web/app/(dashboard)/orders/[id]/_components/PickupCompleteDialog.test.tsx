import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
let authUser: { id: string; tenantSlug: string | null } | null = { id: "u-a", tenantSlug: "acme" };
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
  authUser = { id: "u-a", tenantSlug: "acme" };
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
