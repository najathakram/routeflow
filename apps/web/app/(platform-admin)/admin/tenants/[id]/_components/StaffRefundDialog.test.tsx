import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { API_ERROR_CODES } from "@routeflow/types";
import { formatMoney } from "@/lib/format";
import { StaffRefundSection } from "./StaffRefundDialog";
import { BillingEventsList } from "./BillingEventsList";

// R-2 tests 19 and 20 (SA-1297 + A1/A2): the button and the muted lines, then the dialog. The clock is pinned (L-353):
// only Date is faked, so findBy*/waitFor keep their real timers.
const NOW = new Date("2026-11-20T12:00:00.000Z");

const mockGetRefundable = jest.fn();
const mockRecord = jest.fn();
const mockList = jest.fn();
const mockToast = jest.fn();

jest.mock("@/lib/api/platform-billing-events", () => ({
  ...jest.requireActual("@/lib/api/platform-billing-events"),
  getRefundable: (id: string) => mockGetRefundable(id),
  recordStaffRefund: (...a: unknown[]) => mockRecord(...a),
  listBillingEvents: (id: string) => mockList(id),
}));
jest.mock("@routeflow/ui/web", () => ({ useToast: () => ({ toast: mockToast }) }));

const TENANT = "tenant-1";
const eligible = (over: Record<string, unknown> = {}) => ({
  payment: {
    invoiceId: "in_acme_1",
    amount: "1188.50",
    currency: "usd",
    paidAt: "2026-11-15T09:00:00.000Z",
  },
  deadline: "2026-11-29T09:00:00.000Z",
  refusal: null,
  existing: null,
  ...over,
});
const pastDeadline = () =>
  eligible({
    payment: {
      invoiceId: "in_acme_2",
      amount: "1188.50",
      currency: "usd",
      paidAt: "2026-11-01T09:00:00.000Z",
    },
    deadline: "2026-11-15T09:00:00.000Z",
  });
const apiError = (status: number, data: Record<string, unknown>) => ({
  response: { status, data },
});

const onMessage = jest.fn();
function renderSection() {
  return render(<StaffRefundSection tenantId={TENANT} onMessage={onMessage} />);
}

beforeEach(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "queueMicrotask",
      "nextTick",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "performance",
      "hrtime",
    ],
  });
  jest.clearAllMocks();
  mockList.mockResolvedValue([]);
});
afterEach(() => jest.useRealTimers());

describe("test 19: the button and the muted lines (Subscription card)", () => {
  it("an eligible payment shows an active button and no muted line", async () => {
    mockGetRefundable.mockResolvedValue(eligible());
    renderSection();
    const btn = await screen.findByRole("button", { name: "Record staff refund" });
    expect(btn).toBeEnabled();
    expect(screen.queryByText("No yearly payment to refund.")).toBeNull();
    expect(screen.queryByText(/Staff refund recorded on/)).toBeNull();
  });

  it("NO_YEARLY_PAYMENT shows one muted line and no button", async () => {
    mockGetRefundable.mockResolvedValue({
      payment: null,
      deadline: null,
      refusal: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT,
      existing: null,
    });
    renderSection();
    expect(await screen.findByText("No yearly payment to refund.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record staff refund" })).toBeNull();
  });

  it("an answer with no payment key at all reads as no yearly payment", async () => {
    mockGetRefundable.mockResolvedValue({ payment: null, deadline: null, existing: null });
    renderSection();
    expect(await screen.findByText("No yearly payment to refund.")).toBeInTheDocument();
  });

  it("ALREADY_RECORDED shows the existing date and reference as one muted line and no button", async () => {
    mockGetRefundable.mockResolvedValue(
      eligible({
        refusal: API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED,
        existing: {
          createdAt: "2026-11-19T10:00:00.000Z",
          providerRef: "re_acme_9",
          actorName: "acme-staff",
          refundDate: "2026-11-18",
        },
      }),
    );
    renderSection();
    expect(
      await screen.findByText("Staff refund recorded on 2026-11-18 · Ref re_acme_9."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record staff refund" })).toBeNull();
  });

  it("an eligible payment past the deadline keeps an active button; its dialog states when the window ended", async () => {
    mockGetRefundable.mockResolvedValue(pastDeadline());
    renderSection();
    const btn = await screen.findByRole("button", { name: "Record staff refund" });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("The 14-day refund window ended on 2026-11-15."),
    ).toBeInTheDocument();
  });

  it("a payment inside the window shows no window helper", async () => {
    mockGetRefundable.mockResolvedValue(eligible());
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Record staff refund" }));
    await screen.findByRole("dialog");
    expect(screen.queryByText(/The 14-day refund window ended on/)).toBeNull();
  });
});

