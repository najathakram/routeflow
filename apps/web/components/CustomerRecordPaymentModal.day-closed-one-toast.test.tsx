import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import { COUNTER_SALE_DAY_CLOSED_COPY } from "@/lib/day-closed-copy";
import { CustomerRecordPaymentModal } from "./CustomerRecordPaymentModal";

/** Row 348: recording a payment dated into a closed day raises ONE toast (the app-wide one), not two. */
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { data: [], meta: {} } }),
    post: (...a: unknown[]) => mockPost(...a),
  },
}));

describe("CustomerRecordPaymentModal: a closed-day refusal raises exactly one toast (row 348)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("COUNTER_SALE_DAY_CLOSED: the app-wide copy only, no 'Failed to record payment'", async () => {
    mockPost.mockRejectedValue(
      refusal(409, { code: API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED, message: "RAW" }),
    );
    renderWithProviders(<CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />, {
      queryClient: queryClientWithGlobalErrorToast(mockToast),
    });
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as Paid" }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: COUNTER_SALE_DAY_CLOSED_COPY, variant: "error" }),
    );
  });
});
