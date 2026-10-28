import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import ReturnDetailPage from "./page";
import type { Return } from "@/lib/api/returns";

/**
 * SA-1042 B9c. G-w4 (rule 11): the detail page shows a line item in its own unit, "200 pcs (1 Case)", and a pooled item with
 * "pcs". G-w5 / B976 (rule 12): the refund preview's UNIT_UNRESOLVED shows the mixed-unit copy, not "No refundable amount".
 */
jest.mock("next/navigation", () => ({ useParams: () => ({ id: "ret-1" }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));

let mockReturn: Return | undefined;
jest.mock("@/lib/api/returns", () => ({
  useReturn: () => ({ data: mockReturn, isLoading: false, isError: false }),
  useApproveReturn: () => ({ mutate: jest.fn(), isPending: false }),
  useRejectReturn: () => ({ mutate: jest.fn(), isPending: false }),
  useMarkReturnInTransit: () => ({ mutate: jest.fn(), isPending: false }),
  useMarkReturnReceived: () => ({ mutate: jest.fn(), isPending: false }),
  useProcessRefund: () => ({ mutate: jest.fn(), isPending: false }),
  useCancelReturn: () => ({ mutate: jest.fn(), isPending: false }),
}));

const base = {
  id: "ret-1",
  returnNumber: "R-200",
  kind: "STANDARD",
  customerId: "c1",
  orderId: "o1",
  reason: "DAMAGED",
  notes: "",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
} as unknown as Return;

describe("return detail: what each returned line counts (SA-1042 B9c)", () => {
  it("G-w5 (B976): a UNIT_UNRESOLVED preview shows the mixed-unit copy in the Resolve dialog", async () => {
    mockReturn = {
      ...base,
      status: "RECEIVED",
      items: [],
      refundEstimate: 0,
      refundEstimateReason: "UNIT_UNRESOLVED",
    } as unknown as Return;
    renderWithProviders(<ReturnDetailPage />);
    await userEvent.click(screen.getAllByRole("button", { name: /resolve/i })[0]);
    expect(await screen.findByText(/sold in different units on this order/i)).toBeInTheDocument();
    expect(screen.queryByText("No refundable amount")).toBeNull();
  });
});
