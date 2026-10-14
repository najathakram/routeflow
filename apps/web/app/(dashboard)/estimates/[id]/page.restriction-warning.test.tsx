import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, act } from "@/test-utils/render";
import type { Estimate, EstimateStatus } from "@/lib/api/estimates";
import EstimateDetailPage from "./page";

/** Row 510: converting an estimate creates an invoice, which is judged; a 409 RESTRICTION_WARNING opens the dialog. */
const estimate = {
  id: "est-1",
  estimateNumber: "EST-0001",
  customerId: "cust-1",
  customer: { id: "cust-1", businessName: "Acme Foods", contactName: "Jane" },
  status: "ACCEPTED" as EstimateStatus,
  issueDate: "2026-01-01",
  expiresAt: "2026-02-01",
  subtotal: 100,
  taxAmount: 8,
  total: 108,
  items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 100, subtotal: 100 }],
  createdAt: new Date("2026-01-01").toISOString(),
  updatedAt: new Date("2026-01-01").toISOString(),
} as unknown as Estimate;

const convertMutate = jest.fn();
const toastMock = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "est-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimate: () => ({ data: estimate, isLoading: false, isError: false }),
  useSendEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useAcceptEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useDeclineEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useConvertEstimateToInvoice: () => ({ mutate: convertMutate, isPending: false }),
  useVoidEstimate: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: toastMock, dismiss: jest.fn() }),
}));

const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "l:item-1",
          productId: "p1",
          displayName: "Widget",
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

describe("EstimateDetailPage: row 510 convert warning", () => {
  beforeEach(() => jest.clearAllMocks());

  it("warns, then re-sends the convert with the ack", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateDetailPage />);
    await user.click(screen.getAllByRole("button", { name: /convert to invoice/i })[0]);
    expect(convertMutate).toHaveBeenCalledTimes(1);
    expect(convertMutate.mock.calls[0][0]).toBe("est-1"); // the bare id, unchanged
    act(() => convertMutate.mock.calls[0][1].onError(warning409));
    await user.type(await screen.findByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    expect(convertMutate).toHaveBeenCalledTimes(2);
    expect(convertMutate.mock.calls[1][0]).toEqual({
      id: "est-1",
      restrictionOverrides: [{ lineKey: "l:item-1", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    });
    expect(toastMock).not.toHaveBeenCalled(); // not the "Failed to convert estimate" toast
  });
});
