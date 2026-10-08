"use client";

import * as React from "react";
import { resolveUnitPrice, type LadderProduct } from "@routeflow/pricing";
import { Button } from "@routeflow/ui/web";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DecimalInput } from "@/components/MoneyInput";
import { fmt } from "@/lib/formatting";
import { tierLabel } from "@/lib/tier-label";
import type { TenantUnitName } from "@/lib/api/product-units-ladder";
import {
  PIECE,
  baseWord,
  blankRow,
  isPackRow as isPackRowOf,
  norm,
  packRow,
  removeRowAndDescendants,
  resolveDraft,
  summaryText,
  unitNameError,
  unitsPerBoxText,
  type LadderDraft,
  type LadderRow,
  type MappedLadderError,
} from "@/lib/unit-ladder";
import { LEVEL_CODES_UI_ENABLED } from "./flags";
import { LevelCodesFields } from "./LevelCodesFields";

const FIELD =
  "h-10 w-full rounded-md border border-surface-border bg-white px-2.5 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";
const SELECT = `${FIELD} pr-7 max-md:h-11`;
const LABEL = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-navy/60";
const ADD_VALUE = "__add_new_unit__";
const plural = (w: string) => `${w}s`;

export interface LadderEditorHandle {
  /** Focus the first field with an error (call after a blocked Save). */
  focusFirstError: () => void;
}

export interface LadderEditorProps {
  value: LadderDraft;
  onChange: (next: LadderDraft) => void;
  tenantUnits: readonly TenantUnitName[];
  /** The price above the editor (the product's own price): the pack's price. */
  packPrice: number | null;
  tierNames?: Record<string, string>;
  /** Show every row's errors, not only the rows the owner has touched (set after a blocked Save). */
  showAllErrors?: boolean;
  /** A save failure to show under its row (status/code mapped by the caller). */
  serverError?: MappedLadderError | null;
  onDismissServerError?: () => void;
  /** The word typed in the create modal's own pack field, to refuse a pack named like the smallest unit. */
  packWord?: string;
  idPrefix?: string;
}

/** Native `<select>` plus the "Add new unit..." flow. The select itself is never replaced for long: Cancel/Add return to it. */
function UnitSelect({
  id,
  label,
  value,
  options,
  onPick,
  onAddNew,
  takenNames,
  invalid,
  describedBy,
  selectRef,
  newNames,
}: {
  id: string;
  label: string;
  value: string;
  /** Names to offer, in order. A name in `archivedNames` shows "(archived)". */
  options: Array<{ name: string; archived?: boolean }>;
  onPick: (name: string) => void;
  onAddNew: (name: string) => void;
  takenNames: string[];
  invalid?: boolean;
  describedBy?: string;
  selectRef?: (el: HTMLSelectElement | null) => void;
  newNames: readonly string[];
}) {
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const localRef = React.useRef<HTMLSelectElement | null>(null);
  const focusSelect = () => requestAnimationFrame(() => localRef.current?.focus());
  const optionNames = options.map((o) => o.name);
  const ensure =
    value && !optionNames.some((n) => norm(n) === norm(value)) ? [{ name: value }] : [];
  const all = [...options, ...ensure];

  if (adding) {
    const commit = () => {
      const err = unitNameError(name, takenNames);
      if (err) return setError(err);
      onAddNew(name.trim());
      setAdding(false);
      setName("");
      setError(null);
      focusSelect();
    };
    return (
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <input
            autoFocus
            aria-label={`${label}: new unit name`}
            className={FIELD}
            value={name}
            maxLength={60}
            aria-invalid={error != null}
            onChange={(e) => (setName(e.target.value), setError(null))}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), commit());
              if (e.key === "Escape") {
                setAdding(false);
                setError(null);
                focusSelect();
              }
            }}
          />
          {error && (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {error}
            </p>
          )}
        </div>
        <Button size="sm" type="button" onClick={commit}>
          Add
        </Button>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            setAdding(false);
            setName("");
            setError(null);
            focusSelect();
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <select
      id={id}
      ref={(el) => {
        localRef.current = el;
        selectRef?.(el);
      }}
      aria-label={label}
      className={SELECT}
      value={value}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      title={value}
      onChange={(e) => {
        if (e.target.value === ADD_VALUE) {
          setAdding(true);
          return;
        }
        onPick(e.target.value);
      }}
    >
      {!value && <option value="">Pick a unit</option>}
      {all.map((o) => {
        const isNew = newNames.some((n) => norm(n) === norm(o.name));
        const archived = "archived" in o && o.archived;
        return (
          <option key={o.name} value={o.name}>
            {o.name}
            {isNew ? " (new)" : archived ? " (archived)" : ""}
          </option>
        );
      })}
      <option value={ADD_VALUE}>Add new unit...</option>
    </select>
  );
}

