"use client";

import { cn } from "@routeflow/ui/web";
import type { InvoicePdfVariant } from "@/lib/api/invoices";

const LABEL: Record<InvoicePdfVariant, string> = { draft: "Draft", final: "Final" };

/**
 * B1372 (SA-1177 K4.1, owner box Q3 "Invoice page switch"): the Draft/Final switch only picks which version is printed,
 * downloaded or emailed. It is a preview, so it says so ("Preview as: Draft · Final"), starts on the server's stage
 * (`stage`), and when the preview differs it states the invoice's own stage beside it, so a preview is never read as the
 * invoice becoming final (or draft). Picking the server's stage again clears the note.
 */
export function InvoicePreviewToggle({
  stage,
  preview,
  onPreview,
}: {
  stage: InvoicePdfVariant;
  preview: InvoicePdfVariant;
  onPreview: (v: InvoicePdfVariant) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <span id="invoice-preview-as" className="text-xs text-navy/70">
        Preview as:
      </span>
      <div
        className="inline-flex items-center rounded-lg border border-surface-border p-0.5"
        role="group"
        aria-labelledby="invoice-preview-as"
      >
        {(["draft", "final"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={preview === v}
            onClick={() => onPreview(v)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              preview === v ? "bg-brand-500 text-white" : "text-navy/70 hover:bg-surface-raised",
            )}
          >
            {LABEL[v]}
          </button>
        ))}
      </div>
      {preview !== stage && (
        <span className="text-xs text-navy/70" data-testid="invoice-preview-note">
          Preview only. This invoice is {stage === "final" ? "final" : "a draft"}.
        </span>
      )}
    </div>
  );
}
