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
import PaymentDetailPage from "./page";

/**
 * Row 348: voiding a payment into a closed day raises ONE toast, the page's own "Failed to void payment" carrying the
 * closed-day copy. `useVoidPayment`'s `meta.localErrorToast` keeps the app-wide one quiet.
 */
const mockToast = jest.fn(); // the page-local toast (useToast)
const mockGlobalToast = jest.fn(); // the app-wide MutationCache handler
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "pay-9" }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));
const mockPatch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: (...a: unknown[]) => mockPatch(...a) },
}));
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  usePaymentDetail: () => ({
    data: {
      id: "pay-9",
      paymentNumber: "PAY-000009",
      amount: 42,
      method: "CASH",
      status: "PAID",
      paidAt: "2026-10-01T12:00:00.000Z",
      createdAt: "2026-10-01T12:00:00.000Z",
      invoice: {
        id: "inv-1",
        invoiceNumber: "INV-000001",
        customerId: "cust-1",
        customer: { id: "cust-1", businessName: "Acme Foods" },
      },
    },
    isLoading: false,
  }),
  useInvoice: () => ({ data: undefined }),
  useGetPaymentImageUrl: () => ({ mutateAsync: jest.fn() }),
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

describe("finance/payments/[id]: a closed-day void raises exactly one toast (row 348)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, "confirm").mockReturnValue(true);
  });

  it.each(CLOSED_DAY)("%s: the page's one toast, the global one quiet", async (_n, code, copy) => {
    mockPatch.mockRejectedValue(refusal(409, { code, message: "RAW" }));
    renderWithProviders(<PaymentDetailPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    fireEvent.click(screen.getByRole("button", { name: "Void Payment" }));

    await expectOnlyThePageToasted(mockToast, mockGlobalToast, {
      title: "Failed to void payment",
      description: copy,
    });
  });
});
