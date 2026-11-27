"use client";

import * as React from "react";
import { API_ERROR_CODES } from "@routeflow/types";
import { AdminModal } from "../../../../_components/AdminModal";
import {
  getRefundable,
  notifyBillingEventsChanged,
  onBillingEventsChanged,
  recordStaffRefund,
  utcDay,
  type ExistingStaffRefund,
  type RefundablePayment,
  type RefundableView,
} from "@/lib/api/platform-billing-events";
import { formatMoney } from "@/lib/format";

/** R-2 (SA-1297, words W1-W9 + A1): the finished copy. Nothing here is typed money: the amount is the record's own string. */
export const STAFF_REFUND_COPY = {
  button: "Record staff refund",
  noPayment: "No yearly payment to refund.",
  title: "Record a staff refund",
  lead: "Use this after you have refunded the yearly payment and cancelled the subscription in the payment provider's dashboard. This records it here. It doesn't move any money or change the subscription here.",
  leadNote: "A recorded refund can't be edited.",
  refundDate: "Refund date",
  reference: "Provider refund reference",
  referenceHelp: "The refund's reference from the payment provider's dashboard.",
  refundedInFull: "I refunded this yearly payment in full.",
  cancelledImmediately: "I cancelled the subscription immediately, not at the end of the period.",
  note: "Note (optional)",
  submit: "Record refund",
  cancel: "Cancel",
  success: "Staff refund recorded.",
  windowPassed:
    "The refund date is more than 14 days after the yearly payment, so it can't be recorded as a staff refund.",
  noPaymentRefusal: "This business has no yearly payment to refund.",
  generic: "Couldn't record the refund. Try again.",
} as const;

/** "{amount}" for the read-only line: the record's string, only formatted (USD through the one money formatter). */
export const paymentAmountText = (p: RefundablePayment): string =>
  p.currency.toLowerCase() === "usd"
    ? formatMoney(p.amount)
    : `${p.amount} ${p.currency.toUpperCase()}`;

const windowEnded = (deadlineDate: string) => `The 14-day refund window ended on ${deadlineDate}.`;
const recordedOn = (e: ExistingStaffRefund) =>
  `Staff refund recorded on ${e.refundDate ?? utcDay(e.createdAt)} · Ref ${e.providerRef ?? "—"}.`;
const alreadyRecorded = (e: ExistingStaffRefund) =>
  `A staff refund is already recorded for this payment: ${e.refundDate ?? utcDay(e.createdAt)} · Ref ${e.providerRef ?? "—"} · by ${e.actorName ?? "unknown"}.`;
const outOfRange = (paidDate: string, lastDate: string) =>
  `Choose a refund date between ${paidDate} and ${lastDate}.`;

type ErrShape = { response?: { status?: number; data?: Record<string, unknown> } };
const errCode = (err: unknown): string | undefined => {
  const c = (err as ErrShape)?.response?.data?.code;
  return typeof c === "string" ? c : undefined;
};

export type RefundBanner = { type: "success" | "error" | "info"; text: string };

interface DialogProps {
  open: boolean;
  tenantId: string;
  payment: RefundablePayment;
  /** The server's refund deadline (paidAt + 14 x 24h). */
  deadline: string;
  onClose: () => void;
  /** The tab's inline banner (its setMsg). */
  onMessage: (m: RefundBanner) => void;
}

const FIELD =
  "w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none";
const HELP = "mt-1 text-xs text-slate-400";

