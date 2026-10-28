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

const item = (over: Record<string, unknown>) => ({
  id: "i1",
  productId: "p-1",
  product: { id: "p-1", name: "Cola" },
  orderedQty: 400,
  qty: 200,
  ...over,
});

describe("return detail: what each returned line counts (SA-1042 B9c)", () => {
  it("G-w4: a line item reads in the line's own unit, a pooled item with pcs", () => {
    mockReturn = {
      ...base,
      status: "PENDING",
      items: [
        item({ id: "i1", line: { unitLabel: "Case", unitsPerBox: 200, boxes: 2, qty: 400 } }),
        item({
          id: "i2",
          product: { id: "p-2", name: "Chips" },
          productId: "p-2",
          orderedQty: 500,
          line: null,
        }),
      ],
    } as unknown as Return;
    renderWithProviders(<ReturnDetailPage />);
    const row = (name: string) =>
      screen.getAllByRole("row").find((r) => within(r).queryByText(name))!;
    expect(row("Cola").textContent).toContain("200 pcs (1 Case)");
    expect(row("Cola").textContent).toContain("400 pcs (2 Cases)"); // ordered, from the same line
    expect(row("Chips").textContent).toContain("200 pcs");
    expect(row("Chips").textContent).not.toContain("(");
  });

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
