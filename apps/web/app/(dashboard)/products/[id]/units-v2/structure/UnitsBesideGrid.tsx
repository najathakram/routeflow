"use client";

import * as React from "react";
import type { ProductUnitLevel } from "@routeflow/types";
import { unitWords } from "@routeflow/pricing";
import { Button, useToast } from "@routeflow/ui/web";
import { DecimalInput } from "@/components/MoneyInput";
import { useProductUnits, useUpdateProductUnit } from "@/lib/api/product-units";
import { unitNotListedNotice } from "@/lib/api/tenant-units";
import { usePriceDraft } from "../edit/usePriceDraft";
import { DIRTY_HINT } from "../units";
import { useDefaultOrderUnit } from "./useDefaultOrderUnit";

/**
 * The live controls the legacy Units & prices card used to carry, relocated next to the v2 grid so that card can be
 * read-only: the default order unit (a select, always visible) and each unit's Name and Contains (UnitDetailsEditor, grid edit mode only, below the grid).
 * Both write straight to the unit API, so both wait for Save or Discard while the price draft is dirty (same reason
 * as Remove). The smallest unit (contains 1) is not renamed or resized, as on the old card.
 */

const FIELD =
  "h-10 w-full rounded-md border border-surface-border bg-white px-2.5 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:opacity-60";
const LABEL = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-navy/60";

export function UnitsBesideGrid({ product }: { product: { id: string; unit?: string | null } }) {
  const draft = usePriceDraft();
  const list = useProductUnits(product.id, true);
  const units = React.useMemo(() => list.data ?? [], [list.data]);
  const packName = product.unit || unitWords().pack.one;
  const dflt = useDefaultOrderUnit(product.id, units, packName);
  const hintId = React.useId();
  const selectId = React.useId();
  const blocked = draft.dirty;
  if (units.length === 0) return null;
  const current = units.find((u) => u.isDefaultSelling)?.id ?? "";

  return (
    <div data-testid="units-v2-beside" className="mb-3 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem]">
          <label className={LABEL} htmlFor={selectId}>
            Default order unit
          </label>
          <select
            id={selectId}
            className={FIELD}
            value={current}
            disabled={blocked || dflt.pending}
            aria-describedby={blocked ? hintId : undefined}
            onChange={(e) => dflt.change(units.find((u) => u.id === e.target.value) ?? null)}
          >
            <option value="">{packName}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
        {dflt.note && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-navy">
            <p role="status" data-testid="units-v2-default-note">
              {dflt.note.text}
            </p>
            {dflt.note.undo && (
              <Button size="sm" variant="secondary" onClick={dflt.undo} disabled={dflt.pending}>
                Undo
              </Button>
            )}
            <button
              type="button"
              className="inline-flex min-h-11 items-center px-1 text-xs font-medium text-brand-600 underline"
              aria-label="Dismiss the default order unit message"
              onClick={dflt.dismiss}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
      {blocked && (
        <p id={hintId} className="text-xs text-navy/70" data-testid="units-v2-beside-hint">
          {DIRTY_HINT}
        </p>
      )}
    </div>
  );
}

/**
 * K13: each unit's Name and Contains, rendered BELOW the grid (after it, before the Save bar) while it is in edit
 * mode, so entering edit never pushes the grid's rows (or the focused first price box) down under the Save bar.
 */
export function UnitDetailsEditor({ product }: { product: { id: string } }) {
  const draft = usePriceDraft();
  const list = useProductUnits(product.id, true);
  const hintId = React.useId();
  const blocked = draft.dirty;
  const editable = (list.data ?? []).filter((u) => u.factorToBase !== 1);
  if (draft.editingIn !== "inline" || editable.length === 0) return null;
  return (
    <div data-testid="units-v2-details" className="mt-3 space-y-3">
      <ul className="space-y-2" data-testid="units-v2-beside-rows">
        {editable.map((u) => (
          <UnitNameRow
            key={u.id}
            productId={product.id}
            unit={u}
            blocked={blocked}
            hintId={hintId}
          />
        ))}
      </ul>
      {blocked && (
        <p id={hintId} className="text-xs text-navy/70" data-testid="units-v2-details-hint">
          {DIRTY_HINT}
        </p>
      )}
    </div>
  );
}

type Draft = { label: string; factor: number | null };

function UnitNameRow({
  productId,
  unit,
  blocked,
  hintId,
}: {
  productId: string;
  unit: ProductUnitLevel;
  blocked: boolean;
  hintId: string;
}) {
  const update = useUpdateProductUnit(productId);
  const { toast } = useToast();
  // Row 614: `update.isPending` is stale inside one tick; this ref is set on the trigger and released on settle.
  const saving = React.useRef(false);
  const w = unitWords();
  const base: Draft = { label: unit.label, factor: unit.factorToBase };
  const [draft, setDraft] = React.useState<Draft>(base);
  // Reset only when the SERVER values of this row change, so a refetch of equal data never wipes an edit.
  const baseKey = JSON.stringify(base);
  React.useEffect(() => setDraft(JSON.parse(baseKey) as Draft), [baseKey]);
  const dirty = draft.label !== base.label || draft.factor !== base.factor;
  const valid = draft.label.trim() !== "" && draft.factor != null && draft.factor >= 1;
  const idp = `beside-${unit.id}`;
  const desc = blocked ? hintId : undefined;
  return (
    <li
      className="rounded-lg border border-surface-border bg-white p-3"
      data-testid="units-v2-beside-row"
    >
      <h3 className="mb-2 text-sm font-semibold text-navy">{unit.label} size</h3>
      <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
        <div>
          <label className={LABEL} htmlFor={`${idp}-label`}>
            Name
          </label>
          <input
            id={`${idp}-label`}
            aria-label={`${unit.label} name`}
            aria-describedby={desc}
            className={FIELD}
            value={draft.label}
            disabled={blocked}
            maxLength={40}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`${idp}-factor`}>
            Contains
          </label>
          <div className="flex items-center gap-2">
            <DecimalInput
              id={`${idp}-factor`}
              aria-label={`${w.base.other} per ${unit.label}`}
              aria-describedby={desc}
              className={FIELD}
              decimals={0}
              min={1}
              value={draft.factor}
              disabled={blocked}
              onChange={(v) => setDraft({ ...draft, factor: v })}
            />
            <span className="shrink-0 text-sm text-navy/70">{w.base.other}</span>
          </div>
        </div>
        {dirty && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Cancel ${unit.label}`}
              onClick={() => setDraft(base)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              aria-label={`Save ${unit.label}`}
              disabled={blocked || update.isPending || !valid}
              onClick={() => {
                if (saving.current) return;
                saving.current = true;
                try {
                  update.mutate(
                    {
                      id: unit.id,
                      label: draft.label.trim(),
                      factorToBase: draft.factor ?? unit.factorToBase,
                    },
                    {
                      onSuccess: (saved) => {
                        // SA-810: the level saved, but its name was not added to the full unit list. Say so, once.
                        const notice = unitNotListedNotice(saved);
                        if (notice) toast({ title: notice, variant: "info" });
                      },
                      onSettled: () => {
                        saving.current = false;
                      },
                    },
                  );
                } catch (e) {
                  saving.current = false;
                  throw e;
                }
              }}
            >
              Save
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}
