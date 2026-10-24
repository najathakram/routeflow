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
import PaymentRequestsPage from "./page";

/**
 * Row 348: approving a cash request into a closed day raises ONE toast, the PAGE's (fixed closed-day copy):
 * the approve hook's `meta.localErrorToast` keeps the app-wide toast quiet for the refusal.
 */
const mockToast = jest.fn(); // the page-local toast (useToast)
const mockGlobalToast = jest.fn(); // the app-wide MutationCache handler
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/payment-requests",
  useSearchParams: () => new URLSearchParams(),
}));
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({
      data: [
        {
          id: "pr-1",
          kind: "CASH",
          status: "PENDING",
          amount: 25,
          note: null,
          reference: null,
          customerId: "cust-1",
          customerName: "Acme Foods",
          contactName: null,
          createdAt: new Date().toISOString(),
          decidedAt: null,
          decidedByName: null,
        },
      ],
    }),
    post: (...a: unknown[]) => mockPost(...a),
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

describe("finance/payment-requests: a closed-day approval raises exactly one toast (row 348)", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(CLOSED_DAY)("%s: the page's one toast, the global one quiet", async (_n, code, copy) => {
    mockPost.mockRejectedValue(refusal(409, { code, message: "RAW server sentence" }));
    renderWithProviders(<PaymentRequestsPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));

    await expectOnlyThePageToasted(mockToast, mockGlobalToast, { title: copy });
  });
});
