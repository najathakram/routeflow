"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { useCreateProductUnit } from "@/lib/api/product-units";
import { orderErrorText } from "@/lib/order-error-text";
import { DIRTY_HINT, usePanelDisclosure } from "./usePanelDisclosure";

/** A unit the new one can contain: its name and how many base pieces one of it holds. */
export interface AddUnitOf {
  label: string;
  factorToBase: number;
}

/** What the panel reports when a unit was created: the new unit's id, its name, and the price text typed (or ""). */
export interface AddedUnit {
  id: string | undefined;
  label: string;
  price: string;
}

const FIELD =
  "h-10 w-full rounded-md border border-surface-border bg-white px-2.5 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";
const LABEL = "mb-1 block text-xs font-medium text-navy/70";

function AddUnitForm({
  productId,
  baseLabel,
  ofUnits,
  validatePrice,
  onDone,
  onCancel,
}: {
  productId: string;
  baseLabel: string;
  ofUnits: AddUnitOf[];
  validatePrice?: (text: string) => string | null;
  onDone: (added: AddedUnit) => void;
  onCancel: () => void;
}) {
  const create = useCreateProductUnit(productId);
  const uid = React.useId();
  const nameRef = React.useRef<HTMLInputElement>(null);
  const [name, setName] = React.useState("");
  const [n, setN] = React.useState("");
  const options: AddUnitOf[] = [{ label: baseLabel, factorToBase: 1 }, ...ofUnits];
  const [ofIdx, setOfIdx] = React.useState(0);
  const [price, setPrice] = React.useState("");
  const [err, setErr] = React.useState("");
  const headingId = `${uid}-h`;

  React.useEffect(() => nameRef.current?.focus(), []);

  const count = Number(n);
  const countOk = Number.isInteger(count) && count >= 2;
  const canSubmit = name.trim() !== "" && countOk && !create.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setErr("");
    // A typed price is checked here, with the grid cell's own rule, so a bad one never creates a unit.
    const priceText = price.trim();
    const bad = validatePrice && priceText !== "" ? validatePrice(priceText) : null;
    if (bad) {
      setErr(bad);
      return;
    }
    const label = name.trim();
    create.mutate(
      { label, factorToBase: count * options[ofIdx].factorToBase },
      {
        onSuccess: (created: { id?: string } | undefined) =>
          onDone({ id: created?.id, label, price: priceText }),
        onError: (error) => setErr(orderErrorText(error)),
      },
    );
  };

  return (
    <form
      id="units-v2-add-panel"
      data-testid="units-v2-add-panel"
      aria-labelledby={headingId}
      onSubmit={submit}
      noValidate
      className="space-y-3 rounded-lg border border-surface-border bg-white p-4"
    >
      <div>
        <h3 id={headingId} className="text-sm font-semibold text-navy">
          Add a unit
        </h3>
        <p className="text-xs text-navy/70">Say what it contains. Its prices fill in as Auto.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor={`${uid}-name`}>
            Unit name
          </label>
          <input
            id={`${uid}-name`}
            ref={nameRef}
            data-testid="units-v2-add-name"
            className={FIELD}
            placeholder="e.g. Case"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`${uid}-n`}>
            Contains
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`${uid}-n`}
              data-testid="units-v2-add-n"
              className={FIELD}
              type="number"
              min={2}
              step={1}
              inputMode="numeric"
              placeholder="e.g. 12"
              value={n}
              onChange={(e) => setN(e.target.value)}
            />
            <span className="text-sm text-navy/70">of</span>
            <label className="sr-only" htmlFor={`${uid}-of`}>
              Which unit it contains
            </label>
            <select
              id={`${uid}-of`}
              data-testid="units-v2-add-of"
              className={`${FIELD} w-auto`}
              value={ofIdx}
              onChange={(e) => setOfIdx(Number(e.target.value))}
            >
              {options.map((o, i) => (
                <option key={`${o.label}-${i}`} value={i}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {validatePrice && (
        <div className="max-w-[12rem]">
          <label className={LABEL} htmlFor={`${uid}-price`}>
            Price (optional)
          </label>
          <input
            id={`${uid}-price`}
            data-testid="units-v2-add-price"
            className={FIELD}
            type="text"
            inputMode="decimal"
            placeholder="Auto"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
      )}
      <p
        id="units-v2-add-err"
        data-testid="units-v2-add-err"
        role="alert"
        hidden={!err}
        className="text-sm text-danger"
      >
        {err}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" data-testid="units-v2-add-submit" disabled={!canSubmit}>
          Add unit
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid="units-v2-add-cancel"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The one "Add a unit" control on the v2 prices surface (V15): a button that opens a panel. While the
 * panel is open the button is hidden; Cancel, Escape and a finished add all put focus back on it (V17).
 * Add writes straight through the existing units endpoint, so it waits while the price draft is dirty.
 */
export function AddUnitPanel({
  productId,
  baseLabel,
  ofUnits = [],
  dirty = false,
  disabled = false,
  validatePrice,
  onAdded,
}: {
  productId: string;
  /** The base unit's name (the smallest unit, e.g. "Piece"): always the first "of" choice. */
  baseLabel: string;
  /** The ladder's other units, offered after the base in "n of". */
  ofUnits?: AddUnitOf[];
  /** The price draft has unsaved changes: Add waits (shown with a hint). */
  dirty?: boolean;
  disabled?: boolean;
  /**
   * Adds an optional "Price (optional)" box. Return the message to refuse a typed price with, or null to accept it
   * (blank is always fine: Auto). The panel never writes the price: it hands the text to `onAdded`.
   */
  validatePrice?: (text: string) => string | null;
  onAdded?: (added: AddedUnit) => void;
}) {
  const { open, close, toggle, openerRef } = usePanelDisclosure();
  const hintId = React.useId();
  const blocked = dirty || disabled;

  // A draft that turns dirty (or any other block) while the panel is open closes it.
  React.useEffect(() => {
    if (blocked && open) close();
  }, [blocked, open, close]);

  return (
    <div className="space-y-2">
      <Button
        ref={openerRef}
        type="button"
        variant="secondary"
        data-testid="units-v2-add-open"
        aria-expanded={open}
        aria-controls="units-v2-add-panel"
        aria-describedby={dirty ? hintId : undefined}
        disabled={blocked}
        hidden={open}
        style={open ? { display: "none" } : undefined}
        onClick={toggle}
      >
        Add a unit
      </Button>
      {dirty && (
        <p id={hintId} className="text-xs text-navy/70">
          {DIRTY_HINT}
        </p>
      )}
      {open && !blocked && (
        <AddUnitForm
          productId={productId}
          baseLabel={baseLabel}
          ofUnits={ofUnits}
          validatePrice={validatePrice}
          onCancel={close}
          onDone={(added) => {
            close();
            onAdded?.(added);
          }}
        />
      )}
    </div>
  );
}
