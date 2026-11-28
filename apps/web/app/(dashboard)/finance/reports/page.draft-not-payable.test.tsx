import * as React from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import {
  expectOnlyThePageToasted,
  queryClientWithGlobalErrorToast,
  refusal,
} from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import { INVOICE_NOT_PAYABLE_COPY } from "@routeflow/types/payment-refusal-copy";
import FinanceReportsPage from "./page";

/**
 * W-1446 (SA-1326, SA-C 7230437607): the ledger writer now refuses a DRAFT with the coded 400 INVOICE_NOT_PAYABLE, the same
 * refusal as the invoice page. The Ledger report's Record payment (reached from a stale row an order edit put back to DRAFT)
 * shows the SHARED sentence for that reason, in the page's one toast, never the server's text.
 */
const mockToast = jest.fn(); // the page-local toast (useToast)
const mockGlobalToast = jest.fn(); // the app-wide MutationCache handler
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("report=ledger"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/reports",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: true, loading: false }),
}));
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: jest.fn((url: string) =>
      Promise.resolve({
        data:
          url === "/bookkeeping/transactions"
            ? {
                data: [
                  {
                    id: "tx-1",
                    orderId: "o-1",
                    customerId: "c-1",
                    customer: { id: "c-1", businessName: "Acme Foods" },
                    order: { id: "o-1", orderNumber: "ORD-00001" },
                    status: "UNPAID",
                    totalOwed: 30,
                    totalPaid: 0,
                    createdAt: "2026-10-01T00:00:00.000Z",
                  },
                ],
                meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
              }
            : [],
      }),
    ),
    post: (...a: unknown[]) => mockPost(...a),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

describe("finance/reports Ledger: a payment refused on a DRAFT shows the shared words (W-1446)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("the coded INVOICE_NOT_PAYABLE (DRAFT) shows INVOICE_NOT_PAYABLE_COPY.DRAFT in the page's one toast, never the server text", async () => {
    mockPost.mockRejectedValue(
      refusal(400, {
        code: API_ERROR_CODES.INVOICE_NOT_PAYABLE,
        reason: "DRAFT",
        message: "RAW server text",
      }),
    );
    renderWithProviders(<FinanceReportsPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Record payment" }));
    const modal = screen.getByRole("heading", { name: "Record payment" }).closest("div")!
      .parentElement as HTMLElement;
    fireEvent.click(within(modal).getByRole("button", { name: "Record" }));

    const sentence = INVOICE_NOT_PAYABLE_COPY.DRAFT!;
    expect(sentence).toBe(
      "This invoice is still a draft. Send it to the customer first, then record the payment.",
    );
    await expectOnlyThePageToasted(mockToast, mockGlobalToast, {
      title: `Failed to record payment. ${sentence}`,
    });
    expect(JSON.stringify(mockToast.mock.calls)).not.toContain("RAW server text");
  });
});
