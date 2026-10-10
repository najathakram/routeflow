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
import {
  refundReturn,
  storeCreditInstead,
  useCaptureInlineReturn,
  useInlineReturnQuote,
} from "@/lib/api/inline-returns";
import { useOptionalAuth } from "@/lib/auth-context";
import type {
  InlineReturnQuoteResponse,
  InlineReturnRecord,
  InlineReturnRefundEligibility,
  InlineRefundTender,
  InlineReturnResolution,
} from "@routeflow/types";
import {
  buildCaptureRequest,
  canOverrideReturnCredit,
  missingAlreadyReturnedReasons,
  DEFAULT_EXCESS_OPTION,
  extractRefusalMessage,
  keyReusedReturnOf,
  buildQuoteRequest,
  mintReturnKey,
  refundAmountOf,
} from "@routeflow/returns";
import {
  REFUND_COPY,
  TENDER_OPTIONS,
  handBackLine,
  refundErrorKind,
  tenderFromPaidMethods,
  TERMINAL_REFUND_ERRORS,
  type RefundErrorKind,
} from "./refund-copy";
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
  /** POS-4b: offer "Store credit or Refund" on the quote step (counter receipt + order detail only).
   *  Off (customer detail) = today's dialog, no choice block. */
  allowRefund?: boolean;
  /** Optional: called once when a return is fully recorded — after the refund, if one was chosen
   *  (the counter receipt shows its own hand-back note from `info`). */
  onRecorded?: (result: InlineReturnRecord, info?: RecordedInfo) => void;
  /** W21b: Radix close-focus hook, so the opener can take focus back (no Radix trigger here). */
  onCloseAutoFocus?: (event: Event) => void;
}

/** Refund refusals after a saved capture where the goods are in and nothing was paid out. */
const PENDING_ON_CLOSE: ReadonlySet<RefundErrorKind> = new Set([
  "failed",
  "changed",
  "forbidden",
  "needsPaid",
  "notRefundable",
  "paidWithCredit",
]);
/** Refusals where the saved return can still be given as store credit (not a 403). */
const CREDIT_INSTEAD: ReadonlySet<RefundErrorKind> = new Set([
  "needsPaid",
  "notRefundable",
  "paidWithCredit",
]);

export interface RecordedInfo {
  resolution: InlineReturnResolution;
  tender?: InlineRefundTender;
  amount?: number;
  /** SA-727b: the return is saved but its refund is still pending (nothing paid out). */
  pending?: boolean;
}

type DialogPhase = "capture" | "success" | "refused";

