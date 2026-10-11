import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { EditCreditNoteModal } from "./EditCreditNoteModal";
import type { CreditNote } from "@/lib/api/credit-notes";
import { API_ERROR_CODES } from "@routeflow/types";
import {
  CREDIT_EXCEEDS_REFUNDABLE_COPY,
  CREDIT_NOTE_ERROR_COPY,
} from "@/lib/credit-note-error-copy";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let previewError = false;
const updateMutate = jest.fn();
const reissueMutate = jest.fn();
let previewData: any = {
  refusal: null,
  refusalCode: null,
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
    isError: enabled && previewError,
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

  const SECRET = "RAW SERVER TEXT cn=CN-2026-0042 cust=Acme Mart";
  const apiError = (code?: string) => ({ response: { data: { code, message: SECRET } } });

  it("a reason can be changed but not blanked: Save is disabled with a 'required' hint; the box is bounded to 450", async () => {
    const user = userEvent.setup();
    open(note());
    const dialog = within(await screen.findByRole("dialog"));
    const box = dialog.getByLabelText("Reason");
    expect(box).toHaveAttribute("maxlength", "450");

    await user.clear(box);
    expect(dialog.getByTestId("cn-edit-reason-required")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(box, "Wrong item");
    expect(dialog.queryByTestId("cn-edit-reason-required")).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("the expiry lock is not a trap: amount -> expiry -> amount back leaves the changed expiry editable", async () => {
    const user = userEvent.setup();
    open(note({ status: "APPLIED" }));
    const dialog = within(await screen.findByRole("dialog"));
    const expiry = dialog.getByLabelText(/Expires/);
    expect(expiry).toBeDisabled(); // a non-ISSUED note with no money change

    await user.clear(dialog.getByLabelText("Credit amount"));
    await user.type(dialog.getByLabelText("Credit amount"), "10");
    expect(expiry).toBeEnabled();
    await user.type(expiry, "2999-01-01");

    await user.clear(dialog.getByLabelText("Credit amount"));
    await user.type(dialog.getByLabelText("Credit amount"), "30"); // back to the original amount
    expect(expiry).toBeEnabled(); // still editable, so it can be put back
    await user.clear(expiry);
    expect(expiry).toBeDisabled(); // restored => locked again
  });

  it("a changed expiry on a non-ISSUED note (no amount change) or a past date blocks Save with fixed copy", async () => {
    const user = userEvent.setup();
    open(note({ status: "APPLIED" }));
    const dialog = within(await screen.findByRole("dialog"));
    // the field is locked on an APPLIED note; change the amount to unlock it, set an expiry, put the amount back
    await user.clear(dialog.getByLabelText("Credit amount"));
    await user.type(dialog.getByLabelText("Credit amount"), "10");
    await user.type(dialog.getByLabelText(/Expires/), "2999-01-01");
    await user.clear(dialog.getByLabelText("Credit amount"));
    await user.type(dialog.getByLabelText("Credit amount"), "30");
    expect(dialog.getByTestId("cn-edit-expiry-hint")).toHaveTextContent(
      CREDIT_NOTE_ERROR_COPY[API_ERROR_CODES.CREDIT_NOTE_EXPIRY_NOT_EDITABLE],
    );
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("a past expiry on an ISSUED note blocks Save with the EXPIRY_PAST copy", async () => {
    const user = userEvent.setup();
    open(note({ status: "ISSUED" }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.type(dialog.getByLabelText(/Expires/), "2001-01-01");
    expect(dialog.getByTestId("cn-edit-expiry-hint")).toHaveTextContent(
      CREDIT_NOTE_ERROR_COPY[API_ERROR_CODES.CREDIT_NOTE_EXPIRY_PAST],
    );
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("the reason-required hint is announced (role=alert) and wired to the textarea", async () => {
    const user = userEvent.setup();
    open(note());
    const dialog = within(await screen.findByRole("dialog"));
    await user.clear(dialog.getByLabelText("Reason"));
    expect(dialog.getByTestId("cn-edit-reason-required")).toHaveAttribute("role", "alert");
    expect(dialog.getByLabelText("Reason")).toHaveAttribute("aria-invalid", "true");
    expect(dialog.getByLabelText("Reason")).toHaveAttribute(
      "aria-describedby",
      "cn-edit-reason-hint",
    );
  });

  it("the reissue confirm is blocked while the void-preview failed to load", async () => {
    previewData = undefined;
    previewError = true;
    const user = userEvent.setup();
    open(note());
    const dialog = within(await screen.findByRole("dialog"));
    await user.clear(dialog.getByLabelText("Credit amount"));
    await user.type(dialog.getByLabelText("Credit amount"), "10");
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    expect(await screen.findByTestId("reissue-preview-error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Void and issue new" })).toBeDisabled();
    previewError = false;
  });

  it("a note that never had a reason can still be saved (only blanking a set reason is blocked)", async () => {
    const user = userEvent.setup();
    open(note({ reason: null as unknown as string, status: "ISSUED" }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.type(dialog.getByLabelText(/Expires/), "2999-01-01");
    expect(dialog.queryByTestId("cn-edit-reason-required")).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("a void-preview refusal shows FIXED copy for its code (never the server text) and blocks the reissue", async () => {
    previewData = {
      refusal: SECRET,
      refusalCode: API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED,
      restoresTotal: 0,
      invoices: [],
    };
    const user = userEvent.setup();
    open(note());
    const dialog = within(await screen.findByRole("dialog"));
    await user.clear(dialog.getByLabelText("Credit amount"));
    await user.type(dialog.getByLabelText("Credit amount"), "10");
    await user.click(dialog.getByRole("button", { name: "Continue" }));

    expect(await screen.findByTestId("reissue-refusal")).toHaveTextContent(
      CREDIT_NOTE_ERROR_COPY[API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED],
    );
    expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Void and issue new" })).toBeDisabled();
  });

  it("a refusal with no known code still shows generic fixed copy, not the server text", async () => {
    previewData = { refusal: SECRET, refusalCode: null, restoresTotal: 0, invoices: [] };
    const user = userEvent.setup();
    open(note());
    const dialog = within(await screen.findByRole("dialog"));
    await user.clear(dialog.getByLabelText("Credit amount"));
    await user.type(dialog.getByLabelText("Credit amount"), "10");
    await user.click(dialog.getByRole("button", { name: "Continue" }));

    expect(await screen.findByTestId("reissue-refusal")).toBeInTheDocument();
    expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
  });

  it.each([
    [API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM],
    [API_ERROR_CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY],
    [undefined],
  ])(
    "a failed reissue (409 code %s) toasts fixed copy and never the server message",
    async (code) => {
      previewData = { refusal: null, refusalCode: null, restoresTotal: 0, invoices: [] };
      reissueMutate.mockImplementation((_vars: unknown, opts: any) => opts.onError(apiError(code)));
      const user = userEvent.setup();
      open(note());
      const dialog = within(await screen.findByRole("dialog"));
      await user.clear(dialog.getByLabelText("Credit amount"));
      await user.type(dialog.getByLabelText("Credit amount"), "10");
      await user.click(dialog.getByRole("button", { name: "Continue" }));
      await user.click(await screen.findByRole("button", { name: "Void and issue new" }));

      const expected = code
        ? CREDIT_NOTE_ERROR_COPY[code as keyof typeof CREDIT_NOTE_ERROR_COPY]
        : "Nothing was changed. Please try again.";
      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
    },
  );

  it("a failed in-place save toasts fixed copy and never the server message", async () => {
    updateMutate.mockImplementation((_vars: unknown, opts: any) =>
      opts.onError(apiError(API_ERROR_CODES.CREDIT_NOTE_VOID_NOT_EDITABLE)),
    );
    const user = userEvent.setup();
    open(note());
    const dialog = within(await screen.findByRole("dialog"));
    await user.clear(dialog.getByLabelText("Reason"));
    await user.type(dialog.getByLabelText("Reason"), "Wrong item");
    await user.click(dialog.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        CREDIT_NOTE_ERROR_COPY[API_ERROR_CODES.CREDIT_NOTE_VOID_NOT_EDITABLE],
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
  });

  describe("SA-773: a credit past what the goods have left says how much is left", () => {
    const refusal = {
      response: {
        data: { code: "CREDIT_EXCEEDS_REFUNDABLE", message: SECRET, remainingValue: 12 },
      },
    };
    const expected = `${CREDIT_EXCEEDS_REFUNDABLE_COPY} Up to $12.00 can still be given back.`;

    it("a reissue (the amount change) toasts the copy with the amount, never the server message", async () => {
      previewData = { refusal: null, refusalCode: null, restoresTotal: 0, invoices: [] };
      reissueMutate.mockImplementation((_vars: unknown, opts: any) => opts.onError(refusal));
      const user = userEvent.setup();
      open(note());
      const dialog = within(await screen.findByRole("dialog"));
      await user.clear(dialog.getByLabelText("Credit amount"));
      await user.type(dialog.getByLabelText("Credit amount"), "40");
      await user.click(dialog.getByRole("button", { name: "Continue" }));
      await user.click(await screen.findByRole("button", { name: "Void and issue new" }));
      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
    });

    it("an in-place save toasts the copy with the amount too", async () => {
      updateMutate.mockImplementation((_vars: unknown, opts: any) => opts.onError(refusal));
      const user = userEvent.setup();
      open(note());
      const dialog = within(await screen.findByRole("dialog"));
      await user.clear(dialog.getByLabelText("Reason"));
      await user.type(dialog.getByLabelText("Reason"), "Wrong item");
      await user.click(dialog.getByRole("button", { name: "Save" }));
      expect(await screen.findByText(expected)).toBeInTheDocument();
    });
  });
});
