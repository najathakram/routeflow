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

/**
 * Row 372 (SA-735 item 2, web half). The edit screen sends the `revisionNumber` it LOADED when edit mode opened
 * (a background refetch while typing must not move it), and a 409 ORDER_REVISION_STALE shows FIXED copy with a
 * Reload that refetches the order and re-bases the revision. The editor's typed edits live in the page's own
 * state and are left alone: Reload only brings the server's latest into view, and the next save is judged
 * against it. Extracted so orders/[id]/page.tsx (pinned by size-ratchet.spec.ts) adds a hook call and a render.
 */
export function useOrderStaleRevision(
  order: { id: string; revisionNumber?: number } | undefined,
  editing: boolean,
) {
  const qc = useQueryClient();
  const loaded = React.useRef<number | undefined>(undefined);
  const [stale, setStale] = React.useState(false);

  // The revision at the moment edit mode opened; cleared when it closes. (Deliberately NOT re-read on refetch.)
  const revisionNow = order?.revisionNumber;
  React.useEffect(() => {
    if (editing) {
      if (loaded.current === undefined) loaded.current = revisionNow;
    } else {
      loaded.current = undefined;
      setStale(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // The first render of edit mode runs before the effect: read the live value until it is captured.
  const expected = (): number | undefined =>
    editing ? (loaded.current ?? revisionNow) : undefined;

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
    const fresh = qc.getQueryData<{ revisionNumber?: number }>(["orders", order.id]);
    loaded.current = fresh?.revisionNumber;
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

  return { expected, capture, ownsToast, node };
}
