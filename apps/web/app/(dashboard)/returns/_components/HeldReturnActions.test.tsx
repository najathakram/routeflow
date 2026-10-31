import * as React from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import { HeldReturnActions } from "./HeldReturnActions";
import type { Return } from "@/lib/api/returns";

/**
 * SA-1060 PR-1, row R-1 (screen half): an INLINE return that is RECEIVED and held (DRIVER_CAP or ALREADY_RETURNED, no credit note
 * yet) shows Approve and Reject; nothing else does. The screen uses the API's own semantics and does no money math: Approve sends
 * no amount (the server credits the held amount), an "already returned" hold sends the reason staff typed, Reject sends nothing.
 */
const approveMutate = jest.fn();
const rejectMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useApproveInlineReturn: () => ({ mutate: approveMutate, isPending: false }),
  useRejectInlineReturn: () => ({ mutate: rejectMutate, isPending: false }),
}));

const base = {
  id: "ret-1",
  returnNumber: "R-100",
  kind: "INLINE",
  status: "RECEIVED",
  holdReason: "DRIVER_CAP",
  heldAmount: "40.0000",
  creditNoteId: undefined,
} as unknown as Return;
const held = (over: Partial<Return> = {}) => ({ ...base, ...over }) as Return;

beforeEach(() => {
  approveMutate.mockClear();
  rejectMutate.mockClear();
});

describe("HeldReturnActions: who sees the buttons", () => {
  it.each([["DRIVER_CAP"], ["ALREADY_RETURNED"]])("%s hold: Approve and Reject show", (reason) => {
    renderWithProviders(<HeldReturnActions ret={held({ holdReason: reason } as never)} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.getByTestId("held-return-banner")).toHaveTextContent("Waiting for approval");
  });

  it.each([
    ["no hold", { holdReason: null }],
    ["a hold already rejected", { status: "REJECTED" }],
    ["a hold already credited", { creditNoteId: "cn-1" }],
    ["a hold already issued", { status: "REFUNDED" }],
    ["a standard return", { kind: "STANDARD" }],
    ["a reason that is not an approval hold", { holdReason: "CAPTURE_FAILED" }],
  ])("%s: nothing shows", (_n, over) => {
    renderWithProviders(<HeldReturnActions ret={held(over as never)} />);
    expect(screen.queryByTestId("held-return-banner")).toBeNull();
    expect(screen.queryByRole("button", { name: /approve|reject/i })).toBeNull();
  });
});

describe("HeldReturnActions: Approve and Reject send what the API takes", () => {
  it("a driver-cap hold approves with no amount and no reason", () => {
    renderWithProviders(<HeldReturnActions ret={held()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /approve/i }));
    expect(approveMutate).toHaveBeenCalledTimes(1);
    expect(approveMutate.mock.calls[0][0]).toEqual({ id: "ret-1" });
  });

  it("an already-returned hold needs a reason before it can be approved, and sends it trimmed", () => {
    renderWithProviders(
      <HeldReturnActions ret={held({ holdReason: "ALREADY_RETURNED" } as never)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /approve/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/reason/i), {
      target: { value: "  Customer showed the receipt  " },
    });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(approveMutate.mock.calls[0][0]).toEqual({
      id: "ret-1",
      reason: "Customer showed the receipt",
    });
  });

  it("Reject confirms, then sends the id alone", () => {
    renderWithProviders(<HeldReturnActions ret={held()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(rejectMutate).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /reject/i }));
    expect(rejectMutate).toHaveBeenCalledTimes(1);
    expect(rejectMutate.mock.calls[0][0]).toEqual({ id: "ret-1" });
  });
});

describe("HeldReturnActions: a refusal shows fixed copy, never the server's text", () => {
  const refuse = (response: unknown) => {
    renderWithProviders(<HeldReturnActions ret={held()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /approve/i }));
    approveMutate.mock.calls[0][1].onError({ response });
  };

  it("a 409 says a walk-in return is refunded at the till", async () => {
    refuse({ status: 409, data: { message: "server text that must not show" } });
    expect(
      await screen.findByText(
        "This return can't be approved. A walk-in return is refunded at the till, not credited.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/must not show/)).toBeNull();
  });

  it("a 400 says the return is no longer waiting", async () => {
    refuse({ status: 400, data: { message: "Only a return awaiting approval can be approved" } });
    expect(
      await screen.findByText("This return isn't waiting for approval anymore. Refresh the page."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/awaiting approval can be/)).toBeNull();
  });

  it("anything else keeps the retry line", async () => {
    refuse({ status: 500, data: { message: "boom: stack trace" } });
    expect(await screen.findByText("Please try again.")).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).toBeNull();
  });
});
