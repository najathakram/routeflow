import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PickupCompleteDialog } from "./PickupCompleteDialog";

/**
 * Order ahead: "Picked up" hands a PICKUP order over (POST /orders/:id/pickup-complete). One
 * Idempotency-Key per dialog open, kept across retries; a paid order has no tender step; the tender
 * rules are the till's (validatePayment, change, check number); a payment that was not recorded is
 * retried under the SAME key.
 */
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

describe("PickupCompleteDialog — tender", () => {
  it("cash: a short tender is refused with the till's copy and nothing is posted", async () => {
    balance(25);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cash" }));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "10" } });
    confirm();
    expect(await screen.findByText("The amount tendered is less than the total.")).toBeVisible();
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

  it("a walk-in cannot be charged on account", async () => {
    balance(25);
    mount({ isWalkIn: true });
    expect(await screen.findByRole("button", { name: "On account" })).toBeDisabled();
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
