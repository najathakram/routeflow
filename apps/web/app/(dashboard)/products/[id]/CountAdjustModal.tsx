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
  belowZeroWarning,
  buildCountRequest,
  countUnitOptions,
  noteHint,
  previewLines,
  reasonHint,
  rowProblem,
  stockWithWord,
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
  packLabel?: string | null;
  baseUnitLabel?: string | null;
  /** PIECES (system-wide stock unit). */
  currentStock: number;
}

// Every control is at least 44 px tall below `sm` (staff use the web at 390 px).
const TALL = "min-h-[44px] sm:min-h-0";
const INPUT = `w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 ${TALL}`;

/** A labelled two-option control (tabs, Add | Remove): a sunken track, the selected segment raised. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex gap-1 rounded-lg bg-navy/10 p-1 shadow-inner"
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${TALL} ${
            value === v
              ? "bg-white text-navy shadow-card ring-1 ring-surface-border"
              : "text-navy/70"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * SA-828 (row 657) + SA-957 M1 / SA-958: count the stock, or adjust it, as one quantity row per unit the
 * product offers ("3 Case + 4 Box"; blank = 0). The preview shows the RESULTING stock before anything is
 * written; a result under zero is warned about, not blocked; the server re-validates.
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
    quantities: {},
    reason: "",
    note: "",
    date: "",
  });
  const [showDate, setShowDate] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const patch = (p: Partial<CountForm>) => {
    setServerError(null);
    setForm((prev) => ({ ...prev, ...p }));
  };
  const setRow = (value: string, text: string) =>
    patch({ quantities: { ...form.quantities, [value]: text } });

  const problem = validateCount(form, options);
  const lines = previewLines(form, options, product.currentStock);
  const belowZero = belowZeroWarning(form, options, product.currentStock);
  const typed = Object.values(form.quantities).some((t) => t.trim() !== "");
  const reasonProblem = typed ? reasonHint(form) : null;
  const noteProblem = typed ? noteHint(form) : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || count.isPending) return;
    setServerError(null);
    count.mutate(buildCountRequest(form, options), {
      onSuccess: (res) => {
        toast({
          title: `Stock updated to ${stockWithWord(res.stockAfter, options)}`,
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
    <Modal open onClose={onClose} anchor="top" title={`Count / Adjust — ${product.name}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Segmented
          label="What to do"
          value={form.mode}
          options={modes}
          onChange={(mode) => patch({ mode })}
        />

        {form.mode === "ADJUST" && (
          <Segmented
            label="Add or remove"
            value={form.sign}
            options={[
              ["+", "Add"],
              ["-", "Remove"],
            ]}
            onChange={(sign) => patch({ sign })}
          />
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1 block text-xs text-navy">
            {form.mode === "SET" ? "Counted" : "Amount"}
          </legend>
          {options.map((o, i) => {
            const text = form.quantities[o.value] ?? "";
            const err = rowProblem(o, text, options);
            const errId = `count-row-error-${i}`;
            return (
              <div key={o.value || "pack"}>
                <div className="flex items-center gap-2">
                  <label htmlFor={`count-qty-${i}`} className="w-28 shrink-0 text-sm text-navy">
                    {o.label}
                    {o.factor > 1 && (
                      <span className="block text-xs text-navy/60">
                        {"\u00d7"}
                        {o.factor}
                      </span>
                    )}
                  </label>
                  <input
                    id={`count-qty-${i}`}
                    autoFocus={i === 0}
                    inputMode="decimal"
                    value={text}
                    onChange={(e) => setRow(o.value, e.target.value)}
                    className={INPUT}
                    placeholder="0"
                    aria-describedby={err ? errId : "count-preview"}
                    aria-invalid={err ? true : undefined}
                  />
                </div>
                {err && (
                  <p
                    id={errId}
                    role="alert"
                    className="mt-1 text-xs text-red-600"
                    data-testid={`count-row-error-${o.label}`}
                  >
                    {err}
                  </p>
                )}
              </div>
            );
          })}
          {lines.length > 0 && (
            <div id="count-preview" className="space-y-0.5 pt-1" data-testid="count-preview">
              {lines.map((l) => (
                <p key={l} className="text-xs font-medium text-navy">
                  {l}
                </p>
              ))}
            </div>
          )}
          {belowZero && (
            <p
              role="status"
              className="text-xs font-medium text-amber-700"
              data-testid="count-below-zero"
            >
              {belowZero}
            </p>
          )}
        </fieldset>

        <div>
          <label htmlFor="count-reason" className="mb-1 block text-xs text-navy">
            Reason *
          </label>
          <select
            id="count-reason"
            value={form.reason}
            onChange={(e) => patch({ reason: e.target.value as AdjustmentReason | "" })}
            className={INPUT}
            aria-describedby={reasonProblem ? "count-reason-hint" : undefined}
          >
            <option value="">Choose a reason</option>
            {(Object.keys(ADJUSTMENT_REASON_LABELS) as AdjustmentReason[]).map((r) => (
              <option key={r} value={r}>
                {ADJUSTMENT_REASON_LABELS[r]}
              </option>
            ))}
          </select>
          {reasonProblem && (
            <p
              id="count-reason-hint"
              className="mt-1 text-xs text-navy/70"
              data-testid="count-reason-hint"
            >
              {reasonProblem}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="count-note" className="mb-1 block text-xs text-navy">
            Note{form.reason === "OTHER" ? " *" : " (optional)"}
          </label>
          <textarea
            id="count-note"
            rows={2}
            maxLength={ADJUSTMENT_REASON_NOTE_MAX}
            value={form.note}
            onChange={(e) => patch({ note: e.target.value })}
            className={`${INPUT} resize-none`}
            aria-describedby={noteProblem ? "count-note-hint" : undefined}
          />
          <div className="mt-1 flex justify-between gap-2 text-xs">
            {noteProblem ? (
              <span id="count-note-hint" className="text-navy/70" data-testid="count-note-hint">
                {noteProblem}
              </span>
            ) : (
              <span />
            )}
            <span className="text-navy/50">
              {form.note.length}/{ADJUSTMENT_REASON_NOTE_MAX}
            </span>
          </div>
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
              value={form.date || todayISO()}
              onChange={(e) => patch({ date: e.target.value })}
              className={INPUT}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDate(true)}
            className={`text-xs font-medium text-brand-600 hover:underline ${TALL}`}
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
          <Button variant="secondary" type="button" onClick={onClose} className={TALL}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={problem !== null}
            loading={count.isPending}
            className={TALL}
          >
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
