import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import type { Estimate, EstimateStatus } from "@/lib/api/estimates";
import EstimateDetailPage from "./page";

// A boxed estimate line carries qty = PIECES and unitPrice = the BOX price. When the payload has no
// stored line subtotal the detail page used to fall back to `qty * unitPrice`, billing one 24-pack
// at $12.90 as 24 x $12.90 = $309.60 (money rule: never re-derive qty*unitPrice for a boxed line).

function makeEstimate(item: Record<string, unknown>): Estimate {
  return {
    id: "est-1",
    estimateNumber: "EST-0001",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Foods", contactName: "Jane" },
    status: "DRAFT" as EstimateStatus,
    issueDate: "2026-01-01",
    expiresAt: "2026-02-01",
    subtotal: 12.9,
    taxAmount: 0,
    total: 12.9,
    notes: undefined,
    items: [{ id: "item-1", description: "Case of widgets", ...item } as any],
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
  } as Estimate;
}

let current: Estimate = makeEstimate({});
const mockUseEstimate = jest.fn((..._args: unknown[]) => ({
  data: current,
  isLoading: false,
  isError: false,
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "est-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimate: (...args: unknown[]) => mockUseEstimate(...args),
  useSendEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useAcceptEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useDeclineEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useConvertEstimateToInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useVoidEstimate: () => ({ mutate: jest.fn(), isPending: false }),
}));

function lineAmountCell(): HTMLElement {
  const row = screen.getByText("Case of widgets").closest("tr") as HTMLElement;
  const cells = within(row).getAllByRole("cell");
  return cells[cells.length - 1];
}

describe("EstimateDetailPage — line amount fallback is boxed-aware", () => {
  it("one box of 24 @ $12.90 (no stored subtotal) shows $12.90, never $309.60", () => {
    current = makeEstimate({ qty: 24, unitPrice: 12.9, boxes: 1, pieces: 0, unitsPerBox: 24 });
    renderWithProviders(<EstimateDetailPage />);
    expect(lineAmountCell()).toHaveTextContent("$12.90");
    expect(lineAmountCell()).not.toHaveTextContent("$309.60");
  });

  it("a stored subtotal is still authoritative", () => {
    current = makeEstimate({
      qty: 24,
      unitPrice: 12.9,
      boxes: 1,
      pieces: 0,
      unitsPerBox: 24,
      subtotal: 11.5,
    });
    renderWithProviders(<EstimateDetailPage />);
    expect(lineAmountCell()).toHaveTextContent("$11.50");
  });

  it("a non-boxed line without a stored subtotal is still qty x unitPrice", () => {
    current = makeEstimate({ qty: 3, unitPrice: 2.5 });
    renderWithProviders(<EstimateDetailPage />);
    expect(lineAmountCell()).toHaveTextContent("$7.50");
  });
});
