"use client";

// ─── Record a return, inline — office web capture (PR 1) ───────────────────────
//
// quote → confirm → result. Customer-scoped quote (no orderId); a carrying order is
// required for capture — pre-set from the entry order when opened from order detail,
// otherwise picked from the customer's own orders. No held/approve/reject UI (PR 2), no
// "different price" excess option or placeholder for it (PR 2b), no mobile mirror (PR 3).
// See local-assets/handoff/2026-09-22/SPEC-inline-returns-capture-web-PR1.md.
//
// #2406 (SA-484): the "lines"+"quote" steps themselves now live in the shared
// `InlineReturnSection` (CreateOrderModal and the order-edit page mount the same component to
// build an `inlineReturn` payload for their own order create/update — see
// OrderInlineReturnsSection). This dialog still owns the order picker, the immediate capture
// call, and the "success"/"refused" screens — `InlineReturnSection` stays mounted underneath
// them (hidden, never unmounted) across a refusal so a retry doesn't lose the operator's typed
// lines/quote.
import * as React from "react";
import Link from "next/link";
import { Button, Modal, Select, useToast } from "@routeflow/ui/web";
import { useOrders } from "@/lib/api/orders";
import { useCaptureInlineReturn } from "@/lib/api/inline-returns";
import { useOptionalAuth } from "@/lib/auth-context";
import type { InlineReturnRecord } from "@routeflow/types";
import {
  buildCaptureRequest,
  canOverrideReturnCredit,
  missingAlreadyReturnedReasons,
  DEFAULT_EXCESS_OPTION,
  extractRefusalMessage,
  keyReusedReturnOf,
  mintReturnKey,
  refundAmountOf,
} from "@routeflow/returns";
import { InlineReturnSection, type InlineReturnSectionState } from "./InlineReturnSection";

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export interface RecordInlineReturnDialogProps {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName?: string;
  /** The order this dialog was opened FROM — pre-filters Step 1 to its line items and is
   *  used as the carrying order (capture's `orderId`) with no extra picker. Omit when
   *  opening from customer detail (the order picker below is then required). */
  orderId?: string;
  /** Optional: called once when a return is recorded (the counter receipt shows its own hand-back note). */
  onRecorded?: (result: InlineReturnRecord) => void;
}

type DialogPhase = "capture" | "success" | "refused";

