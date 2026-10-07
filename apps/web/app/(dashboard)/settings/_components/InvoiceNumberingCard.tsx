"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, useToast } from "@routeflow/ui/web";
import { DOCUMENT_PREFIX_MAX_LENGTH, validateDocumentPrefix } from "@routeflow/types";
import { apiClient } from "@/lib/api-client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  NUMBERING_QUERY_KEY,
  previewNumberingPrefix,
  type NumberingPrefixPreview,
  type NumberingSetting,
} from "@/lib/api/numbering";
import { useInvoiceSettings } from "@/lib/api/invoices";

/** The invoice payment terms the api accepts (`VALID_TERMS`); due days are TERM_DAYS 0/15/30/45/60. */
export const INVOICE_TERMS_OPTIONS = [
  { value: "Due on Receipt", label: "Due on Receipt" },
  { value: "Net 15", label: "Net 15" },
  { value: "Net 30", label: "Net 30" },
  { value: "Net 45", label: "Net 45" },
  { value: "Net 60", label: "Net 60" },
];

const DEFAULT_TERMS = "Net 30";

function errorMessage(e: unknown): string {
  const m = (e as any)?.response?.data?.message;
  if (Array.isArray(m)) return m.join(" ");
  return typeof m === "string" ? m : ((e as Error)?.message ?? "Request failed");
}

/**
 * Settings > Invoicing > Invoice Numbering (B1188). Each control writes to its REAL store:
 *  - prefix -> the INVOICE numbering sequence (`PUT /import/numbering/INVOICE`), behind a server
 *    preview of the next number the new prefix would mint and an explicit confirm; the save
 *    carries the preview's `expectedNextNumber` so a sequence that moved meanwhile is refused;
 *  - payment due days -> the `invoice.defaultTerms` setting (`PATCH /settings/invoice`).
 * Nothing here PATCHes `/settings` any more (the api now 400s `invoicePrefix`/`paymentDueDays`).
 */
export function InvoiceNumberingCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: invoiceSettings } = useInvoiceSettings();
  const { data: numbering } = useQuery<NumberingSetting[]>({
    queryKey: NUMBERING_QUERY_KEY,
    queryFn: () => apiClient.get("/import/numbering").then((r) => r.data),
  });
  const row = numbering?.find((n) => n.docType === "INVOICE");

  const [prefixDraft, setPrefixDraft] = React.useState<string | null>(null);
  const [termsDraft, setTermsDraft] = React.useState<string | null>(null);
  const [prefixError, setPrefixError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<NumberingPrefixPreview | null>(null);
  const [saving, setSaving] = React.useState(false);

  const savedPrefix = row?.prefix ?? "";
  const savedTerms = invoiceSettings?.defaultTerms ?? DEFAULT_TERMS;
  const prefix = prefixDraft ?? savedPrefix;
  const terms = termsDraft ?? savedTerms;
  const prefixChanged = prefix !== savedPrefix;
  const termsChanged = terms !== savedTerms;

  const saveTerms = async () => {
    await apiClient.patch("/settings/invoice", { defaultTerms: terms });
    setTermsDraft(null);
    await qc.invalidateQueries({ queryKey: ["invoice-settings"] });
  };

  const handleSave = async () => {
    setPrefixError(null);
    if (!prefixChanged && !termsChanged) {
      toast({ title: "Nothing to save", variant: "info" });
      return;
    }
    if (prefixChanged) {
      const invalid = validateDocumentPrefix(prefix);
      if (invalid) {
        setPrefixError(invalid);
        return;
      }
      setSaving(true);
      try {
        setPending(await previewNumberingPrefix("INVOICE", prefix));
      } catch (e) {
        toast({
          title: "Could not preview the new prefix",
          description: errorMessage(e),
          variant: "error",
        });
      } finally {
        setSaving(false);
      }
      return; // the confirm dialog finishes the save
    }
    setSaving(true);
    try {
      await saveTerms();
      toast({ title: "Payment terms saved", variant: "success" });
    } catch (e) {
      toast({ title: "Failed to save", description: errorMessage(e), variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const handleConfirm = async () => {
    if (!pending) return;
    setSaving(true);
    try {
      const saved = await apiClient
        .put("/import/numbering/INVOICE", {
          prefix: pending.prefix,
          expectedNextNumber: pending.expectedNextNumber,
        })
        .then((r) => r.data as NumberingSetting);
      setPrefixDraft(null);
      await qc.invalidateQueries({ queryKey: NUMBERING_QUERY_KEY });
      if (termsChanged) await saveTerms();
      toast({
        title: "Invoice numbering saved",
        description: `Next invoice will be ${saved.preview}`,
        variant: "success",
      });
    } catch (e) {
      const stale = (e as any)?.response?.status === 409;
      if (stale) {
        // The sequence moved since the preview: drop the draft so it re-seeds from the server.
        setPrefixDraft(null);
        await qc.invalidateQueries({ queryKey: NUMBERING_QUERY_KEY });
      }
      toast({
        title: stale ? "Numbering changed since you opened this page" : "Could not save numbering",
        description: errorMessage(e),
        variant: "error",
      });
    } finally {
      setPending(null);
      setSaving(false);
    }
  };

  const inputClass =
    "h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <Card title="Invoice Numbering">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="invoice-number-prefix"
            className="mb-1.5 block text-sm font-medium text-navy"
          >
            Invoice Number Prefix
          </label>
          <input
            id="invoice-number-prefix"
            type="text"
            value={prefix}
            onChange={(e) => {
              setPrefixDraft(e.target.value);
              setPrefixError(null);
            }}
            placeholder="INV-"
            maxLength={DOCUMENT_PREFIX_MAX_LENGTH}
            aria-invalid={prefixError ? true : undefined}
            aria-describedby={prefixError ? "invoice-number-prefix-error" : undefined}
            className={inputClass}
          />
          {prefixError ? (
            <p id="invoice-number-prefix-error" role="alert" className="mt-1 text-xs text-danger">
              {prefixError}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-navy/70">
            Prepended to invoice numbers (e.g. INV-, 2026-).
          </p>
        </div>
        <div>
          <label htmlFor="invoice-due-days" className="mb-1.5 block text-sm font-medium text-navy">
            Payment Due Days
          </label>
          <select
            id="invoice-due-days"
            value={terms}
            onChange={(e) => setTermsDraft(e.target.value)}
            className={inputClass}
          >
            {INVOICE_TERMS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-navy/70">
            Default days until payment is due (Due on Receipt = 0).
          </p>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={handleSave} loading={saving && !pending} size="sm">
          Save Numbering
        </Button>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={handleConfirm}
        title="Change the invoice prefix?"
        description={
          pending
            ? `The next invoice will be numbered ${pending.preview}. Existing invoices keep their current numbers.`
            : undefined
        }
        confirmLabel="Confirm"
        variant="secondary"
        loading={saving}
      />
    </Card>
  );
}
