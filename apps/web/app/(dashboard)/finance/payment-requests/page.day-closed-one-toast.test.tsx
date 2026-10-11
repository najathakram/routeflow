import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import { COUNTER_SALE_DAY_CLOSED_COPY } from "@/lib/day-closed-copy";
import PaymentRequestsPage from "./page";

/** Row 348: approving a cash request into a closed day raises ONE toast (the app-wide one), not two. */
const mockToast = jest.fn();
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

describe("finance/payment-requests: a closed-day approval raises exactly one toast (row 348)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("COUNTER_SALE_DAY_CLOSED: the app-wide copy only, never the raw server sentence", async () => {
    mockPost.mockRejectedValue(
      refusal(409, {
        code: API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
        message: "RAW server sentence",
      }),
    );
    renderWithProviders(<PaymentRequestsPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockToast),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: COUNTER_SALE_DAY_CLOSED_COPY, variant: "error" }),
    );
  });
});
