import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import {
  expectOnlyThePageToasted,
  queryClientWithGlobalErrorToast,
  refusal,
} from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import {
  COUNTER_SALE_DAY_CLOSED_COPY,
  DAY_CLOSED_FOR_PAYMENT_DATE_COPY,
} from "@/lib/day-closed-copy";
import FinanceReportsPage from "./page";

/**
 * Row 348: the Ledger report's Record Payment into a closed day raises ONE toast, the PAGE's own (the fixed closed-day
 * copy as its title). The report passes `localErrorToast` to the hook, so the global one is quiet.
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

const CLOSED_DAY = [
  [
    "COUNTER_SALE_DAY_CLOSED",
    API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
    COUNTER_SALE_DAY_CLOSED_COPY,
  ],
  [
    "DAY_CLOSED_FOR_PAYMENT_DATE",
    API_ERROR_CODES.DAY_CLOSED_FOR_PAYMENT_DATE,
    DAY_CLOSED_FOR_PAYMENT_DATE_COPY,
  ],
] as const;

describe("finance/reports Ledger: a closed-day refusal raises exactly one toast (row 348)", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(CLOSED_DAY)("%s: the page's one toast, the global one quiet", async (_n, code, copy) => {
    mockPost.mockRejectedValue(refusal(409, { code, message: "RAW" }));
    renderWithProviders(<FinanceReportsPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Record Payment" }));
    const modal = screen.getByRole("heading", { name: "Record Payment" }).closest("div")!
      .parentElement as HTMLElement;
    fireEvent.click(within(modal).getByRole("button", { name: "Record" }));

    await expectOnlyThePageToasted(mockToast, mockGlobalToast, { title: copy });
  });

  it("any other failure keeps the page's own toast", async () => {
    mockPost.mockRejectedValue(refusal(500, { message: "boom" }));
    renderWithProviders(<FinanceReportsPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Record Payment" }));
    const modal = screen.getByRole("heading", { name: "Record Payment" }).closest("div")!
      .parentElement as HTMLElement;
    fireEvent.click(within(modal).getByRole("button", { name: "Record" }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to record payment" }),
      ),
    );
  });
});