export function RecordInlineReturnDialog({
  open,
  onClose,
  customerId,
  customerName,
  orderId,
  onRecorded,
}: RecordInlineReturnDialogProps) {
  const role = useOptionalAuth()?.user?.role;
  const { toast } = useToast();
  const { data: customerOrders } = useOrders(
    { customerId, limit: 25 },
    { enabled: open && !orderId },
  );

  const [phase, setPhase] = React.useState<DialogPhase>("capture");
  const [carryingOrderId, setCarryingOrderId] = React.useState(orderId ?? "");
  const [refusalMessage, setRefusalMessage] = React.useState("");
  // #2647: the return already recorded under this capture key (a key-reused 409), else null.
  const [recordedReturn, setRecordedReturn] = React.useState<{
    returnId: string;
    returnNumber: string | null;
  } | null>(null);
  const [result, setResult] = React.useState<InlineReturnRecord | null>(null);
  const [openSeq, setOpenSeq] = React.useState(0);
  const [sectionState, setSectionState] = React.useState<InlineReturnSectionState>({
    step: "lines",
    lines: [],
    quote: null,
    excessOption: DEFAULT_EXCESS_OPTION,
    captureReason: "",
  });
  // One UUID per capture ATTEMPT — held in a ref (not state) so a re-render never regenerates
  // it, and reused unchanged across a retry of the SAME attempt (SA-071a #2, corrected
  // 2026-09-22: the capture response carries no `replayed` flag — any 200 is success).
  const returnKeyRef = React.useRef("");

  const captureMutation = useCaptureInlineReturn();

  // Fresh attempt every time the dialog opens — bumps `openSeq`, which InlineReturnSection
  // takes as its own reset signal (clearing lines/quote/reason and re-seeding from the entry
  // order's line items, same as this dialog used to do inline).
  React.useEffect(() => {
    if (!open) return;
    setOpenSeq((n) => n + 1);
    setPhase("capture");
    setCarryingOrderId(orderId ?? "");
    setResult(null);
    setRefusalMessage("");
    setRecordedReturn(null);
    returnKeyRef.current = "";
  }, [open, orderId]);

  function handleConfirm() {
    if (!sectionState.captureReason) {
      toast({ title: "Choose a reason before confirming", variant: "error" });
      return;
    }
    if (!returnKeyRef.current) returnKeyRef.current = mintReturnKey();
    captureMutation.mutate(
      buildCaptureRequest({
        customerId,
        orderId: carryingOrderId,
        lines: sectionState.lines,
        returnKey: returnKeyRef.current,
        reason: sectionState.captureReason,
      }),
      {
        onSuccess: (data) => {
          setResult(data);
          setPhase("success");
          onRecorded?.(data);
        },
        onError: (err) => {
          setRefusalMessage(extractRefusalMessage(err));
          // #2647: the earlier capture WAS recorded: link it and clear the draft (a fresh key and a
          // re-seeded section), so the same goods are not re-entered and credited twice.
          const recorded = keyReusedReturnOf(err);
          setRecordedReturn(recorded);
          if (recorded) {
            returnKeyRef.current = "";
            setOpenSeq((n) => n + 1);
          }
          setPhase("refused");
        },
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a return"
      description={customerName ? `For ${customerName}` : undefined}
      className="max-w-2xl"
      scroll
    >
      {/* The order picker is dialog-owned state (carryingOrderId) — safe to unmount/remount
       *  for real; InlineReturnSection below is NOT: it keeps running (hidden) across a
       *  refusal/success screen so "Back" resumes with the SAME lines/quote already typed
       *  or fetched (see the file-header note) — passing `hidden` instead of unmounting. */}
      {phase === "capture" && !orderId && sectionState.step === "lines" && (
        <div className="mb-4">
          <Select
            label="Which order should this credit apply to?"
            value={carryingOrderId}
            onChange={(e) => setCarryingOrderId(e.target.value)}
            options={[
              { value: "", label: "Select an order…" },
              ...(customerOrders?.data ?? [])
                .filter((o) => o.status !== "CANCELLED")
                .map((o) => ({ value: o.id, label: `Order #${o.orderNumber}` })),
            ]}
          />
        </div>
      )}
      <InlineReturnSection
        hidden={phase !== "capture"}
        customerId={customerId}
        entryOrderId={orderId}
        resetToken={openSeq}
        getQuoteEnabled={!!carryingOrderId}
        onStateChange={setSectionState}
        renderLinesActions={() => (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )}
        renderQuoteActions={() => (
          <Button
            disabled={
              !sectionState.captureReason ||
              // B961: staff must give a reason for every "already returned or credited" product (the server refuses otherwise)
              (!!sectionState.quote &&
                canOverrideReturnCredit(role) &&
                missingAlreadyReturnedReasons(sectionState.lines, sectionState.quote).length > 0)
            }
            loading={captureMutation.isPending}
            onClick={handleConfirm}
          >
            Issue credit note and receive goods
          </Button>
        )}
        onQuoteRefused={(message) => {
          setRefusalMessage(message);
          setPhase("refused");
        }}
      />

      {phase === "success" && result && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-navy">Return recorded</p>
          <dl className="space-y-1 text-sm text-navy">
            {result.returnNumber && (
              <div className="flex justify-between">
                <dt className="text-navy/70">Return</dt>
                <dd>
                  <a className="text-brand-600 underline" href={`/returns/${result.id}`}>
                    #{result.returnNumber}
                  </a>
                </dd>
              </div>
            )}
            {result.creditNoteId && (
              <div className="flex justify-between">
                <dt className="text-navy/70">Credit note</dt>
                <dd>
                  <a
                    className="text-brand-600 underline"
                    href={`/credit-notes/${result.creditNoteId}`}
                  >
                    View credit note
                  </a>
                </dd>
              </div>
            )}
            {refundAmountOf(result.refundAmount) !== null && (
              <div className="flex justify-between">
                <dt className="text-navy/70">Amount</dt>
                <dd>{money(refundAmountOf(result.refundAmount) as number)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-navy/70">Order</dt>
              <dd>
                <a className="text-brand-600 underline" href={`/orders/${result.orderId}`}>
                  View order
                </a>
              </dd>
            </div>
          </dl>
          {result.parkedReversals && (
            <div
              data-testid="inline-return-parked-warning"
              className="rounded-lg border border-amber-300 bg-amber-50 p-3"
            >
              <p className="text-sm font-medium text-navy">Ledger reversal parked</p>
              <p className="text-xs text-navy/70">
                The credit note and refund are recorded, but {result.parkedReversals.pieces}{" "}
                piece(s) across {result.parkedReversals.count} line(s) were not taken off the
                regulated sales ledger. The original sale&apos;s pack size is unknown, so the system
                could not work out the reversal safely. The period cannot be filed until this is
                resolved. Next step: open the regulated report, supply the pack size for the parked
                line(s), and resolve them.
              </p>
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}

      {phase === "refused" && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-danger">{refusalMessage}</p>
          {recordedReturn && (
            <Link
              data-testid="inline-return-recorded-link"
              href={`/returns/${recordedReturn.returnId}`}
              className="text-sm font-medium text-plum underline"
            >
              Open {recordedReturn.returnNumber ?? "the recorded return"}
            </Link>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="secondary" onClick={() => setPhase("capture")}>
              Back
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
