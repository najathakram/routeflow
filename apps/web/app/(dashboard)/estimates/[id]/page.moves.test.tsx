import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import type { Estimate, EstimateStatus } from "@/lib/api/estimates";
import EstimateDetailPage from "./page";

// SA-1263 A1 (W-1335): a VOID quote has no actions, "Rev n" shows only when it means something, and Decline asks first.
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
    items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 100, subtotal: 100 } as any],
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
    ...overrides,
  };
}

let mockEstimate = makeEstimate();
const mockDecline = jest.fn();
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
  useDeclineEstimate: () => ({ mutate: mockDecline, isPending: false }),
  useConvertEstimateToInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useVoidEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useRevertEstimateToDraft: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateEstimate: () => ({ mutate: jest.fn(), isPending: false }),
}));

const show = (over: Partial<Estimate>) => {
  mockEstimate = makeEstimate(over);
  return renderWithProviders(<EstimateDetailPage />);
};

beforeEach(() => jest.clearAllMocks());

describe("EstimateDetailPage: closed estimates (SA-1263 A1)", () => {
  it("U2 a VOID estimate shows no Void, Send, Accept, Decline, Convert or Back to draft, and says it is closed", () => {
    show({ status: "VOID" as EstimateStatus });
    for (const name of [/void/i, /sent/i, /accept/i, /decline/i, /convert/i, /back to draft/i]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.getByText("Voided. This estimate is closed.")).toBeInTheDocument();
  });

  it("U3 a DECLINED estimate says it is closed and never names the customer", () => {
    show({ status: "DECLINED" as EstimateStatus });
    const line = screen.getByText("Declined. This estimate is closed.");
    expect(line.textContent?.toLowerCase()).not.toContain("customer");
    expect(screen.queryByRole("button", { name: /void/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
  });
});

describe("EstimateDetailPage: Rev tag (SA-1263 A1)", () => {
  it("U4 no Rev at revision 1, and none on a DRAFT even at revision 2", () => {
    const { unmount } = show({ status: "SENT" as EstimateStatus, revision: 1 });
    expect(screen.queryByText(/^Rev /)).not.toBeInTheDocument();
    unmount();
    show({ status: "DRAFT" as EstimateStatus, revision: 2 });
    expect(screen.queryByText(/^Rev /)).not.toBeInTheDocument();
  });

  it("U5 Rev 2 shows on a sent quote that was revised", () => {
    show({ status: "SENT" as EstimateStatus, revision: 2 });
    expect(screen.getByText("Rev 2")).toBeInTheDocument();
  });
});

describe("EstimateDetailPage: Decline asks first (SA-1263 A1)", () => {
  it("Mark declined opens a confirm; only the confirm declines", async () => {
    const user = userEvent.setup();
    show({ status: "SENT" as EstimateStatus });
    await user.click(screen.getByRole("button", { name: /mark declined/i }));
    expect(mockDecline).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Decline this estimate?");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mockDecline).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /mark declined/i }));
    const again = await screen.findByRole("dialog");
    await user.click(within(again).getByRole("button", { name: "Decline estimate" }));
    expect(mockDecline).toHaveBeenCalledWith("est-1", expect.anything());
  });
});
