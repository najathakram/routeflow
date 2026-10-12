"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@routeflow/ui/web";
import { API_ERROR_CODES } from "@routeflow/types";

/** Fixed copy: what happened and the next step. The server's own sentence is never shown. */
export const ORDER_STALE_COPY = "This order changed since you opened it. Reload to see the latest.";

const isStale = (err: unknown): boolean => {
  const res = (err as { response?: { status?: number; data?: Record<string, unknown> } } | null)
    ?.response;
  return res?.status === 409 && res.data?.code === API_ERROR_CODES.ORDER_REVISION_STALE;
};

/** What an editor is based on: the revision, the lines and the shipping fee it saw. */
export interface Snapshot<L> {
  rev?: number;
  lines?: L[];
  fee?: number;
  /** The credit notes applied to the order (the editor's `appliedCreditNotes` are judged against these). */
  credits?: Array<{ creditNoteId: string; amount?: number }>;
}
type OrderLike<L> = {
  revisionNumber?: number;
  shippingFee?: number | string | null;
  lineItems?: L[];
  orderCreditNotes?: Array<{ creditNoteId: string; amount?: number | string | null }>;
};
const snapshotOf = <L,>(o: OrderLike<L> | null | undefined): Snapshot<L> => ({
  rev: o?.revisionNumber,
  lines: o?.lineItems,
  fee: o ? Number(o.shippingFee ?? 0) : undefined,
  credits: o?.orderCreditNotes?.map((c) => ({
    creditNoteId: c.creditNoteId,
    amount: c.amount != null ? Number(c.amount) : undefined,
  })),
});

/**
 * Row 372 (SA-735 item 2, web half). The edit screen sends the `revisionNumber` it LOADED when edit mode opened
 * (a background refetch while typing must not move it), and a 409 ORDER_REVISION_STALE shows FIXED copy with a
 * Reload that refetches the order and re-bases the revision. The editor's typed edits live in the page's own
 * state: Reload re-bases them onto the server's latest (order-edit-rebase.ts: untouched lines refresh, touched
 * lines keep the edit) and the next save is judged against it. Extracted so orders/[id]/page.tsx (pinned by size-ratchet.spec.ts) adds a hook call and a render.
 */
export function useOrderStaleRevision<L extends { id: string } = { id: string }>(
  order: (OrderLike<L> & { id: string }) | undefined,
  editing: boolean,
  /** After Reload: the FRESH snapshot and the one the editor was last based on (MF3: rebase the edit onto it). */
  onRebase?: (fresh: Snapshot<L>, base: Snapshot<L>) => void,
) {
  const qc = useQueryClient();
  const [stale, setStale] = React.useState(false);

  // What the editor LOADED when edit mode opened: keyed on `editing` alone, so a background refetch while typing
  // never moves it. There is deliberately NO fallback to the live revision (an order that sent none at open
  // sends nothing, instead of silently judging the edit against whatever the server holds now).
  const opened = React.useMemo(
    () => (editing ? snapshotOf(order) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing],
  );
  // Set by Reload: the snapshot the editor is now based on.
  const rebased = React.useRef<Snapshot<L> | null>(null);
  React.useEffect(() => {
    if (!editing) {
      rebased.current = null;
      setStale(false);
    }
  }, [editing]);
  const base = editing ? (rebased.current ?? opened) : undefined;

  const expected = (): number | undefined => base?.rev;
  /** The lines this edit is judged against (edit-open, or the last Reload): never the live refetch. */
  const baseLines = (): L[] | undefined => base?.lines;
  /** The shipping fee the editor loaded: `feeChanged` is judged against it, never the live refetch. */
  const baseFee = (): number | undefined => base?.fee;
  /** Did the user change the shipping fee? Judged against the fee they loaded, never a live refetch. */
  const feeChanged = (current: number, live: number | string | null | undefined): boolean =>
    Math.abs(current - (base?.fee ?? Number(live ?? 0))) > 0.0001;

  const capture = (err: unknown): boolean => {
    if (!editing || !isStale(err)) return false;
    setStale(true);
    return true;
  };
  /** `meta.localErrorToast` predicate: skip the global toast when the notice shows. */
  const ownsToast = (err: unknown): boolean => editing && isStale(err);

  const reload = async () => {
    if (!order) return;
    await qc.invalidateQueries({ queryKey: ["orders", order.id] });
    const fresh = snapshotOf(qc.getQueryData<OrderLike<L>>(["orders", order.id]));
    if (fresh.lines) onRebase?.(fresh, base ?? snapshotOf(undefined));
    rebased.current = fresh;
    setStale(false);
  };

  const node = stale ? (
    <div
      role="alert"
      data-testid="order-stale-notice"
      className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-navy"
    >
      <p>{ORDER_STALE_COPY}</p>
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => void reload()}>
          Reload
        </Button>
      </div>
    </div>
  ) : null;

  return { expected, baseLines, baseFee, feeChanged, capture, ownsToast, node };
}