/** The real amount a 409 REFUND_AMOUNT_CHANGED body carries; null when absent or unusable. */
function serverAmountOf(err: unknown): number | null {
  const amount = (err as { response?: { data?: { amount?: unknown } } } | undefined)?.response?.data
    ?.amount;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function RecordInlineReturnDialog({
  open,
  onClose,
  customerId,
  customerName,
  orderId,
  allowRefund = false,
  onRecorded,
  onCloseAutoFocus,
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
  const requoteMutation = useInlineReturnQuote();

  // POS-4b: refund-vs-credit state. `saved` = the return the capture recorded (a refund retry
  // never re-captures); `busyRef` absorbs a double click before React re-renders the disabled button.
  const [resolution, setResolution] = React.useState<InlineReturnResolution>("STORE_CREDIT");
  const [tender, setTender] = React.useState<InlineRefundTender | null>(null);
  const [saved, setSaved] = React.useState<InlineReturnRecord | null>(null);
  const [refunding, setRefunding] = React.useState(false);
  const [refundError, setRefundError] = React.useState<RefundErrorKind | null>(null);
  const [refundDone, setRefundDone] = React.useState<{
    tender: InlineRefundTender;
    amount: number;
  } | null>(null);
  const [requoteOverride, setRequoteOverride] = React.useState<InlineReturnQuoteResponse | null>(
    null,
  );
  // The amount the 409 REFUND_AMOUNT_CHANGED body carried: the server's real figure, which the
  // clerk's fresh confirm sends as expectedAmount (no re-quote, so it cannot loop on a re-priced quote).
  const [serverAmount, setServerAmount] = React.useState<number | null>(null);
  const busyRef = React.useRef(false);
  // a refund POST already failed once: a later RETURN_ALREADY_RESOLVED means "check before handing over"
  const retriedRef = React.useRef(false);
  const pendingReportedRef = React.useRef(false);
  const captureSentRef = React.useRef(false);
  const [crediting, setCrediting] = React.useState(false);
  const [requoting, setRequoting] = React.useState(false);

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
    setResolution("STORE_CREDIT");
    setTender(null);
    setSaved(null);
    setRefunding(false);
    setRefundError(null);
    setRefundDone(null);
    setRequoteOverride(null);
    setServerAmount(null);
    setCrediting(false);
    setRequoting(false);
    retriedRef.current = false;
    pendingReportedRef.current = false;
    captureSentRef.current = false;
    busyRef.current = false;
  }, [open, orderId]);

  const quoted = sectionState.quote as
    (InlineReturnQuoteResponse & Partial<InlineReturnRefundEligibility>) | null;
  // F4: a sale paid with store credit goes back as store credit: show the refund as unavailable, not hidden.
  const paidWithCredit =
    allowRefund && !quoted?.canRefund && !!quoted?.paidWithStoreCredit && !quoted?.customerIsWalkIn;
  const showChoice = allowRefund && (!!quoted?.canRefund || paidWithCredit);
  const walkIn = showChoice && !!quoted?.canRefund && !!quoted?.customerIsWalkIn;
  const effResolution: InlineReturnResolution =
    !showChoice || paidWithCredit ? "STORE_CREDIT" : walkIn ? "REFUND" : resolution;
  const effTender: InlineRefundTender = tender ?? tenderFromPaidMethods(quoted?.paidMethods);
  const quotedAmount = quoted?.total ?? 0;
  const shownAmount = serverAmount ?? quotedAmount;
  // A 409 that carried the server's figure: the quote's Total follows it, so the screen never shows two amounts. Keyed on the
  // figure alone (the latest quote rides in a ref) so handing it down cannot feed back into its own quote state.
  const quotedRef = React.useRef(quoted);
  quotedRef.current = quoted;
  const serverQuote = React.useMemo(
    () =>
      serverAmount !== null && quotedRef.current
        ? { ...quotedRef.current, total: serverAmount }
        : null,
    [serverAmount],
  );

  /** The server's figure once a capture is saved; the quote only before (or after a re-quote). */
  function savedAmountOf(ret: InlineReturnRecord): number {
    if (serverAmount !== null) return serverAmount;
    if (requoteOverride) return quotedAmount;
    return refundAmountOf(ret.refundAmount) ?? quotedAmount;
  }

  function classify(err: unknown): RefundErrorKind {
    const kind = refundErrorKind(err);
    return kind === "resolved" && retriedRef.current ? "resolvedAfterRetry" : kind;
  }

  function doRetry(ret: InlineReturnRecord) {
    if (busyRef.current) return;
    busyRef.current = true;
    retriedRef.current = true;
    doRefund(ret);
  }

  // SA-727b: a saved REFUND-intent return whose refund is pending is credited instead (never re-captured).
  function doStoreCredit(ret: InlineReturnRecord) {
    if (busyRef.current) return;
    busyRef.current = true;
    retriedRef.current = true;
    setCrediting(true);
    setRefundError(null);
    storeCreditInstead(ret.id).then(
      (rec) => {
        busyRef.current = false;
        setCrediting(false);
        pendingReportedRef.current = true;
        setResult(rec);
        setPhase("success");
        onRecorded?.(rec, {
          resolution: "STORE_CREDIT",
          amount: refundAmountOf(rec.refundAmount) ?? savedAmountOf(ret),
        });
      },
      (err: unknown) => {
        busyRef.current = false;
        setCrediting(false);
        setRefundError(classify(err));
      },
    );
  }

  /** Closing with a saved return whose refund never went through reports it as pending, once. */
  function handleClose() {
    // Goods received, nothing paid out: everything except "already resolved another way".
    const unresolved = !refundError || PENDING_ON_CLOSE.has(refundError);
    if (saved && !refundDone && phase === "capture" && unresolved && !pendingReportedRef.current) {
      pendingReportedRef.current = true;
      onRecorded?.(saved, {
        resolution: "REFUND",
        tender: effTender,
        amount: savedAmountOf(saved),
        pending: true,
      });
    }
    onClose();
  }

  function doRefund(ret: InlineReturnRecord) {
    setRefunding(true);
    setRefundError(null);
    const amount = savedAmountOf(ret);
    const used = effTender;
    refundReturn(ret.id, { tender: used, expectedAmount: amount }).then(
      () => {
        busyRef.current = false;
        setRefunding(false);
        pendingReportedRef.current = true;
        setRefundDone({ tender: used, amount });
        setResult(ret);
        setPhase("success");
        onRecorded?.(ret, { resolution: "REFUND", tender: used, amount });
      },
      (err: unknown) => {
        busyRef.current = false;
        setRefunding(false);
        const kind = classify(err);
        setRefundError(kind);
        const changedAmount = kind === "changed" ? serverAmountOf(err) : null;
        if (changedAmount !== null) {
          // The server's own figure came back: show it; the clerk's confirm re-POSTs with it.
          setServerAmount(changedAmount);
        } else if (kind === "changed") {
          // The amount moved under us: re-fetch the quote; the clerk must confirm the new figure.
          // A stale server amount from an earlier 409 must not outrank the re-quote.
          setServerAmount(null);
          setRequoting(true);
          requoteMutation.mutate(buildQuoteRequest(customerId, sectionState.lines), {
            onSuccess: (fresh) => {
              setRequoting(false);
              setRequoteOverride(fresh);
            },
            // A failed re-quote never lets the clerk confirm the old amount: the refund stays pending.
            onError: () => setRefundError("failed"),
          });
        }
      },
    );
  }

  function handleConfirm() {
    if (!sectionState.captureReason) {
      toast({ title: "Choose a reason before confirming", variant: "error" });
      return;
    }
    if (showChoice) {
      if (busyRef.current) return;
      busyRef.current = true;
      // Capture already recorded (a refund that needs a fresh confirm): re-POST ONLY the refund.
      if (saved) return doRefund(saved);
    }
    if (!returnKeyRef.current) returnKeyRef.current = mintReturnKey();
    // SA-727: the replay fingerprint includes `resolution`, so once a capture is sent with this key the choice locks
    // and a retry resends the identical body.
    captureSentRef.current = true;
    captureMutation.mutate(
      {
        ...buildCaptureRequest({
          customerId,
          orderId: carryingOrderId,
          lines: sectionState.lines,
          returnKey: returnKeyRef.current,
          reason: sectionState.captureReason,
        }),
        ...(showChoice ? { resolution: effResolution } : {}),
      },
      {
        onSuccess: (data) => {
          if (showChoice && effResolution === "REFUND") {
            setSaved(data);
            doRefund(data);
            return;
          }
          busyRef.current = false;
          setResult(data);
          setPhase("success");
          onRecorded?.(data, {
            resolution: "STORE_CREDIT",
            amount: refundAmountOf(data.refundAmount) ?? quotedAmount,
          });
        },
        onError: (err) => {
          busyRef.current = false;
          // A refused REFUND capture (service 403 REFUND_NOT_ALLOWED, or a plain guard 403) gets the fixed
          // refund-permission copy; the shared mapper would show "returns not enabled" or the server text.
          const refundDenied =
            showChoice &&
            effResolution === "REFUND" &&
            (err as { response?: { status?: number } } | undefined)?.response?.status === 403;
          setRefusalMessage(refundDenied ? REFUND_COPY.forbidden : extractRefusalMessage(err));
          // #2647: the earlier capture WAS recorded: link it and clear the draft (a fresh key and a
          // re-seeded section), so the same goods are not re-entered and credited twice.
          const recorded = keyReusedReturnOf(err);
          setRecordedReturn(recorded);
          if (recorded) {
            returnKeyRef.current = "";
            captureSentRef.current = false;
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
      onClose={handleClose}
      onCloseAutoFocus={onCloseAutoFocus}
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
        quoteOverride={serverQuote ?? requoteOverride}
        totalOnly={!!serverQuote}
        hideBack={!!saved}
        quoteNote={
          showChoice && effResolution === "REFUND" ? REFUND_COPY.quoteRefundNote : undefined
        }
        renderQuoteFooter={() =>
          showChoice ? (
            <RefundChoice
              amount={money(shownAmount)}
              walkIn={walkIn}
              refundUnavailable={paidWithCredit}
              resolution={effResolution}
              onResolution={setResolution}
              tender={effTender}
              onTender={setTender}
              locked={
                !!saved ||
                refunding ||
                crediting ||
                captureMutation.isPending ||
                captureSentRef.current
              }
              error={refundError}
            />
          ) : null
        }
        renderLinesActions={() => (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )}
        renderQuoteActions={() =>
          showChoice &&
          (refundError === "failed" || (refundError && TERMINAL_REFUND_ERRORS.has(refundError))) ? (
            saved && (refundError === "failed" || CREDIT_INSTEAD.has(refundError)) ? (
              <>
                <Button
                  variant="secondary"
                  disabled={refunding}
                  loading={crediting}
                  onClick={() => saved && doStoreCredit(saved)}
                >
                  Give store credit instead
                </Button>
                {refundError === "failed" ? (
                  <Button
                    loading={refunding}
                    disabled={crediting}
                    onClick={() => saved && doRetry(saved)}
                  >
                    Retry refund
                  </Button>
                ) : (
                  <Button onClick={handleClose}>Close</Button>
                )}
              </>
            ) : (
              <Button onClick={handleClose}>Close</Button>
            )
          ) : (
            <Button
              disabled={
                refunding ||
                requoting ||
                requoteMutation.isPending ||
                !sectionState.captureReason ||
                // B961: staff must give a reason for every "already returned or credited" product (the server refuses otherwise)
                (!!sectionState.quote &&
                  canOverrideReturnCredit(role) &&
                  missingAlreadyReturnedReasons(sectionState.lines, sectionState.quote).length > 0)
              }
              loading={captureMutation.isPending}
              onClick={handleConfirm}
            >
              {!showChoice
                ? "Issue credit note and receive goods"
                : refunding
                  ? "Refunding…"
                  : effResolution === "REFUND"
                    ? `Return & refund ${money(shownAmount)}`
                    : "Return & issue store credit"}
            </Button>
          )
        }
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
            {!refundDone && refundAmountOf(result.refundAmount) !== null && (
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
          {refundDone && (
            <p role="status" className="text-sm text-navy">
              Refund recorded. {handBackLine(refundDone.tender, money(refundDone.amount))}
            </p>
          )}
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

function RefundChoice({
  amount,
  walkIn,
  refundUnavailable = false,
  resolution,
  onResolution,
  tender,
  onTender,
  locked,
  error,
}: {
  amount: string;
  walkIn: boolean;
  refundUnavailable?: boolean;
  resolution: InlineReturnResolution;
  onResolution: (r: InlineReturnResolution) => void;
  tender: InlineRefundTender;
  onTender: (t: InlineRefundTender) => void;
  locked: boolean;
  error: RefundErrorKind | null;
}) {
  const refund = resolution === "REFUND";
  return (
    <fieldset className="mt-4 space-y-2 rounded-lg border border-surface-border p-3">
      <legend className="px-1 text-sm font-medium text-navy">{REFUND_COPY.heading}</legend>
      {!walkIn && (
        <label className="flex items-center gap-2 text-sm text-navy">
          <input
            type="radio"
            name="return-resolution"
            checked={!refund}
            disabled={locked}
            onChange={() => onResolution("STORE_CREDIT")}
          />
          Store credit
        </label>
      )}
      <label className="flex items-center gap-2 text-sm text-navy">
        <input
          type="radio"
          name="return-resolution"
          checked={refund}
          disabled={locked || refundUnavailable}
          onChange={() => onResolution("REFUND")}
        />
        Refund {amount}
      </label>
      {walkIn && <p className="text-xs text-navy/70">{REFUND_COPY.walkIn}</p>}
      {refundUnavailable && <p className="text-xs text-navy/70">{REFUND_COPY.paidWithCredit}</p>}
      {refund && (
        <>
          <Select
            label="Refund by"
            value={tender}
            disabled={locked}
            onChange={(e) => onTender(e.target.value as InlineRefundTender)}
            options={TENDER_OPTIONS}
          />
          <p className="text-sm text-navy">{handBackLine(tender, amount)}</p>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {REFUND_COPY[error]}
        </p>
      )}
    </fieldset>
  );
}
