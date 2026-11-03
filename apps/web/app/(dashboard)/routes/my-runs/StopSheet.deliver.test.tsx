import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { StopSheet } from "./StopSheet";
import type { RouteRunStop, RunStopLine } from "@/lib/api/routes";

const post = jest.fn();
const patch = jest.fn().mockResolvedValue({ data: {} });
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    get: jest.fn(),
  },
}));

/**
 * SA-1098 PR-2 rows D-1, D-2, D-5, D-7, D-8, D-10, D-12, D-13, D-14, D-20 (the driver's stop on the web). The request goes through the
 * real hook, key store and shared `buildStopDeliveries`; only the HTTP client is mocked.
 */
const line = (
  id: string,
  name: string,
  qty: number,
  over: Partial<RunStopLine> = {},
): RunStopLine => ({
  id,
  productId: `p-${id}`,
  product: { id: `p-${id}`, name },
  qty,
  remaining: qty,
  status: "CONFIRMED",
  subtotal: qty * 2,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  ...over,
});

const STOP = (over: Partial<RouteRunStop> = {}): RouteRunStop => ({
  id: "stop-1",
  stopNumber: 1,
  customerId: "cust-1",
  customer: { id: "cust-1", businessName: "Acme Diner", contactName: "Pat", phone: "555-0100" },
  customerAddress: { line1: "123 Main St", city: "Springfield", state: "IL" },
  status: "IN_PROGRESS",
  orders: [
    {
      id: "o1",
      orderNumber: "SO-1001",
      status: "OUT_FOR_DELIVERY",
      lineItems: [line("l1", "Napkins", 10), line("l2", "Cups", 4)],
    },
    {
      id: "o2",
      orderNumber: "SO-1002",
      status: "OUT_FOR_DELIVERY",
      lineItems: [line("l3", "Lids", 6)],
    },
  ],
  ...over,
});

const body = () =>
  post.mock.calls[0][1] as { deliveries: any[]; driverNote?: string; payment?: unknown };
const headers = (i = 0) => post.mock.calls[i][2].headers as Record<string, string>;
const URL = "/route-runs/run-1/stops/stop-1/complete-with-payment";

