"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import type { OrderRevision } from "@/lib/api/orders";
import { formatMoney } from "@/lib/format";
import { ORDER_REVISIONS_HASH } from "@/lib/invoice-revision";

/**
 * P5-08 / row 330d: the order's append-only edit history. The "Edited N×" chip is a button that opens the list
 * inline (it was a `title` tooltip, which a touch screen never shows). Newest first; `vN · who · when · total`.
 */
export function OrderRevisionLog({ revisions }: { revisions: OrderRevision[] }) {
  const [open, setOpen] = React.useState(false);
  const logId = React.useId();
  const rootRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (window.location.hash !== ORDER_REVISIONS_HASH) return;
    setOpen(true);
    rootRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  if (revisions.length === 0) return null;
  const newestFirst = [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  return (
    <span ref={rootRef} id="order-revisions" className="contents">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? logId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-navy/5 px-2 py-1 text-xs font-medium text-navy/80 hover:bg-navy/10 max-sm:min-h-11 max-sm:px-3"
      >
        Edited {revisions.length}×
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <ol
          id={logId}
          data-testid="order-revision-log"
          className="w-full basis-full space-y-1 rounded-lg border border-surface-border bg-white p-3 text-xs text-navy"
        >
          {newestFirst.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-2">
              <span className="font-semibold">v{r.revisionNumber}</span>
              <span>{r.editedByName ?? r.editedByRole ?? "system"}</span>
              <span className="text-navy/70">{new Date(r.createdAt).toLocaleString()}</span>
              <span className="tabular-nums">{formatMoney(r.snapshot.total)}</span>
              {r.reason && <span className="w-full text-navy/70">{r.reason}</span>}
            </li>
          ))}
        </ol>
      )}
    </span>
  );
}
