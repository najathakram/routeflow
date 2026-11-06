"use client";

import * as React from "react";
import { buildQuoteRequest } from "@routeflow/returns";
import { useInlineReturnQuote } from "@/lib/api/inline-returns";
import type { OrderInlineReturnsSectionHandle } from "./OrderInlineReturnsSection";
import { mergeReturnChange } from "./merge-return-change";

/**
 * SA-1060 A-5: the one extra quote the merge prompt asks, and the one line it earns.
 *
 * When the prompt opens on a QUOTED return, this sends the Returns box's own request plus `editingOrderId: <the merge
 * target>`, so the server prices the return as the merge will capture it (after the revert the merge runs on the
 * target's sent invoice), then compares it with the box's quote. No return, or a draft whose quote is not current, makes
 * no call. The answer only ever sets a line of words: it never touches the box, the buttons or the save, and a failed or
 * refused quote leaves the line empty. An answer that lands after the prompt closed, or after it reopened (a newer ask),
 * is dropped.
 */
export function useMergeReturnChange(
  targetId: string | null,
  returnsRef: React.RefObject<OrderInlineReturnsSectionHandle | null>,
  customerId: string | undefined,
): string | null {
  const quote = useInlineReturnQuote();
  const mutateRef = React.useRef(quote.mutate);
  mutateRef.current = quote.mutate;
  const [line, setLine] = React.useState<string | null>(null);

  React.useEffect(() => {
    setLine(null);
    if (!targetId || !customerId) return;
    const draft = returnsRef.current?.getDraft();
    if (!draft || !draft.quoted || !draft.quote) return;
    const box = draft.quote;
    let live = true;
    mutateRef.current(buildQuoteRequest(customerId, draft.lines, undefined, undefined, targetId), {
      onSuccess: (merged) => {
        if (live) setLine(mergeReturnChange(box, merged));
      },
      onError: () => undefined, // says nothing: both buttons work as they did
    });
    return () => {
      live = false; // closed, reopened or retargeted: this ask is stale
    };
  }, [targetId, customerId, returnsRef]);

  return line;
}
