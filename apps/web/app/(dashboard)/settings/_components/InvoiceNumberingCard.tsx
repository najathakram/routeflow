"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, useToast } from "@routeflow/ui/web";
import { DOCUMENT_PREFIX_MAX_LENGTH, validateDocumentPrefix } from "@/lib/document-prefix";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { isAccountAdmin } from "@/lib/auth";
import { describeSaveError } from "@/lib/reason-copy";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  NUMBERING_QUERY_KEY,
  previewNumberingPrefix,
  type NumberingPrefixPreview,
  type NumberingSetting,
} from "@/lib/api/numbering";

/** The invoice payment terms the api accepts (`VALID_TERMS`); due days are TERM_DAYS 0/15/30/45/60. */
export const INVOICE_TERMS_OPTIONS = [
  { value: "Due on Receipt", label: "Due on Receipt" },
  { value: "Net 15", label: "Net 15" },
  { value: "Net 30", label: "Net 30" },
  { value: "Net 45", label: "Net 45" },
  { value: "Net 60", label: "Net 60" },
];

/** Fixed sentence for a moved sequence (no server text is echoed: B986). */
export const STALE_SEQUENCE_COPY =
  "The invoice sequence changed since your preview. Review the new next number and confirm again.";

/** 409 -> fixed copy; a prefix the rule rejects -> the shared validator's message; else generic. */
function failureCopy(e: unknown, prefix: string): string {
  if ((e as any)?.response?.status === 409) return STALE_SEQUENCE_COPY;
  return validateDocumentPrefix(prefix) ?? describeSaveError(e);
}

/**
 * Settings > Invoicing > Invoice Numbering (B1188). Each control writes to its REAL store:
 *  - prefix -> the INVOICE numbering sequence (`PUT /import/numbering/INVOICE`), behind a server
 *    preview of the next number the new prefix would mint and an explicit confirm; the save
 *    carries the preview's `expectedNextNumber` so a sequence that moved meanwhile is refused;
 *  - payment due days -> the `invoice.defaultTerms` setting (`PATCH /settings/invoice`).
 * Nothing here PATCHes `/settings` any more (the api now 400s `invoicePrefix`/`paymentDueDays`).
 */
export function InvoiceNumberingCard({
  terms,
  onTermsChange,
  termsDisabled = false,
}: {
  /** The ONE payment-terms value, shared with the "Payment Terms" select (saved by the parent). */
  terms: string;
  onTermsChange: (value: string) => void;
  termsDisabled?: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  // The whole /import/numbering controller is admin-only (GET included): an operator never requests
  // it, never sees the prefix field, and keeps the payment-terms select.
  const isAdmin = isAccountAdmin(useAuth().user);
  const { data: numbering } = useQuery<NumberingSetting[]>({
    queryKey: NUMBERING_QUERY_KEY,
    queryFn: () => apiClient.get("/import/numbering").then((r) => r.data),
    enabled: isAdmin,
  });
  const row = numbering?.find((n) => n.docType === "INVOICE");

  const [prefixDraft, setPrefixDraft] = React.useState<string | null>(null);
  const [prefixError, setPrefixError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<NumberingPrefixPreview | null>(null);
  const [saving, setSaving] = React.useState(false);

  // An unconfigured tenant mints the yearly series (INV-2026-0039): the field stays empty and the
  // placeholder shows the server's current format; the server preview says what comes next.
  const unconfigured = !!row && !row.configured;
  const savedPrefix = unconfigured ? "" : (row?.prefix ?? "");
  const formatPlaceholder = row ? row.preview.replace(/\d+$/, "") : "INV-";
  const prefix = prefixDraft ?? savedPrefix;
  const prefixChanged = prefix !== savedPrefix;

  const handleSave = async () => {
    setPrefixError(null);
    if (!prefixChanged) {
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
          description: failureCopy(e, prefix),
          variant: "error",
        });
      } finally {
        setSaving(false);
      }
      return; // the confirm dialog finishes the save
    }
  };

  // A ref, not state: a second click in the same tick must not reach the PUT before React re-renders
  // the dialog's Confirm button as loading/disabled.
  const confirmingRef = React.useRef(false);

  const handleConfirm = async () => {
    if (!pending || confirmingRef.current) return;
    confirmingRef.current = true;
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
        description: failureCopy(e, pending.prefix),
        variant: "error",
      });
    } finally {
      setPending(null);
      setSaving(false);
      confirmingRef.current = false;
    }
  };

  const inputClass =
    "h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <Card title="Invoice Numbering">
      <div className="grid grid-cols-2 gap-4">
        {isAdmin && (
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
              placeholder={formatPlaceholder}
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
            {unconfigured && row ? (
              <p className="mt-1 text-xs text-navy/70" data-testid="invoice-next-preview">
                Next invoice: {row.preview} (yearly numbering)
              </p>
            ) : null}
          </div>
        )}
        <div>
          <label htmlFor="invoice-due-days" className="mb-1.5 block text-sm font-medium text-navy">
            Payment Due Days
          </label>
          <select
            id="invoice-due-days"
            value={terms}
            onChange={(e) => onTermsChange(e.target.value)}
            disabled={termsDisabled}
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
      {isAdmin && (
        <div className="mt-4 flex justify-end">
          <Button onClick={handleSave} loading={saving && !pending} size="sm">
            Save Numbering
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={handleConfirm}
        title="Change the invoice prefix?"
        description={
          pending
            ? `Next invoice: ${pending.preview} (currently ${row?.preview ?? "unknown"}). Existing invoices keep their numbers.`
            : undefined
        }
        confirmLabel="Confirm"
        variant="secondary"
        loading={saving}
      />
    </Card>
  );
}
