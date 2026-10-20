"use client";

import * as React from "react";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import {
  ADJUSTMENT_REASON_LABELS,
  ADJUSTMENT_REASON_NOTE_MAX,
  type AdjustmentReason,
} from "@routeflow/types";
import { useProductCount } from "@/lib/api/inventory";
import { useProductUnits, useUnitsEnabled } from "@/lib/api/product-units";
import {
  buildCountRequest,
  countUnitOptions,
  previewLine,
  todayISO,
  validateCount,
  type CountForm,
  type CountMode,
} from "@/lib/product-count";
import { countErrorText } from "@/lib/product-count-error";

export interface CountTarget {
  id: string;
  name: string;
  unit: string;
  unitsPerBox?: number | null;
  /** PIECES (system-wide stock unit). */
  currentStock: number;
}

const INPUT =
  "w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

/**
 * SA-828 (row 657): count the stock, or adjust it by an amount, in any of the product's units. The
 * preview line shows the RESULTING stock before anything is written; the server re-validates.
 */
export function CountAdjustModal({
  product,
  onClose,
}: {
  product: CountTarget;
  onClose: () => void;
}) {
  const unitsEnabled = useUnitsEnabled();
  const ladder = useProductUnits(product.id, unitsEnabled);
  const options = React.useMemo(
    () => countUnitOptions(product, unitsEnabled ? ladder.data : null),
    [product, unitsEnabled, ladder.data],
  );
  const count = useProductCount(product.id);
  const { toast } = useToast();
  const [form, setForm] = React.useState<CountForm>({
    mode: "SET",
    sign: "-",
    quantity: "",
    unit: "",
    reason: "",
    note: "",
    date: "",
  });
  const [showDate, setShowDate] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Default to the pack (first option); keep a chosen unit that is still offered.
  const unit = options.some((o) => o.label === form.unit) ? form.unit : (options[0]?.label ?? "");
  const f: CountForm = { ...form, unit };
  const patch = (p: Partial<CountForm>) => {
    setServerError(null);
    setForm((prev) => ({ ...prev, ...p }));
  };

  const problem = validateCount(f, options);
  // The inline line is about the quantity only (the reason and note are marked required); quiet until typed.
  const inlineError =
    f.quantity.trim() === ""
      ? null
      : validateCount({ ...f, reason: "COUNT_CORRECTION", note: "" }, options);
  const preview = previewLine(f, options, product.currentStock);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || count.isPending) return;
    setServerError(null);
    count.mutate(buildCountRequest(f), {
      onSuccess: (res) => {
        toast({
          title: `Stock updated to ${res.stockAfter.toLocaleString("en-US")} pcs`,
          variant: "success",
        });
        onClose();
      },
      onError: (err) => setServerError(countErrorText(err)),
    });
  };

  const modes: [CountMode, string][] = [
    ["SET", "Set count"],
    ["ADJUST", "Adjust"],
  ];

  return (
    <Modal open onClose={onClose} title={`Count / Adjust — ${product.name}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div
          role="radiogroup"
          aria-label="What to do"
          className="flex gap-1 rounded-lg bg-surface-muted p-1"
        >
          {modes.map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={f.mode === m}
              onClick={() => patch({ mode: m })}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                f.mode === m ? "bg-white text-navy shadow-card" : "text-navy/70"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div>
          <label htmlFor="count-qty" className="mb-1 block text-xs text-navy">
            {f.mode === "SET" ? "Counted" : "Amount"}
          </label>
          <div className="flex gap-2">
            {f.mode === "ADJUST" && (
              <button
                type="button"
                aria-label={f.sign === "+" ? "Adding stock" : "Removing stock"}
                onClick={() => patch({ sign: f.sign === "+" ? "-" : "+" })}
                className="w-10 shrink-0 rounded border border-surface-border text-base font-semibold text-navy"
              >
                {f.sign === "+" ? "+" : "−"}
              </button>
            )}
            <input
              id="count-qty"
              autoFocus
              inputMode="decimal"
              value={f.quantity}
              onChange={(e) => patch({ quantity: e.target.value })}
              className={INPUT}
              placeholder="0"
            />
            <select
              aria-label="Unit"
              value={unit}
              onChange={(e) => patch({ unit: e.target.value })}
              className={`${INPUT} !w-auto min-w-[6rem]`}
            >
              {options.map((o) => (
                <option key={o.label} value={o.label}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {inlineError && (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {inlineError}
            </p>
          )}
          {preview && !inlineError && (
            <p className="mt-1 text-xs font-medium text-navy" data-testid="count-preview">
              {preview}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="count-reason" className="mb-1 block text-xs text-navy">
            Reason *
          </label>
          <select
            id="count-reason"
            value={f.reason}
            onChange={(e) => patch({ reason: e.target.value as AdjustmentReason | "" })}
            className={INPUT}
          >
            <option value="">Choose a reason</option>
            {(Object.keys(ADJUSTMENT_REASON_LABELS) as AdjustmentReason[]).map((r) => (
              <option key={r} value={r}>
                {ADJUSTMENT_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="count-note" className="mb-1 block text-xs text-navy">
            Note{f.reason === "OTHER" ? " *" : " (optional)"}
          </label>
          <textarea
            id="count-note"
            rows={2}
            maxLength={ADJUSTMENT_REASON_NOTE_MAX}
            value={f.note}
            onChange={(e) => patch({ note: e.target.value })}
            className={`${INPUT} resize-none`}
          />
          <p className="mt-1 text-right text-xs text-navy/50">
            {f.note.length}/{ADJUSTMENT_REASON_NOTE_MAX}
          </p>
        </div>

        {showDate ? (
          <div>
            <label htmlFor="count-date" className="mb-1 block text-xs text-navy">
              Date
            </label>
            <input
              id="count-date"
              type="date"
              max={todayISO()}
              value={f.date || todayISO()}
              onChange={(e) => patch({ date: e.target.value })}
              className={INPUT}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDate(true)}
            className="text-xs font-medium text-brand-600 hover:underline"
          >
            Change date
          </button>
        )}

        {serverError && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {serverError}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={problem !== null} loading={count.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