/** Rename `from` to `to` everywhere a draft refers to a unit by name (children, base, pack, new units). */
function renameEverywhere(d: LadderDraft, from: string, to: string): LadderDraft {
  const same = (s: string) => norm(s) === norm(from);
  return {
    ...d,
    rows: d.rows.map((r) => (same(r.parentLabel) ? { ...r, parentLabel: to } : r)),
    packLevel: d.packLevel && same(d.packLevel) ? to : d.packLevel,
  };
}

export const LadderEditor = React.forwardRef<LadderEditorHandle, LadderEditorProps>(
  function LadderEditor(
    {
      value: draft,
      onChange,
      tenantUnits,
      packPrice,
      tierNames,
      showAllErrors,
      serverError,
      onDismissServerError,
      packWord,
      idPrefix = "ladder",
    },
    ref,
  ) {
    const base = baseWord(draft);
    const resolved = React.useMemo(() => resolveDraft(draft, { packWord }), [draft, packWord]);
    const [touched, setTouched] = React.useState<Set<string>>(() => new Set());
    const touch = (key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key)));
    const [focusKey, setFocusKey] = React.useState<string | null>(null);
    const [removing, setRemoving] = React.useState<LadderRow | null>(null);
    const fieldRefs = React.useRef<Record<string, HTMLElement | null>>({});
    const setRef = (k: string) => (el: HTMLElement | null) => {
      fieldRefs.current[k] = el;
    };

    React.useEffect(() => {
      if (!focusKey) return;
      fieldRefs.current[`${focusKey}:n`]?.focus();
      setFocusKey(null);
    }, [focusKey]);

    React.useImperativeHandle(ref, () => ({
      focusFirstError: () => {
        const row = draft.rows.find((r) => resolved.errors.has(r.key));
        if (!row) return;
        const err = resolved.errors.get(row.key);
        const target =
          err?.field === "perParent" || err?.field === "size" ? `${row.key}:n` : `${row.key}:right`;
        fieldRefs.current[target]?.focus();
      },
    }));

    const activeNames = tenantUnits.filter((u) => !u.archived).map((u) => u.name);
    const archivedNames = tenantUnits.filter((u) => u.archived).map((u) => u.name);
    const allKnown = [...tenantUnits.map((u) => u.name), ...draft.newUnits];
    const ladderLabels = draft.rows.map((r) => r.label.trim()).filter(Boolean);
    const inLadder = (n: string) => ladderLabels.some((l) => norm(l) === norm(n));
    const isArchived = (n: string) => archivedNames.some((a) => norm(a) === norm(n));
    const candidates = (extra: string[] = []) => {
      const seen = new Set<string>();
      const out: Array<{ name: string; archived?: boolean }> = [];
      for (const n of [...activeNames, ...draft.newUnits, ...extra]) {
        if (!n || seen.has(norm(n))) continue;
        seen.add(norm(n));
        out.push({ name: n, archived: isArchived(n) });
      }
      return out;
    };

    const addNewUnit = (name: string) =>
      onChange({
        ...draft,
        newUnits: draft.newUnits.some((n) => norm(n) === norm(name))
          ? draft.newUnits
          : [...draft.newUnits, name],
      });

    // ── base ──
    const baseOptions = (() => {
      const rest = candidates().filter((o) => norm(o.name) !== norm(PIECE));
      return [{ name: PIECE }, ...rest];
    })();
    const setBase = (name: string) => {
      const from = base;
      const to = norm(name) === norm(PIECE) ? "" : name;
      const next = renameEverywhere(draft, from, to || PIECE);
      onChange({ ...next, baseLabel: to });
    };

    // ── rows ──
    const patchRow = (key: string, patch: Partial<LadderRow>) =>
      onChange({ ...draft, rows: draft.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });

    const addRow = () => {
      const last = draft.rows[draft.rows.length - 1];
      const left = last?.label.trim() || base;
      const row = blankRow("", left);
      onChange({ ...draft, rows: [...draft.rows, row] });
      setFocusKey(row.key);
    };

    const pickRight = (row: LadderRow, name: string) => {
      const next = renameEverywhere(draft, row.label, name);
      onChange({
        ...next,
        rows: next.rows.map((r) => (r.key === row.key ? { ...r, label: name } : r)),
      });
    };
    const addRight = (row: LadderRow, name: string) => {
      const withNew = {
        ...draft,
        newUnits: draft.newUnits.some((n) => norm(n) === norm(name))
          ? draft.newUnits
          : [...draft.newUnits, name],
      };
      const next = renameEverywhere(withNew, row.label, name);
      onChange({
        ...next,
        rows: next.rows.map((r) => (r.key === row.key ? { ...r, label: name } : r)),
      });
    };

    const doRemove = (row: LadderRow) => {
      const rows = removeRowAndDescendants(draft.rows, row.key);
      const gone = new Set(draft.rows.filter((r) => !rows.includes(r)).map((r) => norm(r.label)));
      onChange({
        ...draft,
        rows,
        packLevel: draft.packLevel && gone.has(norm(draft.packLevel)) ? null : draft.packLevel,
      });
    };

    // ── prices ──
    const pack = packRow(draft);
    const packFactor = pack ? (resolved.factors.get(pack.key) ?? 1) : 1;
    const priced = draft.rows.filter((r) => !isPackRowOf(draft, r) && resolved.factors.has(r.key));
    const ladderProduct: LadderProduct = {
      unit: pack?.label.trim() || "Box",
      unitsPerBox: packFactor > 1 ? packFactor : null,
      pricePerUnit: packPrice ?? 0,
    };
    const asUnits = (skip?: { key: string; prices: Array<number | null> }) => [
      ...(draft.basePrice || draft.baseTiers.some(Boolean)
        ? [
            {
              label: PIECE,
              factorToBase: 1,
              price: draft.basePrice || null,
              priceTier2: draft.baseTiers[0] || null,
              priceTier3: draft.baseTiers[1] || null,
              priceTier4: draft.baseTiers[2] || null,
              priceTier5: draft.baseTiers[3] || null,
            },
          ]
        : []),
      ...priced.map((r) => ({
        label: r.label.trim(),
        factorToBase: resolved.factors.get(r.key) as number,
        price: skip?.key === r.key ? null : r.price || null,
        priceTier2: r.tiers[0] || null,
        priceTier3: r.tiers[1] || null,
        priceTier4: r.tiers[2] || null,
        priceTier5: r.tiers[3] || null,
      })),
    ];
    // Grey = what the unit would price at with its own field blank (never previews the figure being typed).
    const derived = (label: string, tier: number): number | null => {
      if (packPrice == null || packPrice <= 0) return null;
      try {
        const units = asUnits().map((u) => {
          if (norm(u.label) !== norm(label)) return u;
          const k = (["price", "priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const)[
            tier - 1
          ];
          return { ...u, [k]: null };
        });
        return resolveUnitPrice(ladderProduct, units, label, tier);
      } catch {
        return null;
      }
    };
    const num = (t: string) => (t.trim() === "" || !Number.isFinite(Number(t)) ? null : Number(t));
    const packWordText = pack?.label.trim() || null;

    const errorFor = (row: LadderRow) =>
      showAllErrors || touched.has(row.key) ? resolved.errors.get(row.key) : undefined;
    const serverFor = (row: LadderRow) =>
      serverError && serverError.rowLabel && norm(serverError.rowLabel) === norm(row.label)
        ? serverError
        : null;

    const summary = summaryText(draft, resolved);
    const pieceInfo = unitsPerBoxText(draft, resolved);
    void pieceInfo;

    const unitsList: Array<{ key: string; name: string; holds: string; row?: LadderRow }> = [
      { key: "base", name: base, holds: `1 ${base}` },
      ...draft.rows
        .filter((r) => resolved.factors.has(r.key) && r.label.trim())
        .map((r) => {
          const f = resolved.factors.get(r.key) as number;
          return {
            key: r.key,
            name: r.label.trim(),
            holds: `${f.toLocaleString("en-US")} ${plural(base)}`,
            row: r,
          };
        }),
    ];
    const noRowDefault =
      !draft.baseIsDefault && !draft.rows.some((r) => r.isDefault && !isPackRowOf(draft, r));

    return (
      <div role="group" aria-label="How is this sold?" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-navy">How is this sold?</h4>
          <a
            href="/settings/units"
            target="_blank"
            rel="noopener"
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            Manage units
          </a>
        </div>

        <div>
          <label className={LABEL} htmlFor={`${idPrefix}-base`}>
            Smallest unit
          </label>
          <div className="max-w-xs">
            <UnitSelect
              id={`${idPrefix}-base`}
              label="Smallest unit"
              value={base}
              options={baseOptions}
              onPick={setBase}
              onAddNew={(n) => {
                const withNew = {
                  ...draft,
                  newUnits: draft.newUnits.some((x) => norm(x) === norm(n))
                    ? draft.newUnits
                    : [...draft.newUnits, n],
                };
                const next = renameEverywhere(withNew, base, n);
                onChange({ ...next, baseLabel: n });
              }}
              takenNames={allKnown}
              newNames={draft.newUnits}
            />
          </div>
          <p className="mt-1 text-xs text-navy/60">What one item is called, like Bottle or Can.</p>
        </div>

        <div className="space-y-2 rounded-lg border border-surface-border bg-surface-raised p-3">
          {draft.rows.map((row, i) => {
            const err = errorFor(row);
            const srv = serverFor(row);
            const lefts = [
              base,
              ...draft.rows
                .slice(0, i)
                .map((r) => r.label.trim())
                .filter(Boolean),
            ];
            const leftValue = row.parentLabel.trim() || base;
            const rightOptions = candidates([row.label].filter(Boolean)).filter(
              (o) =>
                norm(o.name) !== norm(base) &&
                (!inLadder(o.name) || norm(o.name) === norm(row.label)),
            );
            const errId = `${idPrefix}-${row.key}-err`;
            const left = leftValue;
            const right = row.label.trim() || "unit";
            return (
              <div
                key={row.key}
                role="group"
                aria-label={`Level ${i + 1}`}
                className="rounded-md border border-surface-border bg-white p-2 transition-all duration-[160ms] ease-out motion-reduce:transition-none md:flex md:flex-wrap md:items-start md:gap-2 md:border-0 md:bg-transparent md:p-0"
              >
                <div className="flex flex-wrap items-center gap-2 max-md:mb-2">
                  <input
                    ref={setRef(`${row.key}:n`)}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    aria-label={`How many ${plural(left)} in one ${right}`}
                    aria-invalid={err?.field === "perParent" || err?.field === "size"}
                    aria-describedby={err ? errId : undefined}
                    className={`${FIELD} w-20 max-md:h-11`}
                    value={row.perParent}
                    onChange={(e) => (
                      touch(row.key),
                      patchRow(row.key, { perParent: e.target.value.replace(/[^0-9]/g, "") })
                    )}
                  />
                  <div className="min-w-0 w-40 max-md:flex-1">
                    <select
                      aria-label={`Level ${i + 1} made of`}
                      title={leftValue}
                      className={SELECT}
                      value={leftValue}
                      onChange={(e) => (
                        touch(row.key),
                        patchRow(row.key, { parentLabel: e.target.value })
                      )}
                    >
                      {lefts.map((l, idx) => (
                        <option key={`${l}-${idx}`} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-navy/70">= 1</span>
                  <div className="min-w-0 w-44 max-md:flex-1">
                    <UnitSelect
                      id={`${idPrefix}-${row.key}-right`}
                      label={`Level ${i + 1} unit`}
                      value={row.label}
                      options={rightOptions}
                      onPick={(n) => (touch(row.key), pickRight(row, n))}
                      onAddNew={(n) => (touch(row.key), addRight(row, n))}
                      takenNames={allKnown}
                      newNames={draft.newUnits}
                      invalid={err?.field === "label"}
                      describedBy={err ? errId : undefined}
                      selectRef={setRef(`${row.key}:right`)}
                    />
                  </div>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    className="max-md:min-h-[44px]"
                    onClick={() => (row.id ? setRemoving(row) : doRemove(row))}
                  >
                    Remove
                  </Button>
                </div>
                {(err || srv) && (
                  <div className="w-full">
                    {err && (
                      <p id={errId} role="alert" className="mt-1 text-xs text-red-600">
                        {err.message}
                      </p>
                    )}
                    {srv && (
                      <div className="mt-1 text-xs text-red-600">
                        <p role="alert">{srv.message}</p>
                        {srv.offerNewUnit && (
                          <Button
                            size="sm"
                            type="button"
                            variant="secondary"
                            className="mt-1"
                            onClick={() => {
                              patchRow(row.key, { label: "" });
                              onDismissServerError?.();
                              setFocusKey(null);
                              requestAnimationFrame(() =>
                                fieldRefs.current[`${row.key}:right`]?.focus(),
                              );
                            }}
                          >
                            Add a new unit instead
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {isPackRowOf(draft, row) && (
                  <p className="w-full text-xs text-navy/60">
                    Barcode and SKU: set in &quot;{row.label.trim()} code&quot; above.
                  </p>
                )}
                {LEVEL_CODES_UI_ENABLED && !isPackRowOf(draft, row) && (
                  <div className="w-full">
                    <LevelCodesFields
                      row={row}
                      fallbackName={base}
                      packName={packWordText ?? undefined}
                      idPrefix={`${idPrefix}-${row.key}`}
                      serverError={
                        srv && (srv.field === "sku" || srv.field === "barcode")
                          ? { field: srv.field, message: srv.message }
                          : null
                      }
                      onChange={(patch) => patchRow(row.key, patch)}
                    />
                  </div>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="min-h-[44px] text-sm font-medium text-brand-600 md:min-h-0"
            onClick={addRow}
          >
            + Add a bigger unit
          </button>
        </div>

        <p
          role="status"
          className="min-h-[1.25rem] text-sm font-medium text-navy max-md:sticky max-md:top-0 max-md:bg-white max-md:py-1"
        >
          {summary}
        </p>

        {draft.rows.length > 0 && (
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-pack`}>
              Price is for one
            </label>
            <div className="max-w-xs">
              <select
                id={`${idPrefix}-pack`}
                className={SELECT}
                value={draft.packLevel ?? ""}
                onChange={(e) => onChange({ ...draft, packLevel: e.target.value || null })}
              >
                <option value="">{base}</option>
                {draft.rows
                  .filter((r) => r.label.trim() && resolved.factors.has(r.key))
                  .map((r) => (
                    <option key={r.key} value={r.label.trim()}>
                      {r.label.trim()}
                    </option>
                  ))}
              </select>
            </div>
            <p className="mt-1 text-xs text-navy/60">
              The price above is for one {packWordText ?? base}. Other units are worked out from it.
            </p>
          </div>
        )}

        {unitsList.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-surface-border">
            <ul className="min-w-0 divide-y divide-surface-border md:min-w-[560px]">
              <li className="hidden grid-cols-[1.2fr_1.2fr_1fr_1fr_1.4fr] gap-3 bg-surface-raised px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-navy/60 md:grid">
                <span>Unit</span>
                <span>Holds</span>
                <span>Price</span>
                <span>Tier prices</span>
                <span>Pre-selected on staff orders</span>
              </li>
              {unitsList.map((u) => {
                const isBase = u.key === "base";
                const isPackRow = u.row != null && isPackRowOf(draft, u.row);
                const priceText = isBase ? draft.basePrice : (u.row?.price ?? "");
                const tiers = isBase ? draft.baseTiers : (u.row?.tiers ?? ["", "", "", ""]);
                const grey = derived(isBase ? PIECE : u.name, 1);
                const checked = isBase
                  ? draft.baseIsDefault
                  : isPackRow
                    ? noRowDefault
                    : (u.row?.isDefault ?? false);
                const setPrice = (v: number | null) =>
                  isBase
                    ? onChange({ ...draft, basePrice: v == null ? "" : String(v) })
                    : patchRow(u.key, { price: v == null ? "" : String(v) });
                const setTier = (i: number, v: number | null) => {
                  const t = [...tiers] as [string, string, string, string];
                  t[i] = v == null ? "" : String(v);
                  if (isBase) onChange({ ...draft, baseTiers: t });
                  else patchRow(u.key, { tiers: t });
                };
                return (
                  <li
                    key={u.key}
                    data-testid="ladder-price-row"
                    className="grid grid-cols-2 gap-3 px-3 py-3 md:grid-cols-[1.2fr_1.2fr_1fr_1fr_1.4fr] md:items-center"
                  >
                    <span className="truncate font-medium text-navy" title={u.name}>
                      {u.name}
                    </span>
                    <span className="truncate text-sm text-navy/70" title={u.holds}>
                      {u.holds}
                    </span>
                    <div className="col-span-2 md:col-span-1">
                      {isPackRow ? (
                        <span className="font-mono text-sm tabular-nums text-navy">
                          {packPrice != null ? fmt(packPrice) : ""}
                        </span>
                      ) : (
                        <DecimalInput
                          aria-label={`${u.name} price`}
                          className={`${FIELD} max-md:h-11`}
                          value={num(priceText)}
                          placeholder={grey != null ? fmt(grey) : ""}
                          onChange={setPrice}
                        />
                      )}
                    </div>
                    <details className="col-span-2 md:col-span-1">
                      <summary className="cursor-pointer text-xs font-medium text-brand-600">
                        Tier prices
                      </summary>
                      {isPackRow ? (
                        <p className="mt-1 text-xs text-navy/60">
                          Edit these with the pack price above.
                        </p>
                      ) : (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          {[2, 3, 4, 5].map((t) => {
                            const d = derived(isBase ? PIECE : u.name, t);
                            return (
                              <div key={t}>
                                <label className={LABEL}>{tierLabel(tierNames, t)}</label>
                                <DecimalInput
                                  aria-label={`${u.name} ${tierLabel(tierNames, t)} price`}
                                  className={`${FIELD} max-md:h-11`}
                                  value={num(tiers[t - 2])}
                                  placeholder={d != null ? fmt(d) : ""}
                                  onChange={(v) => setTier(t - 2, v)}
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </details>
                    <label className="col-span-2 flex items-center gap-2 text-sm text-navy md:col-span-1">
                      <input
                        type="radio"
                        name={`${idPrefix}-default-selling-unit`}
                        checked={checked}
                        onChange={() => {
                          if (isBase) {
                            onChange({
                              ...draft,
                              baseIsDefault: true,
                              rows: draft.rows.map((r) => ({ ...r, isDefault: false })),
                            });
                          } else {
                            onChange({
                              ...draft,
                              baseIsDefault: false,
                              rows: draft.rows.map((r) => ({
                                ...r,
                                isDefault: !isPackRow && r.key === u.key,
                              })),
                            });
                          }
                        }}
                      />
                      <span className="md:sr-only">Pre-selected on staff orders</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="border-t border-surface-border px-3 py-2 text-xs text-navy/60">
              A grey price is worked out from the {packWordText ?? base} price. Type a price to use
              your own.
            </p>
          </div>
        )}

        <ConfirmDialog
          open={removing != null}
          onClose={() => setRemoving(null)}
          title={`Remove ${removing?.label ?? "unit"}?`}
          description={`Its prices are deleted. Existing orders and invoices keep what they charged.${LEVEL_CODES_UI_ENABLED ? " Its barcode and SKU are removed too." : ""}`}
          confirmLabel="Remove"
          onConfirm={() => {
            if (removing) doRemove(removing);
            setRemoving(null);
          }}
        />
      </div>
    );
  },
);