describe("StopSheet: Delivered and Refused (SA-1098 PR-2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    post.mockResolvedValue({ data: {} });
    jest.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("D-1: Delivered sends one explicit entry for EVERY line of BOTH orders, no payment, with an Idempotency-Key", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Delivered" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe(URL);
    expect(body().deliveries).toEqual([
      { orderItemId: "l1", productId: "p-l1", type: "DELIVERED", quantityDelivered: 10 },
      { orderItemId: "l2", productId: "p-l2", type: "DELIVERED", quantityDelivered: 4 },
      { orderItemId: "l3", productId: "p-l3", type: "DELIVERED", quantityDelivered: 6 },
    ]);
    expect(body()).not.toHaveProperty("payment"); // D-20
    expect(headers()["Idempotency-Key"]).toMatch(/^stop-stop-1-/);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("D-1b: a short delivery is a changed quantity: PARTIAL at 7 of 10, the others untouched", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    const qty = screen.getByRole("spinbutton", { name: "Delivered Napkins" });
    await user.clear(qty);
    await user.type(qty, "7");
    await user.click(screen.getByRole("button", { name: "Delivered" }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(body().deliveries.map((d) => [d.orderItemId, d.type, d.quantityDelivered])).toEqual([
      ["l1", "PARTIAL", 7],
      ["l2", "DELIVERED", 4],
      ["l3", "DELIVERED", 6],
    ]);
  });

  it("D-1c: a typed quantity above what is left is held at what is left (no way to send more)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    const qty = screen.getByRole("spinbutton", { name: "Delivered Napkins" });
    await user.clear(qty);
    await user.type(qty, "99");

    expect(qty).toHaveValue(10);
  });

  it("D-2: Refused needs a reason, then sends EVERY line of every order REFUSED at 0 with the reason as the note", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "Refused" }));
    const confirm = screen.getByRole("button", { name: "Confirm refusal" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("Why was it refused?"), "Store was closed");
    await user.click(confirm);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(body().deliveries).toEqual([
      { orderItemId: "l1", productId: "p-l1", type: "REFUSED", quantityDelivered: 0 },
      { orderItemId: "l2", productId: "p-l2", type: "REFUSED", quantityDelivered: 0 },
      { orderItemId: "l3", productId: "p-l3", type: "REFUSED", quantityDelivered: 0 },
    ]);
    expect(body().driverNote).toBe("Store was closed");
    expect(body()).not.toHaveProperty("payment");
  });

  it("D-5: a Case line moves a whole Case at a time: 2 Cases of 24, one fewer sends 24, never 23", async () => {
    const user = userEvent.setup();
    const cases = line("l9", "Water", 48, {
      boxes: 2,
      unitsPerBox: 24,
      unitLabel: "Case",
      subtotal: 96,
    });
    renderWithProviders(
      <StopSheet
        stop={STOP({
          orders: [
            { id: "o9", orderNumber: "SO-1009", status: "OUT_FOR_DELIVERY", lineItems: [cases] },
          ],
        })}
        runId="run-1"
        onClose={jest.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Fewer Water" }));
    await user.click(screen.getByRole("button", { name: "Delivered" }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(body().deliveries).toEqual([
      { orderItemId: "l9", productId: "p-l9", type: "PARTIAL", quantityDelivered: 24 },
    ]);
  });

  it("D-6: a later visit starts at what is LEFT (remaining 7 of 10), not the ordered 10", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <StopSheet
        stop={STOP({
          orders: [
            {
              id: "o1",
              orderNumber: "SO-1001",
              status: "OUT_FOR_DELIVERY",
              lineItems: [line("l1", "Napkins", 10, { remaining: 7, deliveredSoFar: 3 })],
            },
          ],
        })}
        runId="run-1"
        onClose={jest.fn()}
      />,
    );

    expect(screen.getByRole("spinbutton", { name: "Delivered Napkins" })).toHaveValue(7);
    await user.click(screen.getByRole("button", { name: "Delivered" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(body().deliveries[0]).toMatchObject({ type: "DELIVERED", quantityDelivered: 7 });
  });

  it("D-7: a cancelled line is never sent as delivered", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <StopSheet
        stop={STOP({
          orders: [
            {
              id: "o1",
              orderNumber: "SO-1001",
              status: "OUT_FOR_DELIVERY",
              lineItems: [
                line("l1", "Napkins", 10),
                line("lx", "Straws", 5, { status: "CANCELLED", remaining: 0 }),
              ],
            },
          ],
        })}
        runId="run-1"
        onClose={jest.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delivered" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(body().deliveries.map((d) => d.orderItemId)).toEqual(["l1"]);
  });

  it("D-8: a double tap sends ONE completion", async () => {
    let resolve: (v: unknown) => void = () => {};
    post.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    const button = screen.getByRole("button", { name: "Delivered" });
    await user.click(button);
    await user.click(button);

    expect(post).toHaveBeenCalledTimes(1);
    resolve({ data: {} });
  });

  it("D-10: a lost response keeps the key; the retry (and a reloaded tab) sends the SAME key; success releases it", async () => {
    post.mockRejectedValueOnce({ message: "Network Error" }).mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    const first = renderWithProviders(
      <StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Delivered" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const kept = headers(0)["Idempotency-Key"];
    expect(window.sessionStorage.getItem("rf-stop-key:stop-1")).toBe(kept);

    first.unmount(); // a reloaded tab: the key is read back from sessionStorage
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Delivered" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(headers(1)["Idempotency-Key"]).toBe(kept);
    await waitFor(() => expect(window.sessionStorage.getItem("rf-stop-key:stop-1")).toBeNull());
  });

  it("D-10b: a refusal the server answered releases the key (the next attempt is a new request)", async () => {
    post.mockRejectedValueOnce({
      response: { status: 400, data: { message: "Only 7 left to deliver." } },
    });
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delivered" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only 7 left to deliver.");
    expect(window.sessionStorage.getItem("rf-stop-key:stop-1")).toBeNull();
  });

  it("D-12: a refetch (a new stop object, same ids) keeps the typed quantity and the reason", async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);
    const qty = screen.getByRole("spinbutton", { name: "Delivered Napkins" });
    await user.clear(qty);
    await user.type(qty, "7");

    view.rerender(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);
    expect(screen.getByRole("spinbutton", { name: "Delivered Napkins" })).toHaveValue(7);

    await user.click(screen.getByRole("button", { name: "Refused" }));
    await user.type(screen.getByLabelText("Why was it refused?"), "Closed");
    view.rerender(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);
    expect(screen.getByLabelText("Why was it refused?")).toHaveValue("Closed");
  });

  it("D-14: a regulated stop's coded refusal reads as one plain line", async () => {
    post.mockRejectedValueOnce({
      response: {
        status: 400,
        data: { code: "REGULATED_POD_REQUIRED", message: "raw server text" },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delivered" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This stop needs a signature and an ID check. Call your office.",
    );
  });

  it("D-13: Undo on a completed stop POSTs /reopen after asking", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderWithProviders(
      <StopSheet stop={STOP({ status: "COMPLETED" })} runId="run-1" onClose={onClose} />,
    );

    expect(screen.queryByRole("button", { name: "Delivered" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(post).toHaveBeenCalledWith("/route-runs/run-1/stops/stop-1/reopen"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("D-13b: Undo refused for confirmed money shows the server's words", async () => {
    post.mockRejectedValueOnce({
      response: {
        status: 400,
        data: { message: "This stop has a confirmed payment. Ask your office." },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(
      <StopSheet stop={STOP({ status: "COMPLETED" })} runId="run-1" onClose={jest.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("confirmed payment");
  });

  it("D-11: a 403 (another driver's run, or the run is not in progress) says the stop changed", async () => {
    post.mockRejectedValueOnce({
      response: { status: 403, data: { message: "You do not have access" } },
    });
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "Delivered" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This stop changed.");
  });

  it("while the run has not started there are no Delivered / Refused buttons, only a pointer to Start route", () => {
    renderWithProviders(
      <StopSheet
        stop={STOP({ status: "PENDING" })}
        runId="run-1"
        runStatus="SCHEDULED"
        onClose={jest.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Delivered" })).not.toBeInTheDocument();
    expect(screen.getByText("Start the route to record this stop.")).toBeInTheDocument();
  });

  it("offline: Delivered and Refused are disabled and nothing is queued", async () => {
    jest.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Delivered" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refused" })).toBeDisabled();
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("order lines not served: Delivered stays disabled (no completion is built from nothing)", () => {
    renderWithProviders(
      <StopSheet
        stop={STOP({ orders: [{ id: "o1", orderNumber: "SO-1001", status: "OUT_FOR_DELIVERY" }] })}
        runId="run-1"
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Delivered" })).toBeDisabled();
    expect(within(screen.getByRole("dialog")).getByText(/still loading/)).toBeInTheDocument();
  });
});
