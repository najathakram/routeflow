import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import type { Estimate, EstimateStatus } from "@/lib/api/estimates";
import EstimateDetailPage from "./page";

function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
  return {
    id: "est-1",
    estimateNumber: "EST-0001",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Foods", contactName: "Jane" },
    status: "DRAFT" as EstimateStatus,
    issueDate: "2026-01-01",
    expiresAt: "2026-02-01",
    subtotal: 100,
    taxAmount: 8,
    total: 108,
    notes: undefined,
    items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 100, subtotal: 100 } as any],
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
    ...overrides,
  };
}

// The owner's gaps (2026-11-19): a draft has Edit, a sent or accepted quote goes Back to draft, a converted one links
// its invoice and cannot be voided.
let mockEstimate = makeEstimate();
const mockRevert = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "est-1" }),
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/estimates/est-1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimate: () => ({ data: mockEstimate, isLoading: false, isError: false }),
  useSendEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useAcceptEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useDeclineEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useConvertEstimateToInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useVoidEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useRevertEstimateToDraft: () => ({ mutate: mockRevert, isPending: false }),
  useUpdateEstimate: () => ({ mutate: jest.fn(), isPending: false }),
}));

const show = (over: Partial<Estimate>) => {
  mockEstimate = makeEstimate(over);
  return renderWithProviders(<EstimateDetailPage />);
};

beforeEach(() => jest.clearAllMocks());

describe("EstimateDetailPage: revise an estimate", () => {
  it("a DRAFT has Edit, which opens the draft in the form", async () => {
    const user = userEvent.setup();
    show({ status: "DRAFT" as EstimateStatus });
    expect(screen.queryByRole("button", { name: /back to draft/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Edit EST-0001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it.each(["SENT", "ACCEPTED"])("a %s estimate goes Back to draft", async (status) => {
    const user = userEvent.setup();
    show({ status: status as EstimateStatus });
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back to draft/i }));
    expect(mockRevert).toHaveBeenCalledWith("est-1", expect.anything());
  });

  it("a CONVERTED estimate links its invoice and offers no Void or Back to draft", () => {
    show({ status: "CONVERTED" as EstimateStatus, invoiceId: "inv-9" });
    expect(screen.getByRole("link", { name: /view invoice/i })).toHaveAttribute(
      "href",
      "/invoices/inv-9",
    );
    expect(screen.queryByRole("button", { name: /void/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /back to draft/i })).not.toBeInTheDocument();
  });

  it("a SENT estimate shows each response once (no duplicate Accept / Decline)", () => {
    show({ status: "SENT" as EstimateStatus });
    expect(screen.getAllByRole("button", { name: /accept/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /decline/i })).toHaveLength(1);
  });

  it("terms show under the notes", () => {
    show({ terms: "Net 30" });
    expect(screen.getByText("Net 30")).toBeInTheDocument();
  });
});
