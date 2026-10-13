import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
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
import { CustomerRecordPaymentModal } from "./CustomerRecordPaymentModal";

/**
 * Row 348: recording a payment dated into a closed day raises ONE toast, the modal's own "Failed to record payment"
 * carrying the closed-day copy. `useRecordPaymentStandalone`'s `meta.localErrorToast` keeps the global one quiet.
 */
const mockToast = jest.fn(); // the page-local toast (useToast)
const mockGlobalToast = jest.fn(); // the app-wide MutationCache handler
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

describe("CustomerRecordPaymentModal: a closed-day refusal raises exactly one toast (row 348)", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(CLOSED_DAY)("%s: the page's one toast, the global one quiet", async (_n, code, copy) => {
    mockPost.mockRejectedValue(refusal(409, { code, message: "RAW" }));
    renderWithProviders(<CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as Paid" }));

    await expectOnlyThePageToasted(mockToast, mockGlobalToast, {
      title: "Failed to record payment",
      description: copy,
    });
  });
});
