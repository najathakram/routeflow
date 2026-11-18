import * as React from "react";
import { Card, useToast } from "@routeflow/ui/web";
import type { InvoiceSettings } from "@/lib/api/invoices";
import { isReadOnlyRefusal } from "@/lib/read-only-refusal";
import { InvoiceLayoutPreview } from "./InvoiceLayoutPreview";

type LayoutKey =
  "hideOriginalPrice" | "hideBarcodes" | "hidePerPiece" | "hideAmountPaid" | "hideBalanceDue";
type LayoutSettings = Pick<InvoiceSettings, LayoutKey>;

interface MutateOptions {
  onSuccess: () => void;
  onError: (err: unknown) => void;
}

interface Props {
  /** The stored values (undefined fields read as shown). */
  settings: LayoutSettings | undefined;
  /** The PATCH body in flight, so the preview shows a flip before the save returns. */
  pending: Partial<InvoiceSettings> | undefined;
  onToggle: (body: Partial<InvoiceSettings>, options: MutateOptions) => void;
  disabled: boolean;
}

const ROWS: {
  key: LayoutKey;
  label: string;
  help: string;
  doneDescription: string;
}[] = [
  {
    key: "hideOriginalPrice",
    label: "Show original price on discounted lines",
    help: "When off, invoices show only the final unit price — no struck-through original price or badge.",
    doneDescription: "Original price display updated successfully.",
  },
  {
    key: "hideBarcodes",
    label: "Show barcodes on invoices",
    help: "Prints each product's barcode and code on its line. Turn off to print invoices without them.",
    doneDescription: "Barcode display updated.",
  },
  {
    key: "hidePerPiece",
    label: "Show price per piece on invoices",
    help: "Adds a Per piece column beside pack lines, on the invoice page, the PDF and the email. Turn off to print invoices without it.",
    doneDescription: "Per piece column updated.",
  },
  {
    key: "hideAmountPaid",
    label: "Show amount paid",
    help: "Prints the Amount Paid line and the list of payments. Turn off to print invoices without them.",
    doneDescription: "Amount paid display updated.",
  },
  {
    key: "hideBalanceDue",
    label: "Show balance due",
    help: "Prints the Balance Due line. Turn off to print invoices without it.",
    doneDescription: "Balance due display updated.",
  },
];

export function InvoiceLayoutCard({ settings, pending, onToggle, disabled }: Props) {
  const { toast } = useToast();

  const handleChange = (key: LayoutKey, doneDescription: string, checked: boolean) => {
    onToggle(
      { [key]: !checked },
      {
        onSuccess: () =>
          toast({
            title: "Invoice settings saved",
            description: doneDescription,
            variant: "success",
          }),
        onError: (err) =>
          isReadOnlyRefusal(err) ||
          toast({
            title: "Failed to save",
            description: "Could not update invoice settings.",
            variant: "error",
          }),
      },
    );
  };

  const shown = { ...settings, ...pending };

  return (
    <Card title="Invoice layout">
      <div className="space-y-4">
        <p className="text-sm text-navy/70">
          Choose what prints on your invoices. Applies to the invoice PDF, the counter&apos;s Print
          invoice and the invoice email.
        </p>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-4">
            {ROWS.map((row) => (
              <div
                key={row.key}
                className="flex items-center gap-4 rounded-lg border border-surface-border bg-surface-raised p-4"
              >
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-semibold text-navy">{row.label}</p>
                  <p className="text-xs text-navy/70">{row.help}</p>
                </div>
                <label className="inline-flex shrink-0 cursor-pointer items-center">
                  <input
                    type="checkbox"
                    aria-label={row.label}
                    checked={!settings?.[row.key]}
                    onChange={(e) => handleChange(row.key, row.doneDescription, e.target.checked)}
                    disabled={disabled}
                    className="h-4 w-4 rounded border-surface-border"
                  />
                </label>
              </div>
            ))}
          </div>
          <InvoiceLayoutPreview layout={shown} />
        </div>
      </div>
    </Card>
  );
}
