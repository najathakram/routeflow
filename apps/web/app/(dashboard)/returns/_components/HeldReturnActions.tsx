"use client";

import * as React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { isInlineHoldReason } from "@routeflow/types";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { useApproveInlineReturn, useRejectInlineReturn } from "@/lib/api/inline-returns";
import type { Return } from "@/lib/api/returns";

/**
 * SA-1060 PR-1 (W-1037): the approval screen. An INLINE return that is RECEIVED and held (DRIVER_CAP or ALREADY_RETURNED) with no
 * credit note yet waits for staff; this shows why, and the two calls the API already has. It does no money math: Approve sends no
 * amount (the server credits the held amount), an "already returned" hold sends the reason staff typed, and every number shown
 * is the server's.
 */
const REASON_MAX = 200;

/** The server's own sentence for a refusal (4xx), as sent; anything else keeps the retry line. */
function refusalText(err: unknown): string {
  const r = (err as { response?: { status?: number; data?: { message?: unknown } } } | null)
    ?.response;
  const sentence = r?.data?.message;
  return r?.status !== undefined &&
    r.status >= 400 &&
    r.status < 500 &&
    typeof sentence === "string"
    ? sentence
    : "Please try again.";
}

const WHY: Record<string, string> = {
  DRIVER_CAP: "A driver took this return above the driver limit.",
  ALREADY_RETURNED: "These goods were already returned or credited.",
};

export function HeldReturnActions({ ret }: { ret: Return }) {
  const { toast } = useToast();
  const approve = useApproveInlineReturn();
  const reject = useRejectInlineReturn();
  const [approveOpen, setApproveOpen] = React.useState(false);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const held =
    ret.kind === "INLINE" &&
    ret.status === "RECEIVED" &&
    !ret.creditNoteId &&
    isInlineHoldReason(ret.holdReason);
  if (!held) return null;

  const needsReason = ret.holdReason === "ALREADY_RETURNED";
  const trimmed = reason.trim();
  const heldAmount = ret.heldAmount != null ? Number(ret.heldAmount) : null;

  const doApprove = () => {
    approve.mutate(needsReason ? { id: ret.id, reason: trimmed } : { id: ret.id }, {
      onSuccess: () => {
        setApproveOpen(false);
        setReason("");
        toast({ title: "Return approved", variant: "success" });
      },
      onError: (err) =>
        toast({
          title: "Couldn't approve this return",
          description: refusalText(err),
          variant: "error",
        }),
    });
  };

  const doReject = () => {
    reject.mutate(
      { id: ret.id },
      {
        onSuccess: () => {
          setRejectOpen(false);
          toast({ title: "Return rejected", variant: "info" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't reject this return",
            description: refusalText(err),
            variant: "error",
          }),
      },
    );
  };

  return (
    <>
      <div
        className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-navy"
        data-testid="held-return-banner"
      >
        <p className="font-semibold">Waiting for approval</p>
        <p className="text-navy/70">
          {WHY[ret.holdReason as string]} The goods are received
          {heldAmount != null && Number.isFinite(heldAmount)
            ? `, and the $${heldAmount.toFixed(2)} credit isn't issued yet.`
            : ", and the credit isn't issued yet."}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          leftIcon={<CheckCircle2 className="h-4 w-4" />}
          onClick={() => setApproveOpen(true)}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="danger"
          leftIcon={<XCircle className="h-4 w-4" />}
          onClick={() => setRejectOpen(true)}
        >
          Reject
        </Button>
      </div>

      <Modal
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Approve this return?"
        description={`Approving ${ret.returnNumber} issues the credit.`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setApproveOpen(false)}
              disabled={approve.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={doApprove}
              loading={approve.isPending}
              disabled={needsReason && trimmed.length === 0}
            >
              Approve return
            </Button>
          </>
        }
      >
        {needsReason ? (
          <div className="space-y-1">
            <label htmlFor="held-return-reason" className="text-sm font-medium text-navy">
              Reason
            </label>
            <textarea
              id="held-return-reason"
              value={reason}
              maxLength={REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="text-xs text-navy/60">Say why these goods are credited again.</p>
          </div>
        ) : (
          <p className="text-sm text-navy/70">The customer gets the held credit.</p>
        )}
      </Modal>

      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject this return?"
        description={`${ret.returnNumber} gets no credit. This can't be undone.`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setRejectOpen(false)}
              disabled={reject.isPending}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={doReject} loading={reject.isPending}>
              Reject return
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">No credit note is issued for it.</p>
      </Modal>
    </>
  );
}
