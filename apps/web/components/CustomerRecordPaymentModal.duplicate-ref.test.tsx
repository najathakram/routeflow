import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { clearPaymentKeyRegistry } from "@routeflow/types/payment-submit-key";
import { CustomerRecordPaymentModal } from "./CustomerRecordPaymentModal";

/**
 * Row 498 (SA-837): 409 DUPLICATE_PAYMENT_REF on the customer Record payment dialog. The toast names the existing
 * payment (date, amount, invoice) in the one shared sentence and, for a staff role, carries a "Record anyway"
 * action that resends the SAME form with `recordAnyway: true`. A non-staff role gets the sentence and no action.
 */
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
let mockRole: string | undefined = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: mockRole } }),
}));
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(async () => ({ data: { data: [], meta: {} } })),
    post: (url: string, ...a: unknown[]) => mockPost(url, ...a),
  },
}));

const SENTENCE =
  "A payment with this reference was already recorded on Oct 1, 2026 for $150.00 (INV-0042).";
const dupError = () =>
  Object.assign(new Error("RAW SERVER TEXT"), {
    response: {
      status: 409,
      data: {
        code: "DUPLICATE_PAYMENT_REF",
        message: "RAW SERVER TEXT",
        existingPayment: {
          id: "pay-1",
          paymentNumber: "PAY-A-0001",
          paidAt: "2026-10-01T12:00:00.000Z",
          amount: 150,
          invoiceId: "inv-1",
          invoiceNumber: "INV-0042",
        },
      },
    },
  });

function open() {
  renderWithProviders(<CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />);
  fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "150" } });
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save as paid" }));
const bodyOf = (i: number) => mockPost.mock.calls[i][1] as Record<string, unknown>;

describe("CustomerRecordPaymentModal: duplicate payment reference (row 498)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPaymentKeyRegistry();
    mockRole = "OPERATOR";
  });

  it("staff: names the existing payment and offers Record anyway, which resends with recordAnyway: true", async () => {
    mockPost.mockRejectedValueOnce(dupError());
    mockPost.mockResolvedValueOnce({
      data: { payments: [{ id: "p2" }], paymentGroupId: "g2", excess: 0 },
    });
    open();
    save();

    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    const t = mockToast.mock.calls[0][0];
    expect(t.description).toBe(SENTENCE);
    expect(t.description).not.toContain("RAW SERVER TEXT");
    expect(t.action.label).toBe("Record anyway");
    expect(bodyOf(0)).not.toHaveProperty("recordAnyway"); // the first attempt never carries the flag

    t.action.onClick();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(bodyOf(1)).toMatchObject({ customerId: "cust-1", totalAmount: 150, recordAnyway: true });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: "success" })),
    );
  });

  it("a non-staff role is shown the sentence and NO Record anyway action", async () => {
    mockRole = "CUSTOMER";
    mockPost.mockRejectedValueOnce(dupError());
    open();
    save();
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    const t = mockToast.mock.calls[0][0];
    expect(t.description).toBe(SENTENCE);
    expect(t.action).toBeUndefined();
  });

  it("any other failure keeps the generic failure toast, with no Record anyway", async () => {
    mockPost.mockRejectedValueOnce(
      Object.assign(new Error("x"), { response: { status: 400, data: { message: "Bad" } } }),
    );
    open();
    save();
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    const t = mockToast.mock.calls[0][0];
    expect(t.title).toBe("Failed to record payment");
    expect(t.action).toBeUndefined();
  });
});
