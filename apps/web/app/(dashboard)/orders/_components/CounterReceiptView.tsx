"use client";

import * as React from "react";
import Link from "next/link";
import { formatReceiptMoney as money, type CounterReceiptModel } from "@/lib/counter-receipt";

/**
 * The ONE printable receipt view: the live receipt and the Today's-sales reprint both render through it, so a reprint can
 * never drift from the receipt the customer first saw. `reprintLabel` ("Reprint · sold …") marks a reprint.
 */
export function CounterReceiptView({
  model: m,
  logoUrl,
  reprintLabel,
}: {
  model: CounterReceiptModel;
  logoUrl?: string | null;
  reprintLabel?: string;
}) {
  const hasHeader = logoUrl || m.header.name || m.header.addressLines.length > 0 || m.header.phone;
  return (
    <div
      className="space-y-4 print:w-full print:max-w-none print:space-y-2 print:p-0 print:text-black"
      data-testid="receipt-print-root"
    >
      {/* mounted only while the receipt is on screen, so the page size applies to this print and no other: 80 mm paper, 72 mm printable */}
      <style>{`@media print { @page { size: 80mm auto; margin: 4mm; } }`}</style>
      {hasHeader ? (
        <div className="text-center text-sm" data-testid="receipt-header">
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
      <h1 className="text-xl font-semibold print:text-base">Receipt</h1>
      <div className="text-sm text-navy/70 print:text-black">
        <p data-testid="receipt-numbers">
          Order {m.orderNumber} · Invoice {m.invoiceNumber}
        </p>
        {reprintLabel ? (
          <p data-testid="receipt-reprint">{reprintLabel}</p>
        ) : (
          <p data-testid="receipt-date">{m.dateLabel}</p>
        )}
        {m.cashier ? <p data-testid="receipt-cashier">Cashier: {m.cashier}</p> : null}
      </div>
      <ul className="divide-y text-sm">
        {m.lines.map((l) => (
          <li
            key={l.key}
            className="flex justify-between gap-2 py-1"
            data-testid={`receipt-line-${l.key}`}
          >
            <span>
              {l.name}
              <span className="block text-xs text-navy/60 print:text-black">{l.detail}</span>
            </span>
            <span className="tabular-nums">{money(l.total)}</span>
          </li>
        ))}
      </ul>
      {m.onAccount ? (
        <div
          role="status"
          className="space-y-1 rounded border border-navy/20 bg-navy/5 p-3 text-sm"
          data-testid="counter-on-account"
        >
          <p className="font-semibold">On account</p>
          <p>{money(m.balanceDue)} balance due on account</p>
        </div>
      ) : null}
      {m.paymentNotRecorded ? (
        <div
          role="status"
          className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
          data-testid="counter-payment-not-recorded"
        >
          <p className="font-semibold">Sale recorded — payment not recorded</p>
          <Link
            href={`/invoices/${m.invoiceId}`}
            className="inline-block text-brand-700 underline print:hidden"
          >
            Record payment
          </Link>
        </div>
      ) : null}
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between" data-testid="receipt-subtotal">
          <dt>Subtotal</dt>
          <dd>{money(m.subtotal)}</dd>
        </div>
        {m.adjustment !== 0 ? (
          <div className="flex justify-between" data-testid="receipt-adjustment">
            <dt>Tax and adjustments</dt>
            <dd>{money(m.adjustment)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between text-lg font-semibold" data-testid="receipt-total">
          <dt>Total</dt>
          <dd>{money(m.total)}</dd>
        </div>
        {m.methodLabel ? (
          <div className="flex justify-between" data-testid="receipt-method">
            <dt>Payment method</dt>
            <dd>{m.methodLabel}</dd>
          </div>
        ) : null}
        {m.showPaid ? (
          <div className="flex justify-between">
            <dt>Paid</dt>
            <dd>{money(m.paid)}</dd>
          </div>
        ) : null}
        {m.showBalance ? (
          <div className="flex justify-between">
            <dt>Balance due</dt>
            <dd>{money(m.balanceDue)}</dd>
          </div>
        ) : null}
        {m.tendered != null ? (
          <div className="flex justify-between" data-testid="receipt-tendered">
            <dt>Tendered</dt>
            <dd>
              {money(m.tendered)}
              {m.tenderedAsEntered ? (
                <span className="ml-1 text-xs text-navy/60 print:text-black">as entered</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {m.change != null ? (
          <div className="flex justify-between text-lg font-semibold" data-testid="receipt-change">
            <dt>Change</dt>
            <dd>
              {money(m.change)}
              {m.changeAsEntered ? (
                <span className="ml-1 text-xs font-normal text-navy/60 print:text-black">
                  as entered
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
