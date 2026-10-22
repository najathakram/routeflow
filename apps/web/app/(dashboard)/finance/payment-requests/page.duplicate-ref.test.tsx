import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import {
  expectOnlyThePageToasted,
  queryClientWithGlobalErrorToast,
  refusal,
} from "@/test-utils/global-error-toast";
import PaymentRequestsPage from "./page";

/**
 * SA-837b item 2 (review I2): approving a buyer-declared cash payment that repeats an existing payment's customer,
 * reference and amount answers 409 DUPLICATE_PAYMENT_REF. The approving STAFF member sees the one shared sentence and a
 * "Record anyway" action that re-approves with `recordAnyway: true` (the server reads the approving user's role).
 */
const mockToast = jest.fn();
const mockGlobalToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
let mockRole: string | undefined = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: mockRole } }),
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
          reference: "receipt 7",
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

const SENTENCE =
  "A payment with this reference was already recorded on Oct 1, 2026 for $25.00 (INV-0042).";
const dup = () =>
  refusal(409, {
    code: "DUPLICATE_PAYMENT_REF",
    message: "RAW server sentence",
    existingPayment: {
      id: "pay-1",
      paymentNumber: "PAY-A-0001",
      paidAt: "2026-10-01T12:00:00.000Z",
      amount: 25,
      invoiceId: "inv-1",
      invoiceNumber: "INV-0042",
    },
  });

async function approveFirst() {
  renderWithProviders(<PaymentRequestsPage />, {
    queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
}

describe("finance/payment-requests: a duplicate-reference approval (SA-837b item 2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRole = "OPERATOR";
  });

  it("staff: the shared sentence (one toast) and Record anyway, which re-approves with recordAnyway: true", async () => {
    mockPost.mockRejectedValueOnce(dup());
    mockPost.mockResolvedValueOnce({ data: { approved: true, paymentGroupId: "g1", excess: 0 } });
    await approveFirst();

    await expectOnlyThePageToasted(mockToast, mockGlobalToast, {
      variant: "warning",
      description: SENTENCE,
    });
    const t = mockToast.mock.calls[0][0];
    expect(t.action.label).toBe("Record anyway");
    expect(mockPost.mock.calls[0][1]).toBeUndefined(); // the first approve carries no flag

    t.action.onClick();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost.mock.calls[1][0]).toBe("/payment-requests/pr-1/approve");
    expect(mockPost.mock.calls[1][1]).toEqual({ recordAnyway: true });
  });

  it("a non-staff role is shown the sentence and no Record anyway action", async () => {
    mockRole = "CUSTOMER";
    mockPost.mockRejectedValueOnce(dup());
    await approveFirst();
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockToast.mock.calls[0][0].description).toBe(SENTENCE);
    expect(mockToast.mock.calls[0][0].action).toBeUndefined();
  });
});
