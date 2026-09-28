import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { EditCreditNoteModal } from "./EditCreditNoteModal";
import type { CreditNote } from "@/lib/api/credit-notes";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const updateMutate = jest.fn();
const reissueMutate = jest.fn();
let previewData: any = {
  refusal: null,
  restoresTotal: 30,
  invoices: [
    {
      invoiceId: "inv-9",
      invoiceNumber: "INV-9",
      amount: 30,
      statusBefore: "PAID",
      statusAfter: "SENT",
    },
  ],
};
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useUpdateCreditNote: () => ({ mutate: updateMutate, isPending: false }),
  useReissueCreditNote: () => ({ mutate: reissueMutate, isPending: false }),
  useVoidPreview: (_id: string, enabled: boolean) => ({
    data: enabled ? previewData : undefined,
    isLoading: false,
  }),
}));
jest.mock("@/lib/api/invoices", () => ({
  useInvoice: (id: string) => ({
    data: id ? { id, items: [{ id: "ii-1", description: "Crate of apples" }] } : undefined,
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const note = (over: Partial<CreditNote> = {}): CreditNote => ({
  id: "cn-old",
  creditNoteNumber: "CN-2026-0007",
  customerId: "cust-1",
  invoiceId: "inv-1",
  status: "APPLIED",
  amount: 30,
  amountUsed: 30,
  reason: "Damaged case",
  items: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const open = (n: CreditNote) =>
  renderWithProviders(<EditCreditNoteModal open onClose={jest.fn()} note={n} />);

describe("EditCreditNoteModal (#2648 / SA-535(c))", () => {
  beforeEach(() => jest.clearAllMocks());

  it("a reason-only change is a plain PATCH save; nothing is reissued", async () => {
    const user = userEvent.setup();
    open(note());
    const dialog = within(await screen.findByRole("dialog"));

    await user.clear(dialog.getByLabelText("Reason"));
    await user.type(dialog.getByLabelText("Reason"), "Wrong item");
    await user.click(dialog.getByRole("button", { name: "Save" }));

    expect(updateMutate).toHaveBeenCalledWith(
      { id: "cn-old", reason: "Wrong item" },
      expect.anything(),
    );
    expect(reissueMutate).not.toHaveBeenCalled();
  });

  it("an amount change confirms 'This voids CN-X and issues a new credit note … un-applies $Y from INV-…', then reissues", async () => {
    const user = userEvent.setup();
    open(note());
    const dialog = within(await screen.findByRole("dialog"));

    const amount = dialog.getByLabelText("Credit amount");
    await user.clear(amount);
    await user.type(amount, "20");
    await user.click(dialog.getByRole("button", { name: "Continue" }));

    const text = await screen.findByTestId("reissue-confirm-text");
    expect(text).toHaveTextContent(
      /This voids CN-2026-0007 and issues a new credit note for \$20\.00 and un-applies \$30\.00 from INV-9\./,
    );
    expect(updateMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Void and issue new" }));
    const [vars] = reissueMutate.mock.calls[0];
    expect(vars).toEqual({ id: "cn-old", idempotencyKey: expect.any(String), amount: 20 });
    expect(vars.idempotencyKey.length).toBeGreaterThan(8);
  });

  it("a line-linked note edits per line and sends the lines; the total is their sum", async () => {
    const user = userEvent.setup();
    open(note({ items: [{ invoiceItemId: "ii-1", amount: 30, qty: 3 }] }));
    const dialog = within(await screen.findByRole("dialog"));

    const line = dialog.getByLabelText("Crate of apples");
    await user.clear(line);
    await user.type(line, "12.5");
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Void and issue new" }));

    expect(reissueMutate.mock.calls[0][0]).toMatchObject({
      amount: 12.5,
      items: [{ invoiceItemId: "ii-1", amount: 12.5 }],
    });
  });

  it("a void-preview refusal is shown and blocks the reissue", async () => {
    previewData = {
      refusal: "This credit note backs a return (RET-4).",
      restoresTotal: 0,
      invoices: [],
    };
    const user = userEvent.setup();
    open(note());
    const dialog = within(await screen.findByRole("dialog"));
    await user.clear(dialog.getByLabelText("Credit amount"));
    await user.type(dialog.getByLabelText("Credit amount"), "10");
    await user.click(dialog.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/backs a return/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Void and issue new" })).toBeDisabled();
  });
});
