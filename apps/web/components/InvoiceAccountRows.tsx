import type { ReactNode } from "react";
import type { InvoiceAccountRow } from "@routeflow/types";
import { fmt } from "@/lib/formatting";

/**
 * SA-1197 / SA-1228 D5: the server's account rows, printed as given (never summed, never relabelled, L-119).
 * One renderer for the staff invoice page and the buyer portal page; `figure` lets the staff page wrap a
 * figure (the statement tap). The buyer page passes none, so a buyer gets no staff statement tap.
 */
export function InvoiceAccountRows({
  rows,
  figure,
  className = "mt-2",
}: {
  rows: ReadonlyArray<InvoiceAccountRow>;
  figure?: (row: InvoiceAccountRow, node: ReactNode) => ReactNode;
  className?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div
      data-testid="invoice-account-block"
      className={`${className} space-y-0.5 text-xs text-navy/70`}
    >
      {rows.map((row) => {
        if (row.amount == null)
          return (
            <p key={row.kind} className="pt-1 font-semibold">
              {row.label}
            </p>
          );
        const node = <span className="money">{fmt(row.amount)}</span>;
        return (
          <div key={row.kind} className="flex items-center justify-between">
            <span>{row.label}</span>
            {figure ? figure(row, node) : node}
          </div>
        );
      })}
    </div>
  );
}
