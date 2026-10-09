import * as React from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import ReturnDetailPage from "./page";
import type { Return } from "@/lib/api/returns";

/**
 * SA-740r2 item 4: the STANDARD return's "Refund (cash / card / check)" resolution takes an OPTIONAL tender (the server stores it
 * in Return.refundTender). The select appears ONLY for that option; store credit never sends one; leaving it unset sends none
 * (the day's tenderKnown stays false). The old "refunded outside RouteFlow" wording is gone.
 */
jest.mock("next/navigation", () => ({ useParams: () => ({ id: "ret-1" }) }));

const processMutate = jest.fn();
let mockReturn: Return | undefined;
jest.mock("@/lib/api/returns", () => ({
  useReturn: () => ({ data: mockReturn, isLoading: false, isError: false }),
  useApproveReturn: () => ({ mutate: jest.fn(), isPending: false }),
  useRejectReturn: () => ({ mutate: jest.fn(), isPending: false }),
  useMarkReturnInTransit: () => ({ mutate: jest.fn(), isPending: false }),
  useMarkReturnReceived: () => ({ mutate: jest.fn(), isPending: false }),
  useProcessRefund: () => ({ mutate: processMutate, isPending: false }),
  useCancelReturn: () => ({ mutate: jest.fn(), isPending: false }),
}));

const received = {
  id: "ret-1",
  returnNumber: "R-100",
  customerId: "c1",
  orderId: "o1",
  reason: "DAMAGED",
  notes: "",
  items: [],
  kind: "STANDARD",
  status: "RECEIVED",
  refundEstimate: 24,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
} as unknown as Return;

async function openResolve() {
  mockReturn = received;
  renderWithProviders(<ReturnDetailPage />);
  fireEvent.click(screen.getAllByRole("button", { name: /^resolve/i })[0]);
  return await screen.findByRole("dialog");
}

beforeEach(() => processMutate.mockClear());

describe("Resolve Return: the refund tender (SA-740r2)", () => {
  it("names the option 'Refund (cash / card / check)', never 'outside RouteFlow'", async () => {
    const dialog = await openResolve();
    expect(within(dialog).getByText(/Refund \(cash \/ card \/ check\)/)).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/outside RouteFlow/i);
  });

  it("the tender select appears only once the refund option is chosen", async () => {
    const dialog = await openResolve();
    expect(within(dialog).queryByLabelText(/refunded by|refund by/i)).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: /refund \(cash/i }));
    expect(within(dialog).getByLabelText(/refund by/i)).toBeInTheDocument();
  });

  it("sends the chosen tender with EXTERNAL_REFUND", async () => {
    const dialog = await openResolve();
    fireEvent.click(within(dialog).getByRole("radio", { name: /refund \(cash/i }));
    fireEvent.change(within(dialog).getByLabelText(/refund by/i), { target: { value: "CARD" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve Return" }));
    expect(processMutate).toHaveBeenCalledTimes(1);
    expect(processMutate.mock.calls[0][0]).toEqual({
      id: "ret-1",
      method: "EXTERNAL_REFUND",
      tender: "CARD",
    });
  });

  it("an unset tender sends none (optional until the mobile minimum moves)", async () => {
    const dialog = await openResolve();
    fireEvent.click(within(dialog).getByRole("radio", { name: /refund \(cash/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve Return" }));
    expect(processMutate.mock.calls[0][0]).toEqual({ id: "ret-1", method: "EXTERNAL_REFUND" });
  });

  it("store credit never sends a tender, even after one was picked and the option switched back", async () => {
    const dialog = await openResolve();
    fireEvent.click(within(dialog).getByRole("radio", { name: /refund \(cash/i }));
    fireEvent.change(within(dialog).getByLabelText(/refund by/i), { target: { value: "CHECK" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /store credit/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve Return" }));
    expect(processMutate.mock.calls[0][0]).toEqual({ id: "ret-1", method: "CREDIT_NOTE" });
  });
});
