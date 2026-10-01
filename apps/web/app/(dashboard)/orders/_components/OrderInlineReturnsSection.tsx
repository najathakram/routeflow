"use client";

// ─── Collapsible "Returns" section — order create + order edit hosts (#2406) ───────────────
//
// A thin wrapper around the shared `InlineReturnSection` (apps/web/app/(dashboard)/returns/
// _components/InlineReturnSection.tsx): gates on the same addon the standalone dialog uses,
// and exposes the operator's current draft via an imperative handle so the host (CreateOrderModal
// / the order-edit page) can read it at SAVE time and fold it into its own order create/update
// payload as `inlineReturn` — this component never calls the quote or capture endpoints itself
// beyond what InlineReturnSection already does for the QUOTE (an estimate only; the actual
// return is captured server-side as part of the order write).
import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useHasAddon } from "@/lib/api/tobacco";
import { ORDERS_INLINE_RETURNS_ADDON } from "@/lib/api/addons";
import { hasAnyQtyEntered, type InlineReturnLineDraft } from "@routeflow/returns";
import type { ReturnReason } from "@routeflow/types";
import {
  InlineReturnSection,
  type InlineReturnSectionState,
} from "../../returns/_components/InlineReturnSection";

export interface OrderInlineReturnsDraft {
  lines: InlineReturnLineDraft[];
  captureReason: ReturnReason | "";
  /** SA-484i: a return rides the save only once it has been QUOTED. */
  quoted: boolean;
}

export interface OrderInlineReturnsSectionHandle {
  /** The operator's current draft, or null when no line has any qty entered yet — the host's
   *  save handler treats null as "no return on this save". */
  getDraft(): OrderInlineReturnsDraft | null;
  /** Clears the draft and collapses the section — called after a successful save. */
  reset(): void;
  /** Bumps on every discard/reset, so the save hook drops its returnKey/Idempotency-Key pair
   *  (SA-484i: a discarded draft's keys never carry into a new one). */
  generation(): number;
}

export interface OrderInlineReturnsSectionProps {
  customerId: string;
  /** Pre-fills lines from this order's own line items — the edit-mode host passes the order
   *  being edited; CreateOrderModal omits it (the order doesn't exist yet). */
  entryOrderId?: string;
  /** Shown under the section — the host's own save-refusal message (item 4 of SA-484: kept
   *  visible with the form/edit mode still open, never the quote-only inline error
   *  InlineReturnSection already renders for its own quote calls). */
  refusalMessage?: string;
  /** #2647: the return already recorded under this capture key (a key-reused 409): shown as a
   *  link, so the operator checks what was credited before returning anything else. */
  refusalReturn?: { returnId: string; returnNumber: string | null } | null;
}

export const OrderInlineReturnsSection = React.forwardRef<
  OrderInlineReturnsSectionHandle,
  OrderInlineReturnsSectionProps
>(function OrderInlineReturnsSection(
  { customerId, entryOrderId, refusalMessage, refusalReturn },
  ref,
) {
  const hasInlineReturns = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);
  const [expanded, setExpanded] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [resetToken, setResetToken] = React.useState(0);
  const stateRef = React.useRef<InlineReturnSectionState | null>(null);
  // #2406 (lead fold): SAVE captures only what the operator can SEE — a collapsed section never
  // contributes a draft, and collapsing one with lines entered asks to discard them first.
  const expandedRef = React.useRef(false);
  const genRef = React.useRef(0);
  expandedRef.current = expanded;
  const hasLines = () => !!stateRef.current && hasAnyQtyEntered(stateRef.current.lines);
  const discard = () => {
    genRef.current += 1;
    stateRef.current = null;
    setConfirmDiscard(false);
    setExpanded(false);
    setResetToken((n) => n + 1);
  };

  React.useImperativeHandle(
    ref,
    () => ({
      getDraft: () => {
        const state = stateRef.current;
        if (!expandedRef.current || !state || !hasAnyQtyEntered(state.lines)) return null;
        return { lines: state.lines, captureReason: state.captureReason, quoted: !!state.quote };
      },
      reset: discard,
      generation: () => genRef.current,
    }),
    [],
  );

  if (!hasInlineReturns) return null;

  return (
    <section className="space-y-2 rounded-lg border border-surface-border p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-sm font-semibold text-navy"
        onClick={() => {
          if (!expanded) return setExpanded(true);
          if (hasLines()) return setConfirmDiscard(true);
          setExpanded(false);
        }}
        aria-expanded={expanded}
      >
        <span>Returns</span>
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {confirmDiscard && (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
        >
          <p className="text-navy">
            Discard this return? Its lines won&apos;t be saved with the order.
          </p>
          <div className="flex gap-2">
            <button type="button" className="font-semibold text-danger" onClick={discard}>
              Discard return
            </button>
            <button
              type="button"
              className="font-semibold text-navy"
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}
      {expanded && (
        <InlineReturnSection
          customerId={customerId}
          entryOrderId={entryOrderId}
          resetToken={resetToken}
          onStateChange={(state) => {
            stateRef.current = state;
          }}
        />
      )}
      {refusalMessage && (
        <p data-testid="order-return-refusal" className="text-sm text-danger">
          {refusalMessage}
        </p>
      )}
      {refusalReturn && (
        <Link
          data-testid="order-return-recorded-link"
          href={`/returns/${refusalReturn.returnId}`}
          className="text-sm font-medium text-plum underline"
        >
          Open {refusalReturn.returnNumber ?? "the recorded return"}
        </Link>
      )}
    </section>
  );
});