describe("test 20: the dialog", () => {
  async function openDialog(view: unknown = eligible()) {
    mockGetRefundable.mockResolvedValue(view);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Record staff refund" }));
    return screen.findByRole("dialog");
  }
  const fill = (dialog: HTMLElement, ref = "re_acme_1") => {
    fireEvent.change(within(dialog).getByLabelText("Provider refund reference"), {
      target: { value: ref },
    });
    fireEvent.click(within(dialog).getByLabelText("I refunded this yearly payment in full."));
    fireEvent.click(
      within(dialog).getByLabelText(
        "I cancelled the subscription immediately, not at the end of the period.",
      ),
    );
  };

  it("shows the ruled words, the amount as the record's string, and the UTC-day date bounds", async () => {
    const dialog = await openDialog();
    expect(within(dialog).getByText("Record a staff refund")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Use this after you have refunded the yearly payment and cancelled the subscription in the payment provider's dashboard. This records it here. It doesn't move any money or change the subscription here.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("A recorded refund can't be edited.")).toBeInTheDocument();
    // the figure is the record's own string, only formatted
    expect(formatMoney("1188.50")).toBe("$1,188.50");
    expect(
      within(dialog).getByText("Yearly payment: $1,188.50, paid on 2026-11-15."),
    ).toBeInTheDocument();
    const date = within(dialog).getByLabelText("Refund date") as HTMLInputElement;
    expect(date.value).toBe("2026-11-20"); // today's UTC day (pinned clock), before the deadline
    expect(date.min).toBe("2026-11-15"); // paidAt's UTC day
    expect(date.max).toBe("2026-11-20");
    expect(
      within(dialog).getByText("The refund's reference from the payment provider's dashboard."),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Note (optional)")).toBeInTheDocument();
  });

  it("past the deadline the default and the max are the deadline's UTC day, not today", async () => {
    const dialog = await openDialog(pastDeadline());
    const date = within(dialog).getByLabelText("Refund date") as HTMLInputElement;
    expect(date.value).toBe("2026-11-15");
    expect(date.max).toBe("2026-11-15");
    expect(date.min).toBe("2026-11-01");
  });

  it("Record refund stays disabled until both boxes are ticked and the reference is filled in", async () => {
    const dialog = await openDialog();
    const submit = within(dialog).getByRole("button", { name: "Record refund" });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Provider refund reference"), {
      target: { value: "re_acme_1" },
    });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText("I refunded this yearly payment in full."));
    expect(submit).toBeDisabled();
    fireEvent.click(
      within(dialog).getByLabelText(
        "I cancelled the subscription immediately, not at the end of the period.",
      ),
    );
    expect(submit).toBeEnabled();
    fireEvent.change(within(dialog).getByLabelText("Provider refund reference"), {
      target: { value: "   " },
    });
    expect(submit).toBeDisabled();
  });

  it("a click sends exactly the ruled body: no amount, the typed reference and note, the UTC-day date", async () => {
    mockRecord.mockResolvedValue(undefined);
    const dialog = await openDialog();
    fill(dialog, "  re_acme_1  ");
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), {
      target: { value: "  customer asked  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record refund" }));
    await waitFor(() => expect(mockRecord).toHaveBeenCalledTimes(1));
    expect(mockRecord).toHaveBeenCalledWith(TENANT, {
      refundedInFull: true,
      cancelledImmediately: true,
      providerRef: "re_acme_1",
      refundDate: "2026-11-20",
      note: "customer asked",
    });
    expect(Object.keys(mockRecord.mock.calls[0][1])).not.toContain("amount");
  });

  it("WINDOW_PASSED is refused inline: the dialog stays open and keeps the reference and the note", async () => {
    mockRecord.mockRejectedValue(
      apiError(409, { code: API_ERROR_CODES.STAFF_REFUND_WINDOW_PASSED, message: "x" }),
    );
    const dialog = await openDialog();
    fill(dialog, "re_keep_me");
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), {
      target: { value: "keep this note" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record refund" }));
    expect(
      await within(dialog).findByText(
        "The refund date is more than 14 days after the yearly payment, so it can't be recorded as a staff refund.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      (within(dialog).getByLabelText("Provider refund reference") as HTMLInputElement).value,
    ).toBe("re_keep_me");
    expect((within(dialog).getByLabelText("Note (optional)") as HTMLTextAreaElement).value).toBe(
      "keep this note",
    );
    expect(onMessage).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("ALREADY_RECORDED is refused inline with the existing row's words; the list and the card refresh; the dialog stays", async () => {
    mockRecord.mockRejectedValue(
      apiError(409, {
        code: API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED,
        refundDate: "2026-11-18",
        providerRef: "re_acme_9",
        actorName: "acme-staff",
        createdAt: "2026-11-19T10:00:00.000Z",
      }),
    );
    mockGetRefundable.mockResolvedValueOnce(eligible());
    mockList.mockResolvedValue([]);
    render(<BillingEventsList tenantId={TENANT} />);
    const dialog = await openDialog();
    const listCalls = mockList.mock.calls.length;
    // the re-read after the refusal now says "already recorded"
    mockGetRefundable.mockResolvedValue(
      eligible({
        refusal: API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED,
        existing: {
          createdAt: "2026-11-19T10:00:00.000Z",
          providerRef: "re_acme_9",
          actorName: "acme-staff",
          refundDate: "2026-11-18",
        },
      }),
    );
    fill(dialog, "re_second_try");
    fireEvent.click(within(dialog).getByRole("button", { name: "Record refund" }));
    expect(
      await within(dialog).findByText(
        "A staff refund is already recorded for this payment: 2026-11-18 · Ref re_acme_9 · by acme-staff.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockList.mock.calls.length).toBeGreaterThan(listCalls));
    expect(
      await screen.findByText("Staff refund recorded on 2026-11-18 · Ref re_acme_9."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("NO_YEARLY_PAYMENT and the server's 400 backstop are refused inline in their ruled words", async () => {
    mockRecord.mockRejectedValueOnce(
      apiError(404, { code: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT }),
    );
    const dialog = await openDialog();
    fill(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Record refund" }));
    expect(
      await within(dialog).findByText("This business has no yearly payment to refund."),
    ).toBeInTheDocument();

    mockRecord.mockRejectedValueOnce(
      apiError(400, { message: "Choose a refund date between the payment date and today." }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Record refund" }));
    expect(
      await within(dialog).findByText("Choose a refund date between 2026-11-15 and 2026-11-20."),
    ).toBeInTheDocument();
  });

  it("201: success goes to the tab's inline banner with the ruled words, the dialog closes, no toast", async () => {
    mockRecord.mockResolvedValue(undefined);
    const dialog = await openDialog();
    fill(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Record refund" }));
    await waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith({ type: "success", text: "Staff refund recorded." }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("success refreshes the billing-events list and the card", async () => {
    mockRecord.mockResolvedValue(undefined);
    mockList.mockResolvedValue([]);
    render(<BillingEventsList tenantId={TENANT} />);
    const dialog = await openDialog();
    const listCalls = mockList.mock.calls.length;
    const refundCalls = mockGetRefundable.mock.calls.length;
    fill(dialog);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Record refund" }));
    });
    await waitFor(() => expect(mockList.mock.calls.length).toBeGreaterThan(listCalls));
    await waitFor(() => expect(mockGetRefundable.mock.calls.length).toBeGreaterThan(refundCalls));
  });
});
