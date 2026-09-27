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
}

export interface OrderInlineReturnsSectionHandle {
  /** The operator's current draft, or null when no line has any qty entered yet — the host's
   *  save handler treats null as "no return on this save". */
  getDraft(): OrderInlineReturnsDraft | null;
  /** Clears the draft and collapses the section — called after a successful save. */
  reset(): void;
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
}

export const OrderInlineReturnsSection = React.forwardRef<
  OrderInlineReturnsSectionHandle,
  OrderInlineReturnsSectionProps
>(function OrderInlineReturnsSection({ customerId, entryOrderId, refusalMessage }, ref) {
  const hasInlineReturns = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);
  const [expanded, setExpanded] = React.useState(false);
  const [resetToken, setResetToken] = React.useState(0);
  const stateRef = React.useRef<InlineReturnSectionState | null>(null);

  React.useImperativeHandle(
    ref,
    () => ({
      getDraft: () => {
        const state = stateRef.current;
        if (!state || !hasAnyQtyEntered(state.lines)) return null;
        return { lines: state.lines, captureReason: state.captureReason };
      },
      reset: () => {
        stateRef.current = null;
        setExpanded(false);
        setResetToken((n) => n + 1);
      },
    }),
    [],
  );

  if (!hasInlineReturns) return null;

  return (
    <section className="space-y-2 rounded-lg border border-surface-border p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-sm font-semibold text-navy"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span>Returns</span>
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
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
    </section>
  );
});
