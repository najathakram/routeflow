"use client";

import * as React from "react";
import { AdminCard } from "../../../../_components/AdminCard";
import {
  listBillingEvents,
  onBillingEventsChanged,
  utcDay,
  type BillingEventRow,
} from "@/lib/api/platform-billing-events";
import { formatMoney } from "@/lib/format";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The row text. A staff refund prints the ruled W8 line; every other type prints `label ?? type`. */
export function billingEventText(e: BillingEventRow): string {
  if (e.type !== "refund.staff") return e.label ?? e.type;
  const p = e.payload ?? {};
  const amount = str(p.amount);
  const currency = str(p.currency) ?? "usd";
  const shown = amount
    ? currency.toLowerCase() === "usd"
      ? formatMoney(amount)
      : `${amount} ${currency.toUpperCase()}`
    : "—";
  return [
    str(p.refundDate) ?? utcDay(e.createdAt),
    e.label ?? e.type,
    `Yearly payment ${shown} refunded in full`,
    `Ref ${str(p.providerRef) ?? "—"}`,
    `by ${e.actorName ?? "unknown"}`,
    `recorded ${utcDay(e.createdAt)}`,
  ].join(" · ");
}

/** The tab's "Billing events" list (R-2): newest first as the server sends it, refreshed when a refund is recorded. */
export function BillingEventsList({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = React.useState<BillingEventRow[] | null>(null);

  const load = React.useCallback(() => {
    listBillingEvents(tenantId)
      .then(setRows)
      .catch(() => setRows((prev) => prev ?? []));
  }, [tenantId]);

  React.useEffect(() => {
    load();
    return onBillingEventsChanged(tenantId, load);
  }, [tenantId, load]);

  return (
    <AdminCard title="Billing events" className="min-w-0 lg:col-span-2">
      {rows === null ? null : rows.length === 0 ? (
        <p className="text-sm text-slate-400">No billing events yet.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm text-slate-300">
          {rows.map((e) => (
            <li key={e.id} className="break-words">
              {billingEventText(e)}
            </li>
          ))}
        </ul>
      )}
    </AdminCard>
  );
}
