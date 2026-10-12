"use client";

import * as React from "react";
import { isSpecialTier } from "@routeflow/pricing";
import { Button, Input, Modal, cn } from "@routeflow/ui/web";
import {
  isBoxedLine,
  resolveCounterPriceEdit,
  type PriceEditLine,
  type PriceEditMode,
  type PriceEditRefusal,
} from "@/lib/counter-price-edit";

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

/** What Apply hands back: the screen replaces ONE line's override with it and never posts from here. */
export interface CounterPriceEdit {
  mode: PriceEditMode;
  /** the number the clerk typed (the price, the percent, or the dollars off per selling unit) */
  value: number;
  /** the resolved NET unit price (already rounded to cents) */
  unitPrice: number;
  /** false = within 1/2 cent of the tier price: clear any override on the line */
  override: boolean;
  /** trimmed; absent when blank */
  reason?: string;
}

export interface CounterLinePriceEditProps {
  /**
   * The ONE gate (`staffMay(role, "EDIT_LINE_PRICE")`). When false NOTHING renders: no button, no
   * dialog, no label, no tab stop. Hidden, never disabled.
   */
  canEditPrices: boolean;
  /** the line's product name (accessible names and the dialog title) */
  name: string;
  line: PriceEditLine;
  /** the line carries an edited price now: shows the `Reset price` link (needs `onReset`) */
  edited?: boolean;
  /** the picked customer's name, for the special-price reason copy */
  customerName?: string;
  /** an unknown-outcome sale is held: the control is disabled like the stepper and remove button */
  locked?: boolean;
  onApply: (edit: CounterPriceEdit) => void;
  onReset?: () => void;
  /** called when the dialog closes (Apply, Cancel, Escape): the screen refocuses its scan field here */
  onClosed?: () => void;
}

const MODES: ReadonlyArray<{ mode: PriceEditMode; label: string }> = [
  { mode: "set", label: "Set price" },
  { mode: "percent", label: "Percent off" },
  { mode: "amount", label: "Amount off" },
];

function fieldLabel(mode: PriceEditMode, boxed: boolean): string {
  const unit = boxed ? "box" : "item";
  if (mode === "set") return `Price per ${unit}`;
  if (mode === "percent") return "Percent off";
  return `Amount off per ${unit}`;
}

function refusalCopy(
  refused: PriceEditRefusal,
  customerName: string | undefined,
  max: number | undefined,
): string {
  switch (refused) {
    case "NOT_A_NUMBER":
      return "Enter a price, like 12.50.";
    case "NEGATIVE":
      return "Enter 0 or more.";
    case "PERCENT_RANGE":
      return "Enter a percentage from 0 to 100.";
    case "AMOUNT_OVER_PRICE":
      return `That's more than the price. Enter ${money(max ?? 0)} or less.`;
    case "REASON_REQUIRED":
      return `Add a reason. ${customerName?.trim() || "This customer"} has a special price on this item.`;
  }
}

/**
 * POS-5: the counter line's price control. A small `Edit price` button that opens a dialog with three ways to
 * change ONE line's price (set it, a percent off, an amount off per selling unit), each resolved to a single net
 * unit price by `resolveCounterPriceEdit` (@routeflow/pricing underneath; a boxed line is priced by its BOX).
 * It owns no sale, payment or request state: Apply hands the result to `onApply`, Cancel and Escape change
 * nothing. Rendered only when `canEditPrices` is true.
 */
export function CounterLinePriceEdit({
  canEditPrices,
  name,
  line,
  edited = false,
  customerName,
  locked = false,
  onApply,
  onReset,
  onClosed,
}: CounterLinePriceEditProps) {
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<PriceEditMode>("set");
  const [value, setValue] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const valueRef = React.useRef<HTMLInputElement>(null);
  const errorId = React.useId();

  if (!canEditPrices) return null;

  const boxed = isBoxedLine(line);
  const unitWord = boxed ? "box" : "item";
  // CQ-14: the label says what Apply will do. The reason is required for exactly the lines the shared rule
  // (`decideStaffOverride`, which `resolveCounterPriceEdit` runs) refuses without one: a special-tier line.
  const reasonRequired = isSpecialTier(line.tier);

  const openDialog = () => {
    setMode("set");
    setValue("");
    setReason("");
    setError(null);
    setOpen(true);
  };
  const close = () => setOpen(false);

  // The live preview comes from the same helper Apply uses, so it can never differ from the cart's line total.
  const preview = value.trim() === "" ? null : resolveCounterPriceEdit(mode, value, line, reason);

  const apply = (e?: React.FormEvent) => {
    e?.preventDefault();
    const result = resolveCounterPriceEdit(mode, value, line, reason);
    if (!result.ok) {
      setError(refusalCopy(result.refused, customerName, result.max));
      valueRef.current?.focus();
      return;
    }
    onApply({
      mode,
      value: Number(value.trim()),
      unitPrice: result.unitPrice,
      override: result.override,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    close();
  };

  return (
    <>
      <span className="inline-flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
          aria-label={`Edit price for ${name}`}
          disabled={locked}
          onClick={openDialog}
        >
          Edit price
        </Button>
        {edited && onReset && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="min-h-[44px] sm:min-h-0"
            disabled={locked}
            onClick={onReset}
          >
            Reset price
          </Button>
        )}
      </span>
      <Modal
        open={open}
        onClose={close}
        title={`Change price for ${name}`}
        className="max-w-md"
        // Focus goes to the number field, not the first radio.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          valueRef.current?.focus();
        }}
        // Closing hands focus back to the screen (its scan field) instead of the trigger.
        onCloseAutoFocus={
          onClosed
            ? (e) => {
                e.preventDefault();
                onClosed();
              }
            : undefined
        }
      >
        <form onSubmit={apply} className="flex flex-col gap-4" noValidate>
          <div
            role="radiogroup"
            aria-label="How to change the price"
            className="grid grid-cols-3 gap-1 rounded-lg bg-surface-raised p-1"
          >
            {MODES.map((m) => (
              <label
                key={m.mode}
                className={cn(
                  "flex min-h-[44px] cursor-pointer items-center justify-center rounded-md px-2 text-center text-[13px] font-medium text-navy sm:min-h-9",
                  "focus-within:ring-2 focus-within:ring-brand-500",
                  mode === m.mode ? "bg-white shadow-card" : "text-navy/70 hover:text-navy",
                )}
              >
                <input
                  type="radio"
                  name="counter-price-mode"
                  value={m.mode}
                  checked={mode === m.mode}
                  onChange={() => {
                    setMode(m.mode);
                    setError(null);
                  }}
                  className="sr-only"
                />
                {m.label}
              </label>
            ))}
          </div>

          <Input
            ref={valueRef}
            label={fieldLabel(mode, boxed)}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />

          <Input
            label={reasonRequired ? "Reason (required)" : "Reason (optional)"}
            aria-required={reasonRequired ? true : undefined}
            type="text"
            maxLength={200}
            autoComplete="off"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
          />

          {error && (
            <p id={errorId} role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <p aria-live="polite" className="min-h-[1.25rem] text-sm text-navy/70">
            {preview?.ok
              ? `New price ${money(preview.unitPrice)} per ${unitWord}. Line total ${money(preview.lineTotal)}.`
              : ""}
          </p>

          <div className="flex items-center justify-end gap-3 border-t border-surface-border pt-4">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
