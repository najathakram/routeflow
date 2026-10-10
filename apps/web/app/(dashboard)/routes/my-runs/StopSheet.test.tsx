import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { StopSheet } from "./StopSheet";
import type { RouteRunStop } from "@/lib/api/routes";

const patch = jest.fn().mockResolvedValue({ data: {} });
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { patch: (...a: unknown[]) => patch(...a), get: jest.fn() },
}));

const STOP = (over: Partial<RouteRunStop> = {}): RouteRunStop => ({
  id: "stop-1",
  stopNumber: 1,
  customerId: "cust-1",
  customer: { id: "cust-1", businessName: "Acme Diner", contactName: "Pat", phone: "555-0100" },
  customerAddress: { line1: "123 Main St", city: "Springfield", state: "IL" },
  status: "PENDING",
  orders: [{ id: "o1", orderNumber: "SO-1001", status: "CONFIRMED" }],
  ...over,
});

/**
 * PHASE 1a — red-first pins for the stop sheet: Start/Skip call the right
 * endpoint with the right status, Skip confirms first, and the 1b slot is a
 * real (disabled) placeholder rather than a working money-collecting flow.
 */
describe("StopSheet (PHASE 1a)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, "confirm").mockReturnValue(true);
    jest.spyOn(window, "open").mockImplementation(() => null);
  });

  it("renders nothing (Modal closed) when stop is null", () => {
    renderWithProviders(<StopSheet stop={null} runId="run-1" onClose={jest.fn()} />);
    expect(screen.queryByText("Acme Diner")).not.toBeInTheDocument();
  });

  it("shows the customer, address, and READ-ONLY order lines", () => {
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);
    expect(screen.getByText("Acme Diner")).toBeInTheDocument();
    expect(screen.getByText("123 Main St, Springfield, IL")).toBeInTheDocument();
    expect(screen.getByText("SO-1001")).toBeInTheDocument();
  });

  it("REG-1a: Start stop PATCHes /route-runs/:id/stops/:stopId with status IN_PROGRESS", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Start stop" }));

    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith("/route-runs/run-1/stops/stop-1", {
        status: "IN_PROGRESS",
        driverNote: undefined,
      });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("REG-1a: Skip asks for confirmation before PATCHing status SKIPPED", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Acme Diner"));
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith("/route-runs/run-1/stops/stop-1", {
        status: "SKIPPED",
        driverNote: undefined,
      });
    });
  });

  it("REG-1a: while a status call is in flight BOTH Start and Skip are disabled (no double PATCH)", async () => {
    let resolvePatch: (v: unknown) => void = () => {};
    patch.mockImplementationOnce(() => new Promise((res) => (resolvePatch = res)));
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "Start stop" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Start stop/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /Skip/ })).toBeDisabled();
    });
    expect(patch).toHaveBeenCalledTimes(1);
    resolvePatch({ data: {} });
  });

  it("REG-1a: Skip is a no-op when the confirm dialog is declined", async () => {
    (window.confirm as jest.Mock).mockReturnValue(false);
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(patch).not.toHaveBeenCalled();
  });

  it("REG-1a: Call has no phone to dial when the customer has none (renders disabled, not a tel: link)", () => {
    renderWithProviders(
      <StopSheet
        stop={STOP({ customer: { id: "cust-1", businessName: "Acme Diner", contactName: "Pat" } })}
        runId="run-1"
        onClose={jest.fn()}
      />,
    );
    // No href -> Button falls back to its disabled <button> branch, not an <a>.
    expect(screen.queryByRole("link", { name: "Call" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Call" })).toBeDisabled();
  });

  it("REG-1a: Call links to tel: with the customer's phone when present", () => {
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);
    expect(screen.getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:555-0100");
  });

  it("REG-1a: Navigate opens a maps search in a new tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: "Navigate" }));

    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("Acme Diner, 123 Main St, Springfield, IL")),
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("REG-1a: the 1b money-collecting slot is a disabled placeholder, not a working action", () => {
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);
    expect(
      screen.getByRole("button", { name: "Delivered / Refused / Collect payment" }),
    ).toBeDisabled();
  });

  it("REG-1a: 'Finish in the app' links to the driver app's login screen", () => {
    renderWithProviders(<StopSheet stop={STOP()} runId="run-1" onClose={jest.fn()} />);
    expect(screen.getByRole("link", { name: /finish in the app/i })).toHaveAttribute(
      "href",
      "https://routeflowmobile-production.up.railway.app/login",
    );
  });

  it("REG-1a: Start stop is disabled once the stop is no longer PENDING", () => {
    renderWithProviders(
      <StopSheet stop={STOP({ status: "IN_PROGRESS" })} runId="run-1" onClose={jest.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Start stop" })).toBeDisabled();
  });

  it("REG-1a: Skip is disabled once the stop is already COMPLETED or SKIPPED", () => {
    renderWithProviders(
      <StopSheet stop={STOP({ status: "COMPLETED" })} runId="run-1" onClose={jest.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled();
  });
});