export function StaffRefundDialog({
  open,
  tenantId,
  payment,
  deadline,
  onClose,
  onMessage,
}: DialogProps) {
  const paidDate = utcDay(payment.paidAt);
  const deadlineDate = utcDay(deadline);
  // Today's UTC day, capped at the window's last UTC day: the field's default AND its max (SA-1297 item 1).
  const today = utcDay(new Date());
  const lastDate = today < deadlineDate ? today : deadlineDate;
  const pastWindow = today > deadlineDate;

  const [refundDate, setRefundDate] = React.useState(lastDate);
  const [reference, setReference] = React.useState("");
  const [inFull, setInFull] = React.useState(false);
  const [cancelled, setCancelled] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  const ready = inFull && cancelled && reference.trim() !== "" && refundDate !== "" && !busy;

  const submit = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await recordStaffRefund(tenantId, {
        refundedInFull: true,
        cancelledImmediately: true,
        providerRef: reference.trim(),
        refundDate,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onMessage({ type: "success", text: STAFF_REFUND_COPY.success });
      notifyBillingEventsChanged(tenantId);
      onClose();
    } catch (err: unknown) {
      const code = errCode(err);
      const data = (err as ErrShape)?.response?.data ?? {};
      if (code === API_ERROR_CODES.STAFF_REFUND_WINDOW_PASSED) {
        setRefusal(STAFF_REFUND_COPY.windowPassed);
      } else if (code === API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED) {
        setRefusal(
          alreadyRecorded({
            createdAt: String(data.createdAt ?? ""),
            providerRef: (data.providerRef as string | null | undefined) ?? null,
            actorName: (data.actorName as string | null | undefined) ?? null,
            refundDate: (data.refundDate as string | null | undefined) ?? null,
          }),
        );
        notifyBillingEventsChanged(tenantId);
      } else if (code === API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT) {
        setRefusal(STAFF_REFUND_COPY.noPaymentRefusal);
        notifyBillingEventsChanged(tenantId);
      } else if ((err as ErrShape)?.response?.status === 400) {
        setRefusal(outOfRange(paidDate, lastDate));
      } else {
        setRefusal(STAFF_REFUND_COPY.generic);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminModal
      open={open}
      onClose={onClose}
      title={STAFF_REFUND_COPY.title}
      sheet
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
          >
            {STAFF_REFUND_COPY.cancel}
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={submit}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {STAFF_REFUND_COPY.submit}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 text-sm text-slate-300">
          <p>{STAFF_REFUND_COPY.lead}</p>
          <p>{STAFF_REFUND_COPY.leadNote}</p>
        </div>
        <p className="text-sm text-white">
          {`Yearly payment: ${paymentAmountText(payment)}, paid on ${paidDate}.`}
        </p>

        <div>
          <label
            htmlFor="staff-refund-date"
            className="mb-1 block text-xs font-medium text-slate-400"
          >
            {STAFF_REFUND_COPY.refundDate}
          </label>
          <input
            id="staff-refund-date"
            type="date"
            value={refundDate}
            min={paidDate}
            max={lastDate}
            onChange={(e) => setRefundDate(e.target.value)}
            className={FIELD}
          />
          {pastWindow && <p className={HELP}>{windowEnded(deadlineDate)}</p>}
        </div>

        <div>
          <label
            htmlFor="staff-refund-ref"
            className="mb-1 block text-xs font-medium text-slate-400"
          >
            {STAFF_REFUND_COPY.reference}
          </label>
          <input
            id="staff-refund-ref"
            type="text"
            required
            value={reference}
            maxLength={128}
            onChange={(e) => setReference(e.target.value)}
            aria-describedby="staff-refund-ref-help"
            className={FIELD}
          />
          <p id="staff-refund-ref-help" className={HELP}>
            {STAFF_REFUND_COPY.referenceHelp}
          </p>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={inFull}
            onChange={(e) => setInFull(e.target.checked)}
            className="mt-0.5"
          />
          <span>{STAFF_REFUND_COPY.refundedInFull}</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={cancelled}
            onChange={(e) => setCancelled(e.target.checked)}
            className="mt-0.5"
          />
          <span>{STAFF_REFUND_COPY.cancelledImmediately}</span>
        </label>

        <div>
          <label
            htmlFor="staff-refund-note"
            className="mb-1 block text-xs font-medium text-slate-400"
          >
            {STAFF_REFUND_COPY.note}
          </label>
          <textarea
            id="staff-refund-note"
            rows={3}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className={FIELD}
          />
        </div>

        {refusal && (
          <p role="alert" className="text-sm font-medium text-red-400">
            {refusal}
          </p>
        )}
      </div>
    </AdminModal>
  );
}

/**
 * The Subscription card's staff-refund control: the button when the latest yearly payment has no recorded refund,
 * otherwise one muted line saying why (A1 W2). It reads `GET .../staff-refunds/refundable` and re-reads on every change.
 */
export function StaffRefundSection({
  tenantId,
  onMessage,
}: {
  tenantId: string;
  onMessage: (m: RefundBanner) => void;
}) {
  const [view, setView] = React.useState<RefundableView | null>(null);
  const [failed, setFailed] = React.useState(false);
  // The payment the open dialog was started for: kept apart from `view`, which refreshes under it (a refused submit
  // re-reads the state, and the dialog must stay open with its inline refusal).
  const [opened, setOpened] = React.useState<{
    payment: RefundablePayment;
    deadline: string;
  } | null>(null);

  const load = React.useCallback(() => {
    getRefundable(tenantId)
      .then((v) => {
        setView(v);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [tenantId]);

  React.useEffect(() => {
    load();
    return onBillingEventsChanged(tenantId, load);
  }, [tenantId, load]);

  const dialog = opened && (
    <StaffRefundDialog
      open
      tenantId={tenantId}
      payment={opened.payment}
      deadline={opened.deadline}
      onClose={() => setOpened(null)}
      onMessage={onMessage}
    />
  );
  if (failed || !view) return <>{dialog}</>;
  let body: React.ReactNode;
  if (view.refusal === API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT || !view.payment) {
    body = <p className="mt-3 text-xs text-slate-400">{STAFF_REFUND_COPY.noPayment}</p>;
  } else if (view.refusal === API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED && view.existing) {
    body = <p className="mt-3 text-xs text-slate-400">{recordedOn(view.existing)}</p>;
  } else {
    const { payment, deadline } = view;
    body = (
      <div className="mt-3">
        <button
          type="button"
          disabled={!deadline}
          onClick={() => deadline && setOpened({ payment, deadline })}
          className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500"
        >
          {STAFF_REFUND_COPY.button}
        </button>
      </div>
    );
  }
  return (
    <>
      {body}
      {dialog}
    </>
  );
}
