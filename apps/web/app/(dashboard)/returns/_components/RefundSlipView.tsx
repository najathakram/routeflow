import * as React from "react";
import { formatReceiptMoney as money } from "@/lib/counter-receipt";
import type { RefundSlipModel } from "@/lib/refund-slip";

/**
 * The printable refund slip: an 80 mm paper layout (72 mm printable) with the same header as the sale receipt. Plain text
 * only, including the footer, which is the business's own words and is never rendered as HTML.
 */
export function RefundSlipView({
  model: m,
  logoUrl,
}: {
  model: RefundSlipModel;
  logoUrl?: string | null;
}) {
  const hasHeader = !!(logoUrl || m.header.name || m.header.addressLines.length || m.header.phone);
  return (
    <div className="space-y-3 text-sm text-black" data-testid="refund-slip">
      {/* mounted only while the slip prints, so the page size applies to this print and no other */}
      <style>{`@media print { @page { size: 80mm auto; margin: 4mm; } }`}</style>
      {hasHeader ? (
        <div className="text-center" data-testid="refund-slip-header">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a tenant-hosted logo of unknown size
            <img src={logoUrl} alt="" className="mx-auto mb-1 max-h-12" />
          ) : null}
          {m.header.name ? <p className="text-lg font-semibold">{m.header.name}</p> : null}
          {m.header.addressLines.map((a) => (
            <p key={a}>{a}</p>
          ))}
          {m.header.phone ? <p>{m.header.phone}</p> : null}
        </div>
      ) : null}
      <h1 className="text-base font-semibold">Refund slip</h1>
      <div>
        <p data-testid="refund-slip-number">Return {m.returnNumber}</p>
        {m.sourceSale ? <p data-testid="refund-slip-source">From {m.sourceSale}</p> : null}
        <p data-testid="refund-slip-date">{m.dateLabel}</p>
        {m.printedBy ? <p data-testid="refund-slip-printed-by">Printed by: {m.printedBy}</p> : null}
      </div>
      <ul className="divide-y">
        {m.lines.map((l) => (
          <li key={l.key} className="flex justify-between gap-2 py-1">
            <span>{l.name}</span>
            <span className="tabular-nums">{l.detail}</span>
          </li>
        ))}
      </ul>
      <dl className="space-y-1">
        <div
          className="flex justify-between text-base font-semibold"
          data-testid="refund-slip-total"
        >
          <dt>Total refunded</dt>
          <dd className="tabular-nums">{money(m.total)}</dd>
        </div>
        {m.payout.kind !== "NONE" ? (
          <div className="flex justify-between" data-testid="refund-slip-payout">
            <dt>{m.payout.label}</dt>
            <dd className="tabular-nums">{money(m.payout.amount)}</dd>
          </div>
        ) : null}
      </dl>
      {m.footer ? (
        <p className="whitespace-pre-line text-center" data-testid="refund-slip-footer">
          {m.footer}
        </p>
      ) : null}
    </div>
  );
}
