"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import {
  useCreateTrackedCategory,
  useUpdateTrackedCategory,
  useRegulatedTemplates,
  type TrackedCategory,
  type TrackedCategoryTaxType,
  type InvoiceTreatment,
  type ReportCadence,
} from "@/lib/api/tracked-categories";

const TAX_TYPES: { value: TrackedCategoryTaxType; label: string }[] = [
  { value: "NONE", label: "None (track only, no auto tax)" },
  { value: "EXCISE_PER_UNIT", label: "Excise per unit" },
  { value: "PERCENT_OF_SALE", label: "Percent of sale" },
  { value: "PER_VOLUME", label: "Per volume" },
  { value: "DEPOSIT_PER_CONTAINER", label: "Deposit per container" },
];
const TREATMENTS: { value: InvoiceTreatment; label: string }[] = [
  { value: "SEPARATE_INVOICE", label: "Separate invoice (default)" },
  { value: "SEPARATE_SECTION", label: "Sectioned on the main invoice" },
  { value: "LINE_TAX", label: "Per-line tax" },
];
/** Fallback while `useRegulatedTemplates()` is loading. */
const TEMPLATES_FALLBACK = ["GENERIC", "CA_CDTFA", "CA_ABC", "CALRECYCLE", "TX_COMPTROLLER"];
const CADENCES: ReportCadence[] = ["MONTHLY", "QUARTERLY", "ANNUAL"];

const inputCls =
  "w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** When provided, the modal edits this category; otherwise it creates a new one. */
  category?: TrackedCategory | null;
}

