import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { clearPaymentKeyRegistry } from "@routeflow/types/payment-submit-key";
import { CustomerRecordPaymentModal } from "./CustomerRecordPaymentModal";

/**
 * SA-1208 D1 / M1-03 (SA-1211 BF-6): the customer Record payment dialog's success toast links to the receipt of the
 * payment the server just wrote ("View receipt"); a failed save has no such link.
 */
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" } }),
}));
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(async () => ({ data: { data: [], meta: {} } })),
    post: (url: string, ...a: unknown[]) => mockPost(url, ...a),
  },
}));

function open() {
  renderWithProviders(<CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />);
  fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "150" } });
}

describe("CustomerRecordPaymentModal: the success toast links to the receipt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPaymentKeyRegistry();
  });

  it("carries View receipt, which opens the receipt of the payment just written", async () => {
    mockPost.mockResolvedValueOnce({
      data: { payments: [{ id: "pay-new" }], paymentGroupId: "g1", excess: 0 },
    });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Save as paid" }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: "success" })),
    );
    const toast = mockToast.mock.calls.find((c) => c[0].variant === "success")![0];
    expect(toast.action?.label).toBe("View receipt");
    toast.action.onClick();
    expect(mockPush).toHaveBeenCalledWith("/finance/payments/pay-new");
  });

  it("a failed save has no View receipt link", async () => {
    mockPost.mockRejectedValueOnce({ response: { status: 500, data: {} } });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Save as paid" }));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockToast.mock.calls.some((c) => c[0].action?.label === "View receipt")).toBe(false);
  });
});
