import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { clearPaymentKeyRegistry } from "@routeflow/types/payment-submit-key";
import { CustomerRecordPaymentModal } from "./CustomerRecordPaymentModal";

/**
 * Row 661 (Ask 1): `focusInvoiceId`. "Mark paid" on the New order Account strip opens this dialog with ONE invoice first
 * and the amount at its balance. The other rows stay editable (a cheque that covers two invoices still works); with no
 * prop the dialog is exactly as before (empty amount, oldest first).
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" } }),
}));
const mockPost = jest.fn();
const open = (id: string, n: string, issued: string, balanceDue: number) => ({
  id,
  invoiceNumber: n,
  status: "SENT",
  issueDate: `${issued}T00:00:00.000Z`,
  createdAt: `${issued}T00:00:00.000Z`,
  balanceDue,
});
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(async () => ({
      data: {
        data: [
          open("a", "INV-A", "2026-08-01", 100),
          open("b", "INV-B", "2026-09-01", 200),
          open("c", "INV-C", "2026-10-01", 50),
        ],
        meta: {},
      },
    })),
    post: (url: string, ...a: unknown[]) => mockPost(url, ...a),
  },
}));

const numbers = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0].textContent);
const applyInputs = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => (within(r).getByRole("spinbutton") as HTMLInputElement).value);

describe("CustomerRecordPaymentModal: focusInvoiceId (row 661)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPaymentKeyRegistry();
  });

  it("puts the focused invoice first and starts the amount at its balance", async () => {
    renderWithProviders(
      <CustomerRecordPaymentModal customerId="c1" focusInvoiceId="b" onClose={jest.fn()} />,
    );
    await waitFor(() => expect(numbers()).toEqual(["INV-B", "INV-A", "INV-C"]));
    await waitFor(() =>
      expect((screen.getAllByPlaceholderText("0.00")[0] as HTMLInputElement).value).toBe("200"),
    );
    expect(applyInputs()).toEqual(["200", "", ""]);
  });

  it("the other rows stay editable, and a larger amount spills to them oldest first", async () => {
    renderWithProviders(
      <CustomerRecordPaymentModal customerId="c1" focusInvoiceId="b" onClose={jest.fn()} />,
    );
    await waitFor(() => expect(applyInputs()).toEqual(["200", "", ""]));
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "250" } });
    await waitFor(() => expect(applyInputs()).toEqual(["200", "50", ""]));
    const rows = screen.getAllByRole("row").slice(1);
    fireEvent.change(within(rows[2]).getByRole("spinbutton"), { target: { value: "10" } });
    expect(
      (within(screen.getAllByRole("row")[3]).getByRole("spinbutton") as HTMLInputElement).value,
    ).toBe("10");
  });

  it("with no focus the dialog is unchanged: oldest first and an empty amount", async () => {
    renderWithProviders(<CustomerRecordPaymentModal customerId="c1" onClose={jest.fn()} />);
    await waitFor(() => expect(numbers()).toEqual(["INV-A", "INV-B", "INV-C"]));
    expect((screen.getAllByPlaceholderText("0.00")[0] as HTMLInputElement).value).toBe("");
  });

  it("an unknown focus id is ignored (no amount invented)", async () => {
    renderWithProviders(
      <CustomerRecordPaymentModal customerId="c1" focusInvoiceId="zzz" onClose={jest.fn()} />,
    );
    await waitFor(() => expect(numbers()).toEqual(["INV-A", "INV-B", "INV-C"]));
    expect((screen.getAllByPlaceholderText("0.00")[0] as HTMLInputElement).value).toBe("");
  });
});
