import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import type { Estimate, EstimateStatus } from "@/lib/api/estimates";
import EstimateDetailPage from "./page";

// B1387 (SA-1286): a boxed estimate line stores qty = PIECES and unitPrice = the BOX price. The Qty
// cell printed the raw piece count ("36") beside "$18.00" a box, which reads as $648; the Amount
// ($54.00) was always right. The cell now goes through the shared invoiceLineQtyText.

function makeEstimate(item: Record<string, unknown>): Estimate {
  return {
    id: "est-1",
    estimateNumber: "EST-0001",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Foods", contactName: "Jane" },
    status: "DRAFT" as EstimateStatus,
    issueDate: "2026-01-01",
    expiresAt: "2026-02-01",
    subtotal: 54,
    taxAmount: 0,
    total: 54,
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

function cells(): HTMLElement[] {
  const row = screen.getByText("Case of widgets").closest("tr") as HTMLElement;
  return within(row).getAllByRole("cell");
}

const BOXED = { qty: 36, unitPrice: 18, boxes: 3, pieces: 0, unitsPerBox: 12, subtotal: 54 };

describe("EstimateDetailPage - qty cell counts boxes beside a box price (B1387)", () => {
  it('3 boxes of 12 at $18.00 reads "3 boxes", never "36"; Amount stays $54.00', () => {
    current = makeEstimate(BOXED);
    renderWithProviders(<EstimateDetailPage />);
    expect(cells()[1]).toHaveTextContent("3 boxes");
    expect(cells()[1]).not.toHaveTextContent("36");
    expect(cells()[3]).toHaveTextContent("$54.00");
  });

  it("a line with no split still reads the plain qty", () => {
    current = makeEstimate({ qty: 3, unitPrice: 2.5, subtotal: 7.5 });
    renderWithProviders(<EstimateDetailPage />);
    expect(cells()[1].textContent).toBe("3");
  });

  it('a unitLabel "Case" line reads "3 Cases"', () => {
    current = makeEstimate({ ...BOXED, unitLabel: "Case" });
    renderWithProviders(<EstimateDetailPage />);
    expect(cells()[1]).toHaveTextContent("3 Cases");
  });
});
