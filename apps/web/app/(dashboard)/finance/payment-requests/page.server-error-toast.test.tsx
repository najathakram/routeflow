import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { genericToastCopy } from "@/lib/generic-toast-copy";
import PaymentRequestsPage from "./page";

/**
 * PK-9 review: a failed approve or reject raises ONE toast with FIXED copy. The server's `message` (a 500's
 * "boom", a raw stack sentence) is never the toast title: the page renders a fixed title plus `genericToastCopy`.
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

const RAW = "boom: relation payment_request violates constraint";

async function failOnce(action: "approve" | "reject"): Promise<void> {
  mockPost.mockRejectedValue(refusal(500, { message: RAW }));
  renderWithProviders(<PaymentRequestsPage />, {
    queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
  });
  const open = action === "approve" ? "Approve" : "Reject";
  fireEvent.click(await screen.findByRole("button", { name: open }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: open }));
  await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
}

describe("finance/payment-requests: a server failure toasts fixed copy once (PK-9)", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ["approve", "Failed to approve payment"],
    ["reject", "Failed to reject payment"],
  ] as const)(
    "%s on a 500: fixed title + generic description, never the raw message",
    async (action, title) => {
      await failOnce(action);
      const call = mockToast.mock.calls[0][0] as { title: string; description?: string };
      expect(call.title).toBe(title);
      expect(call.description).toBe(genericToastCopy(refusal(500, { message: RAW })));
      expect(JSON.stringify(call)).not.toContain("boom");
      expect(mockGlobalToast).not.toHaveBeenCalled();
    },
  );
});
