import * as React from "react";
import { INVOICE_ACCOUNT_LABELS } from "@routeflow/types";

// A fixed sample of the invoice PDF, so a flip of the layout switches shows at once. The totals mirror the PDF's order and
// words (guarded by apps/api/src/invoices/invoice-pdf-template.labels.spec.ts).

export interface InvoiceLayoutFlags {
  hideOriginalPrice?: boolean;
  hideBarcodes?: boolean;
  hidePerPiece?: boolean;
  hideAmountPaid?: boolean;
  hideBalanceDue?: boolean;
  showAccountBalance?: boolean;
}

const BARS = [2, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 3, 1, 2, 1, 3, 2, 1];
const SAMPLE_CODE = "0123456789";
const TOTALS = [
  ["Total", "$40.00"],
  ["Amount Paid", "$15.00"],
  ["Balance Due", "$25.00"],
] as const;
// SA-1197: a fixed sample of the account block (the real one is the server's figures, never added on a screen).
const SAMPLE_OTHERS = "$30.00";
const SAMPLE_OPEN = "$55.00";
const sampleDay = () =>
  new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function InvoiceLayoutPreview({ layout }: { layout: InvoiceLayoutFlags }) {
  const showOriginal = !layout.hideOriginalPrice;
  const showBarcode = !layout.hideBarcodes;
  const showPerPiece = !layout.hidePerPiece;
  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-navy">Preview</h4>
      <div
        role="group"
        aria-label="Invoice preview"
        className="space-y-3 rounded-card border border-surface-border bg-white p-4 text-sm text-navy shadow-card"
      >
        <div className="flex items-start justify-between gap-3 border-b border-surface-border pb-2">
          <div>
            <p className="font-medium">Sample item, 2 boxes</p>
            {showBarcode ? (
              <div className="mt-1">
                <div aria-hidden="true" className="flex h-6 items-stretch gap-px">
                  {BARS.map((w, i) => (
                    <span
                      key={i}
                      className="bg-navy"
                      style={{ width: `${w}px`, opacity: i % 2 === 0 ? 1 : 0 }}
                    />
                  ))}
                </div>
                <p className="money text-xs text-navy/70">{SAMPLE_CODE}</p>
              </div>
            ) : null}
          </div>
          <div className="text-right">
            {showOriginal ? (
              <p
                data-testid="preview-original-price"
                className="money text-xs text-navy/70 line-through"
              >
                $24.00
              </p>
            ) : null}
            <p className="font-medium">
              <span className="money">$20.00</span>{" "}
              <span className="text-xs font-normal text-navy/70">/ box</span>
            </p>
            {showPerPiece ? (
              <p className="text-xs text-navy/70">
                <span>Per piece</span> <span className="money">$1.67</span>
              </p>
            ) : null}
          </div>
        </div>
        <dl data-testid="preview-totals" className="space-y-1">
          {TOTALS.filter(
            ([label]) =>
              !(label === "Amount Paid" && layout.hideAmountPaid) &&
              !(label === "Balance Due" && layout.hideBalanceDue),
          ).map(([label, amount]) => (
            <div key={label} className="flex justify-between">
              <dt data-testid="preview-total-label">{label}</dt>
              <dd className="money">{amount}</dd>
            </div>
          ))}
        </dl>
        {layout.showAccountBalance ? (
          <div data-testid="preview-account" className="space-y-0.5 text-xs text-navy/70">
            {layout.hideBalanceDue ? null : (
              <p className="font-semibold">
                {INVOICE_ACCOUNT_LABELS.heading.replace("{date}", sampleDay())}
              </p>
            )}
            <dl className="space-y-0.5">
              {(layout.hideBalanceDue
                ? [
                    [
                      INVOICE_ACCOUNT_LABELS.openBalanceOn.replace("{date}", sampleDay()),
                      SAMPLE_OPEN,
                    ],
                  ]
                : [
                    [INVOICE_ACCOUNT_LABELS.others, SAMPLE_OTHERS],
                    [INVOICE_ACCOUNT_LABELS.thisInvoice, "$25.00"],
                    [INVOICE_ACCOUNT_LABELS.openBalance, SAMPLE_OPEN],
                  ]
              ).map(([label, amount]) => (
                <div key={label} className="flex justify-between">
                  <dt>{label}</dt>
                  <dd className="money">{amount}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-navy/70">
        Sample. Your invoices use your own items and amounts.
      </p>
    </div>
  );
}
