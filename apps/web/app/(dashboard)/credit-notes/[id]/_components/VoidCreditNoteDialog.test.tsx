import * as React from "react";
import userEvent from "@testing-library/user-event";
import { API_ERROR_CODES } from "@routeflow/types";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { VoidCreditNoteDialog } from "./VoidCreditNoteDialog";
import { CREDIT_NOTE_ERROR_COPY } from "@/lib/credit-note-error-copy";

const voidMutate = jest.fn();
let previewData: any;
let previewError = false;
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useVoidPreview: (_id: string, enabled: boolean) => ({
    data: enabled ? previewData : undefined,
    isLoading: false,
    isError: enabled && previewError,
  }),
  useVoidWithReversal: () => ({ mutate: voidMutate, isPending: false }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const SECRET = "RAW SERVER TEXT cn=CN-2026-0042 cust=Acme Mart";
const openDialog = (onClose = jest.fn()) =>
  renderWithProviders(
    <VoidCreditNoteDialog open onClose={onClose} noteId="cn-1" noteNumber="CN-2026-0007" />,
  );

describe("VoidCreditNoteDialog (#2418 U1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    previewData = {
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
  });

  it("shows what the void un-applies and posts void-with-reversal with the trimmed reason", async () => {
    const user = userEvent.setup();
    openDialog();
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByTestId("void-confirm-text")).toHaveTextContent(
      /un-applies \$30\.00 from INV-9, which reopens that invoice/,
    );

    await user.type(dialog.getByTestId("void-reason"), "  duplicate of CN-0042  ");
    await user.click(dialog.getByRole("button", { name: "Void credit note" }));

    expect(voidMutate).toHaveBeenCalledWith(
      { id: "cn-1", reason: "duplicate of CN-0042" },
      expect.anything(),
    );
  });

  it("the void button is disabled, with a fixed-copy notice, when the preview failed to load", async () => {
    previewData = undefined;
    previewError = true;
    openDialog();
    expect(await screen.findByTestId("void-preview-error")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "Void credit note" })).toBeDisabled();
    previewError = false;
  });

  it("sends no reason when the field is empty", async () => {
    const user = userEvent.setup();
    openDialog();
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Void credit note" }));
    expect(voidMutate).toHaveBeenCalledWith({ id: "cn-1" }, expect.anything());
  });

  it("a preview refusal shows FIXED copy by code (never the server text) and blocks the void", async () => {
    previewData = {
      refusal: SECRET,
      refusalCode: API_ERROR_CODES.CREDIT_NOTE_CREDIT_CONSUMED,
      restoresTotal: 0,
      invoices: [],
    };
    openDialog();
    expect(await screen.findByTestId("void-refusal")).toHaveTextContent(
      CREDIT_NOTE_ERROR_COPY[API_ERROR_CODES.CREDIT_NOTE_CREDIT_CONSUMED],
    );
    expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Void credit note" })).toBeDisabled();
  });

  it.each([[API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED], [undefined]])(
    "a failed void (code %s) toasts fixed copy and never the server message",
    async (code) => {
      voidMutate.mockImplementation((_v: unknown, opts: any) =>
        opts.onError({ response: { data: { code, message: SECRET } } }),
      );
      const user = userEvent.setup();
      openDialog();
      const dialog = within(await screen.findByRole("dialog"));
      await user.click(dialog.getByRole("button", { name: "Void credit note" }));

      const expected = code
        ? CREDIT_NOTE_ERROR_COPY[code as keyof typeof CREDIT_NOTE_ERROR_COPY]
        : "Nothing was changed. Please try again.";
      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
    },
  );
});
