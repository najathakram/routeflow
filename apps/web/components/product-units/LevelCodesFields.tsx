"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import type { LadderRow } from "@/lib/unit-ladder";

const FIELD =
  "h-10 w-full rounded-md border border-surface-border bg-white px-2.5 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";
const LABEL = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-navy/60";
const SMALL_BTN = "min-h-[44px] text-sm font-medium text-brand-600 md:min-h-0";

export const CODE_TOO_LONG = "Keep it to 64 characters or fewer.";

/** Client twin of the server's shared code validator (trim; <= 64; no control characters). */
export function codeError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return "A code can't contain line breaks.";
  if (v.length > 64) return CODE_TOO_LONG;
  return null;
}

/**
 * One level's own barcode and SKU: "same as <fallback>" until the owner opts in. Built for U-8; the editor only
 * mounts it when `LEVEL_CODES_UI_ENABLED` is true.
 */
export function LevelCodesFields({
  row,
  fallbackName,
  packName,
  serverError,
  onChange,
  idPrefix,
}: {
  row: LadderRow;
  /** The unit whose codes this level uses until it has its own (the smallest unit). */
  fallbackName: string;
  /** Set when the pack is a different unit than the fallback: "Use Pack's instead". */
  packName?: string;
  serverError?: { field?: "sku" | "barcode"; message: string } | null;
  onChange: (patch: Partial<Pick<LadderRow, "barcode" | "sku">>) => void;
  idPrefix: string;
}) {
  const { toast } = useToast();
  const differs = row.barcode.trim() !== "" || row.sku.trim() !== "";
  const [open, setOpen] = React.useState(differs);
  const panelId = `${idPrefix}-codes`;
  const bErr = codeError(row.barcode);
  const sErr = codeError(row.sku);

  const useOthers = () => {
    const prev = { barcode: row.barcode, sku: row.sku };
    onChange({ barcode: "", sku: "" });
    setOpen(false);
    toast({
      title: `${row.label} now uses the same barcode and SKU as ${packName ?? fallbackName}.`,
      variant: "success",
      action: { label: "Undo", onClick: () => (onChange(prev), setOpen(true)) },
    });
  };

  return (
    <div className="mt-2 text-sm text-navy/80">
      {!open ? (
        <p>
          Barcode and SKU: same as {fallbackName}.{" "}
          <button
            type="button"
            className={SMALL_BTN}
            aria-expanded={false}
            aria-controls={panelId}
            onClick={() => setOpen(true)}
          >
            Different barcode or SKU
          </button>
        </p>
      ) : (
        <div id={panelId}>
          <button
            type="button"
            className={SMALL_BTN}
            aria-expanded
            aria-controls={panelId}
            onClick={() => setOpen(false)}
          >
            Different barcode or SKU
          </button>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor={`${idPrefix}-barcode`}>
                Barcode
              </label>
              <input
                id={`${idPrefix}-barcode`}
                className={FIELD}
                value={row.barcode}
                aria-invalid={bErr != null || serverError?.field === "barcode"}
                onChange={(e) => onChange({ barcode: e.target.value })}
              />
              {(bErr || serverError?.field === "barcode") && (
                <p className="mt-1 text-xs text-red-600">{bErr ?? serverError?.message}</p>
              )}
            </div>
            <div>
              <label className={LABEL} htmlFor={`${idPrefix}-sku`}>
                SKU
              </label>
              <input
                id={`${idPrefix}-sku`}
                className={FIELD}
                value={row.sku}
                aria-invalid={sErr != null || serverError?.field === "sku"}
                onChange={(e) => onChange({ sku: e.target.value })}
              />
              {(sErr || serverError?.field === "sku") && (
                <p className="mt-1 text-xs text-red-600">{sErr ?? serverError?.message}</p>
              )}
            </div>
          </div>
          <p className="mt-1 text-xs text-navy/60">
            Leave a field blank to use {fallbackName}&apos;s.
          </p>
          {differs && (
            <button type="button" className={SMALL_BTN} onClick={useOthers}>
              Use {packName ?? fallbackName}&apos;s instead
            </button>
          )}
        </div>
      )}
    </div>
  );
}
