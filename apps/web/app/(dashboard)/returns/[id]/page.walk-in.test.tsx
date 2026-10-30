import * as React from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import ReturnDetailPage from "./page";
import type { Return } from "@/lib/api/returns";

/**
 * W-913 (SA-932 §B): a walk-in return is refunded at the till, never given as store credit. The server refuses the credit
 * note (409 WALK_IN_STORE_CREDIT_REFUSED); this page must not default to it or offer it. A named customer keeps both options
 * and the store-credit default.
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

async function openResolve(isWalkIn: boolean | null | undefined) {
  mockReturn = {
    ...received,
    order: { id: "o1", orderNumber: "ORD-1", counterSale: true },
    customer: { id: "c1", businessName: "Acme Counter", isWalkIn },
  } as unknown as Return;
  renderWithProviders(<ReturnDetailPage />);
  fireEvent.click(screen.getAllByRole("button", { name: /^resolve/i })[0]);
  return await screen.findByRole("dialog");
}

beforeEach(() => processMutate.mockClear());

describe("Resolve Return on a walk-in sale (W-913)", () => {
  it("defaults to the refund and does not offer store credit", async () => {
    const dialog = await openResolve(true);
    expect(within(dialog).queryByRole("radio", { name: /store credit/i })).toBeNull();
    expect(within(dialog).getByRole("radio", { name: /refund \(cash/i })).toBeChecked();
    expect(within(dialog).getByLabelText(/refund by/i)).toBeInTheDocument();
  });

  it("resolves as a recorded refund with the tender chosen, never as a credit note", async () => {
    const dialog = await openResolve(true);
    fireEvent.change(within(dialog).getByLabelText(/refund by/i), { target: { value: "CASH" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve Return" }));
    expect(processMutate).toHaveBeenCalledTimes(1);
    expect(processMutate.mock.calls[0][0]).toEqual({
      id: "ret-1",
      method: "EXTERNAL_REFUND",
      tender: "CASH",
    });
  });
});

describe("Resolve Return on a named customer's sale is unchanged", () => {
  it.each([
    ["isWalkIn false", false],
    ["isWalkIn null (every legacy row)", null],
    ["isWalkIn absent", undefined],
  ])("%s: store credit is offered and is the default", async (_n, flag) => {
    const dialog = await openResolve(flag);
    expect(within(dialog).getByRole("radio", { name: /store credit/i })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /refund \(cash/i })).not.toBeChecked();
  });
});
