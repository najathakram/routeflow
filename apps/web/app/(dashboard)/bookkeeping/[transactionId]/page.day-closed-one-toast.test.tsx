import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import { COUNTER_SALE_DAY_CLOSED_COPY } from "@/lib/day-closed-copy";
import TransactionDetailPage from "./page";

/**
 * Row 348: the bookkeeping invoice's Record Payment into a closed day raises exactly ONE toast: the page keeps no
 * local error toast for this mutation, so the app-wide fixed copy is the only one (pinned here so it stays so).
 */
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useParams: () => ({ transactionId: "txn-1" }),
}));
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({
      data: {
        id: "txn-1",
        totalOwed: 500,
        totalPaid: 100,
        payments: [],
        order: { orderNumber: "ORD-100" },
        customer: { businessName: "Acme Foods", contactName: "Jane" },
        createdAt: "2026-01-01T00:00:00.000Z",
        dueDate: null,
      },
    }),
    post: (...a: unknown[]) => mockPost(...a),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

describe("bookkeeping/[transactionId]: a closed-day refusal raises exactly one toast (row 348)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("COUNTER_SALE_DAY_CLOSED: the app-wide copy only", async () => {
    mockPost.mockRejectedValue(
      refusal(409, { code: API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED, message: "RAW" }),
    );
    const user = userEvent.setup();
    renderWithProviders(<TransactionDetailPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockToast),
    });
    await user.click((await screen.findAllByRole("button", { name: /^record payment$/i }))[0]);
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: /^record payment$/i }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: COUNTER_SALE_DAY_CLOSED_COPY, variant: "error" }),
    );
  });
});
