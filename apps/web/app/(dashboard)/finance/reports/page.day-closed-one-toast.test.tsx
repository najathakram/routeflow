import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import { COUNTER_SALE_DAY_CLOSED_COPY } from "@/lib/day-closed-copy";
import FinanceReportsPage from "./page";

/** Row 348: the Ledger report's Record Payment into a closed day raises ONE toast (the app-wide one), not two. */
const mockToast = jest.fn();
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

describe("finance/reports Ledger: a closed-day refusal raises exactly one toast (row 348)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("COUNTER_SALE_DAY_CLOSED: the app-wide copy only, no 'Failed to record payment'", async () => {
    mockPost.mockRejectedValue(
      refusal(409, { code: API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED, message: "RAW" }),
    );
    renderWithProviders(<FinanceReportsPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockToast),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Record Payment" }));
    const modal = screen.getByRole("heading", { name: "Record Payment" }).closest("div")!
      .parentElement as HTMLElement;
    fireEvent.click(within(modal).getByRole("button", { name: "Record" }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: COUNTER_SALE_DAY_CLOSED_COPY, variant: "error" }),
    );
  });
});