export function CategoryFormModal({ isOpen, onClose, category }: Props) {
  const { toast } = useToast();
  const create = useCreateTrackedCategory();
  const update = useUpdateTrackedCategory();
  const editing = !!category;

  const [form, setForm] = React.useState({
    name: "",
    taxType: "NONE" as TrackedCategoryTaxType,
    rate: "0",
    unitBasis: "",
    priceIncludesTax: false,
    invoiceTreatment: "SEPARATE_INVOICE" as InvoiceTreatment,
    requiresLicense: false,
    reportTemplate: "GENERIC",
    reportCadence: "MONTHLY" as ReportCadence,
    active: true,
    wholesalerLicenseNo: "",
  });

  // Hydrate the form when opening (create → blank, edit → the category's values).
  React.useEffect(() => {
    if (!isOpen) return;
    if (category) {
      setForm({
        name: category.name,
        taxType: category.taxType,
        rate: String(category.rate ?? "0"),
        unitBasis: category.unitBasis ?? "",
        priceIncludesTax: category.priceIncludesTax,
        invoiceTreatment: category.invoiceTreatment,
        requiresLicense: category.requiresLicense,
        reportTemplate: category.reportTemplate,
        reportCadence: category.reportCadence,
        active: category.active,
        wholesalerLicenseNo: category.wholesalerLicenseNo ?? "",
      });
    } else {
      setForm({
        name: "",
        taxType: "NONE",
        rate: "0",
        unitBasis: "",
        priceIncludesTax: false,
        invoiceTreatment: "SEPARATE_INVOICE",
        requiresLicense: false,
        reportTemplate: "GENERIC",
        reportCadence: "MONTHLY",
        active: true,
        wholesalerLicenseNo: "",
      });
    }
  }, [isOpen, category]);

  const templatesQuery = useRegulatedTemplates();
  const templateOptions: { value: string; label: string }[] = templatesQuery.data
    ? templatesQuery.data.map((t) => ({ value: t.key, label: t.label }))
    : TEMPLATES_FALLBACK.map((t) => ({ value: t, label: t }));

  if (!isOpen) return null;

  const hasTax = form.taxType !== "NONE";
  const isPercent = form.taxType === "PERCENT_OF_SALE";
  const isTx = form.reportTemplate === "TX_COMPTROLLER";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      toast({ title: "Name is required", variant: "error" });
      return;
    }
    const payload = {
      name,
      taxType: form.taxType,
      rate: hasTax ? Number(form.rate) || 0 : 0,
      unitBasis: form.unitBasis.trim() || undefined,
      priceIncludesTax: form.priceIncludesTax,
      invoiceTreatment: form.invoiceTreatment,
      requiresLicense: form.requiresLicense,
      reportTemplate: form.reportTemplate,
      reportCadence: form.reportCadence,
      active: form.active,
      // null, NOT undefined: axios omits undefined keys from the JSON body, so a cleared
      // field (or a template switched away from TX) would never reach the DTO and Prisma
      // would leave the stale value in place. null clears the nullable column.
      wholesalerLicenseNo: isTx ? form.wholesalerLicenseNo.trim() || null : null,
    };
    const onDone = (verb: string) => {
      toast({ title: `Category ${verb}`, description: name, variant: "success" });
      onClose();
    };
    const onErr = (err: any) =>
      toast({
        title: `Failed to ${editing ? "update" : "create"} category`,
        description: err?.response?.data?.message ?? "Please try again.",
        variant: "error",
      });

    if (editing && category) {
      update.mutate(
        { id: category.id, data: payload },
        { onSuccess: () => onDone("updated"), onError: onErr },
      );
    } else {
      create.mutate(payload, { onSuccess: () => onDone("created"), onError: onErr });
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-surface-border bg-white px-6 py-4">
          <h2 className="text-base font-semibold text-navy">
            {editing ? "Edit category" : "New tracked category"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Name *</label>
            <input
              required
              autoFocus
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={inputCls}
              placeholder='e.g. "Alcohol", "CRV Beverage Deposits"'
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Tax type</label>
              <select
                value={form.taxType}
                onChange={(e) => {
                  const taxType = e.target.value as TrackedCategoryTaxType;
                  setForm((f) => ({
                    ...f,
                    taxType,
                    // unitBasis is meaningless for percent-of-sale / none — clear it
                    // so stale values from a prior per-unit type aren't persisted.
                    unitBasis:
                      taxType === "PERCENT_OF_SALE" || taxType === "NONE" ? "" : f.unitBasis,
                  }));
                }}
                className={inputCls}
              >
                {TAX_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Invoice treatment</label>
              <select
                value={form.invoiceTreatment}
                onChange={(e) =>
                  setForm((f) => ({ ...f, invoiceTreatment: e.target.value as InvoiceTreatment }))
                }
                className={inputCls}
              >
                {TREATMENTS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {hasTax && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-navy">
                  Rate {isPercent ? "(fraction — 0.05 = 5%)" : "($ per unit)"}
                </label>
                <input
                  type="number"
                  min={0}
                  step={isPercent ? 0.0001 : 0.01}
                  value={form.rate}
                  onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                  className={inputCls}
                  placeholder={isPercent ? "0.05" : "2.87"}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-navy">
                  Unit basis <span className="font-normal text-navy/60">(pack, oz…)</span>
                </label>
                <input
                  type="text"
                  value={form.unitBasis}
                  onChange={(e) => setForm((f) => ({ ...f, unitBasis: e.target.value }))}
                  className={inputCls}
                  placeholder={isPercent ? "n/a" : "pack"}
                  disabled={isPercent}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Report template</label>
              <select
                value={form.reportTemplate}
                onChange={(e) => setForm((f) => ({ ...f, reportTemplate: e.target.value }))}
                className={inputCls}
              >
                {templateOptions.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Report cadence</label>
              <select
                value={form.reportCadence}
                onChange={(e) =>
                  setForm((f) => ({ ...f, reportCadence: e.target.value as ReportCadence }))
                }
                className={inputCls}
              >
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {isTx && (
            <div className="space-y-3 rounded-lg border border-surface-border bg-surface-raised/40 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-navy/60">
                TX Comptroller
              </p>
              <div>
                <label className="mb-1 block text-xs font-medium text-navy">
                  Wholesaler license #
                </label>
                <input
                  type="text"
                  value={form.wholesalerLicenseNo}
                  onChange={(e) => setForm((f) => ({ ...f, wholesalerLicenseNo: e.target.value }))}
                  className={inputCls}
                  placeholder="12345678"
                  maxLength={20}
                />
                <p className="mt-1 text-[11px] text-navy/60">
                  Your 8-digit Texas license or permit number
                </p>
              </div>
              <p className="text-xs text-navy/60">
                Item type and unit of measure are configured per product.
              </p>
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-surface-border bg-surface-raised/40 p-3">
            {hasTax && (
              <label className="flex items-center gap-2 text-sm text-navy">
                <input
                  type="checkbox"
                  checked={form.priceIncludesTax}
                  onChange={(e) => setForm((f) => ({ ...f, priceIncludesTax: e.target.checked }))}
                  className="h-4 w-4 rounded border-surface-border accent-brand-500"
                />
                Price already includes this tax (show as “incl.” rather than adding a line)
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-navy">
              <input
                type="checkbox"
                checked={form.requiresLicense}
                onChange={(e) => setForm((f) => ({ ...f, requiresLicense: e.target.checked }))}
                className="h-4 w-4 rounded border-surface-border accent-brand-500"
              />
              Requires the customer to hold a license for this category
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending || update.isPending}>
              {editing ? "Save changes" : "Create category"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
