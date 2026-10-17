"use client";

import * as React from "react";
import type { ProductPriceGridCellDto, ProductPriceGridRowDto } from "@routeflow/types";
import { MSRP_ADDON } from "@/lib/api/addons";
import { useHasAddon } from "@/lib/api/tobacco";
import { useTierLabels } from "@/lib/api/tier-labels";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { formatMoney } from "@/lib/format";
import { tierLabel } from "@/lib/tier-label";
import type { UnitsCardProduct } from "./ProductUnitsCard";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";
import type { GridEditApi } from "./units-v2/edit/edit-types";
import { ADD_UNIT_FIRST } from "./units-v2/edit/view-from-grid";

/**
 * The units v2 prices grid, READ ONLY: one row per unit, one column per price tier, values exactly
 * as the API gives them (no money math here, so no pricing package import; edit mode's price
 * consequences live in units-v2/edit). Phones get one
 * card per unit; wider screens get a table that scrolls in its own box with the Unit column pinned.
 */

const TIERS = [1, 2, 3, 4, 5] as const;

// V12: shared tokens only (PR #3499). --field is for CONTROL borders (the price inputs, the order-unit select);
// the grid frame, its cards and the save bar keep the surface line, and the row dividers --line-strong.
export const FIELD_BORDER = "border-field";
export const FRAME_BORDER = "border-surface-border";
const GRID_DIVIDER = "border-line-strong";

const plural = (label: string, n: number) =>
  n === 1 ? label : /(s|x|ch|sh)$/i.test(label) ? `${label}es` : `${label}s`;

/** "40 Boxes" and "= 960 Pieces in all", read from the rows' own factors and labels. */
function containsLines(row: ProductPriceGridRowDto, sorted: ProductPriceGridRowDto[]): string[] {
  if (row.kind === "base") return ["Smallest unit"];
  const base = sorted.find((r) => r.kind === "base");
  const lower = [...sorted].reverse().find((r) => r.factor < row.factor);
  const lines: string[] = [];
  if (lower && row.factor % lower.factor === 0) {
    const n = row.factor / lower.factor;
    lines.push(`${n} ${plural(lower.label, n)}`);
  }
  if (base && lower && lower.ref !== base.ref) {
    lines.push(`= ${row.factor} ${plural(base.label, row.factor)} in all`);
  } else if (base && !lower) {
    lines.push(`= ${row.factor} ${plural(base.label, row.factor)} in all`);
  }
  return lines;
}

interface CellView {
  tier: number;
  display: string;
  word: "Auto" | "Set" | null;
  aria: string;
}

function cellView(
  row: ProductPriceGridRowDto,
  tier: number,
  name: string,
  cell: ProductPriceGridCellDto | undefined,
): CellView {
  if (!cell) return { tier, display: "—", word: null, aria: `${name} ${row.label} price, none` };
  const noPrice = row.kind === "pack" && tier === 1 && Number(cell.value) === 0;
  const display = noPrice ? "No price" : formatMoney(cell.value);
  const word = noPrice ? null : cell.source === "set" ? "Set" : "Auto";
  return { tier, display, word, aria: `${name} ${row.label} price, ${display}` };
}

/** The text an input starts from: a typed (Set) price as the API gave it; Auto and No price start empty. */
const originalText = (cell: ProductPriceGridCellDto | undefined): string =>
  cell && cell.source === "set" && Number(cell.value) > 0 ? String(cell.value) : "";

interface EditTarget {
  edit: GridEditApi;
  ref: string;
  name: string;
  unit: string;
  layout: "table" | "card";
  original: string;
}

/** The price and its Auto/Set word. `dim` (edit mode, under the input) is the word alone, calmer (V16). */
function CellDisplay({ view, dim }: { view: CellView; dim?: boolean }) {
  return (
    <>
      {!dim && <div className="font-medium tabular-nums text-navy">{view.display}</div>}
      {view.word && (
        <div className={`text-[11px] ${dim ? "mt-0.5 text-navy/45" : "text-navy/60"}`}>
          {view.word}
        </div>
      )}
    </>
  );
}

/**
 * The "Add unit" control on this page, if there is one: the v2 shell's single "Add a unit" opener (K10d), else the old
 * Units card's name field. Opening the v2 panel puts focus in its name box.
 */
const addUnitTarget = (): HTMLElement | null =>
  typeof document === "undefined"
    ? null
    : (document.querySelector<HTMLElement>('[data-testid="units-v2-add-open"]') ??
      document.getElementById("new-unit-name"));

/** A pointer from a refused first price to the Add unit control: a button when the control exists, else nothing. */
function AddUnitPointer({ unit }: { unit: string }) {
  // Checked after paint: the v2 opener is a sibling of the grid, so it is not in the DOM yet while this renders.
  const [has, setHas] = React.useState(false);
  React.useEffect(() => setHas(addUnitTarget() != null), []);
  if (!has) return null;
  return (
    <button
      type="button"
      data-testid={T.addUnitPointer}
      className="mt-0.5 block underline"
      onClick={() => {
        const el = addUnitTarget();
        el?.scrollIntoView?.({ block: "center" });
        if (el?.dataset.testid === "units-v2-add-open") {
          // Waiting on unsaved prices disables it: scroll to it, its hint says why.
          if (!(el as HTMLButtonElement).disabled) el.click();
        } else el?.focus();
      }}
    >
      Add a {unit} unit
    </button>
  );
}

/** A family-governed row is read-only: say why, quietly. */
function NotEditable({ row }: { row: ProductPriceGridRowDto }) {
  if (row.editable || !row.notEditableReason) return null;
  return (
    <p data-testid={T.notEditable(row.ref)} className="mt-0.5 text-[11px] font-normal text-navy/55">
      {row.notEditableReason}
      {row.kind === "base" && ADD_UNIT_FIRST(row.notEditableReason) && (
        <AddUnitPointer unit={row.label} />
      )}
    </p>
  );
}

function CellInput({ t, tier, view }: { t: EditTarget; tier: number; view: CellView }) {
  const el = React.useRef<HTMLInputElement>(null);
  const { edit } = t;
  const want = edit.focus;
  React.useEffect(() => {
    if (want && want.ref === t.ref && want.tier === tier && want.layout === t.layout) {
      el.current?.focus({ preventScroll: true });
      edit.focused();
    }
  });
  const addUnit = edit.addUnitProblem(t.ref, tier);
  const problem = edit.problem(t.ref, tier) ?? addUnit;
  const pid = T.problem(t.layout, t.ref, tier);
  return (
    <>
      <input
        ref={el}
        type="text"
        inputMode="decimal"
        data-testid={T.input(t.ref, tier)}
        aria-label={`${t.name} ${t.unit} price`}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? pid : undefined}
        placeholder={view.display}
        value={edit.text(t.ref, tier, t.original)}
        onChange={(e) => edit.setText(t.ref, tier, e.target.value, t.original)}
        className={`h-9 w-24 rounded-md border bg-white px-2 text-sm tabular-nums text-navy focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 ${
          problem ? "border-red-600" : edit.changed(t.ref, tier) ? "border-brand-500" : FIELD_BORDER
        }`}
      />
      {problem && (
        <p id={pid} className="mt-1 max-w-[12rem] text-[11px] text-red-600">
          {problem}
          {addUnit && <AddUnitPointer unit={t.unit} />}
        </p>
      )}
    </>
  );
}

function PriceCell({
  view,
  testId,
  target,
}: {
  view: CellView;
  testId?: string;
  target?: EditTarget;
}) {
  const edit = target?.edit;
  return (
    <div data-testid={testId} aria-label={view.aria} role="group" className="leading-tight">
      {target && edit?.editing ? (
        <>
          <CellInput t={target} tier={view.tier} view={view} />
          <CellDisplay view={view} dim />
        </>
      ) : target && edit ? (
        <button
          type="button"
          aria-label={`Edit ${target.name} ${target.unit} price, ${view.display}`}
          onClick={() => edit.begin({ ref: target.ref, tier: view.tier, layout: target.layout })}
          className="-mx-1 cursor-text rounded px-1 text-left hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          <CellDisplay view={view} />
        </button>
      ) : (
        <CellDisplay view={view} />
      )}
    </div>
  );
}

export function ProductPricesGrid({
  product,
  edit,
  rowAction,
}: {
  product: UnitsCardProduct & { msrp?: number | string | null };
  /** Edit mode (S12a, behind flag.units_prices_v2). Omitted = today's read-only grid, unchanged. */
  edit?: GridEditApi;
  /** A control under a unit's name (K10d: Remove), or nothing for a row that has none. */
  rowAction?: (row: ProductPriceGridRowDto) => React.ReactNode;
}) {
  const grid = usePriceGrid(product.id);
  const labels = useTierLabels().data;
  const hasMsrp = useHasAddon(MSRP_ADDON);
  const showMsrp = product.msrp != null && product.msrp !== "" && hasMsrp;

  if (grid.isLoading) {
    return (
      <p role="status" className="text-sm text-navy/60">
        Loading prices…
      </p>
    );
  }
  if (grid.isError || !grid.data) {
    return <p className="text-sm text-red-600">Prices could not be loaded.</p>;
  }

  if (grid.data.rows.length === 0) {
    return <p className="text-sm text-navy/60">No units yet</p>;
  }

  const served = grid.data.rows;
  const rows = [...(edit?.rows ?? served)].sort((a, b) => b.factor - a.factor);
  const ascending = [...rows].reverse();
  const baseLabel = grid.data.rows.find((x) => x.kind === "base")?.label;
  const names = TIERS.map((t) => (t === 1 ? "Retail" : tierLabel(labels, t)));
  const targetFor = (
    row: ProductPriceGridRowDto,
    i: number,
    layout: "table" | "card",
  ): EditTarget | undefined => {
    if (!edit || !row.editable) return undefined;
    return {
      edit,
      ref: row.ref,
      name: names[i],
      unit: row.label,
      layout,
      original: originalText(
        served.find((r) => r.ref === row.ref)?.cells.find((c) => c.tier === TIERS[i]),
      ),
    };
  };

  return (
    <div
      data-testid={T.grid}
      className={`rounded-lg border bg-white p-4 ${FRAME_BORDER} ${edit?.editing ? "pb-6" : ""}`}
    >
      <h2
        id="units-v2-grid-title"
        data-testid={T.hUnits}
        className="mb-3 text-sm font-semibold text-navy"
      >
        Prices by unit
      </h2>

      <div
        role="region"
        data-testid={T.unitsTable}
        aria-labelledby="units-v2-grid-title"
        tabIndex={0}
        className="hidden overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 md:block"
      >
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr
              className={`border-b text-[11px] uppercase tracking-wide text-navy/60 ${GRID_DIVIDER}`}
            >
              <th scope="col" className="sticky left-0 z-10 bg-white px-2 py-2 font-medium">
                Unit
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Contains
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Barcode
              </th>
              {names.map((n, i) => (
                <th key={i} scope="col" className="px-2 py-2 font-medium">
                  {n}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.ref}
                data-testid={T.row(row.ref)}
                className={`border-b align-top last:border-b-0 ${GRID_DIVIDER}`}
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-white px-2 py-3 text-left font-medium text-navy"
                >
                  {row.label}
                  <NotEditable row={row} />
                  {rowAction?.(row)}
                </th>
                <td className="px-2 py-3 text-navy/80">
                  {containsLines(row, ascending).map((l) => (
                    <div key={l}>{l}</div>
                  ))}
                </td>
                <td className="px-2 py-3 text-navy/80">
                  <span data-testid={T.code(row.ref)}>{row.code ?? "No barcode"}</span>
                </td>
                {TIERS.map((t, i) => (
                  <td key={t} className="px-2 py-3">
                    <PriceCell
                      testId={T.cell(row.ref, t)}
                      target={targetFor(row, i, "table")}
                      view={cellView(
                        row,
                        t,
                        names[i],
                        row.cells.find((c) => c.tier === t),
                      )}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 md:hidden">
        {rows.map((row) => (
          <div
            key={row.ref}
            data-testid={T.card(row.ref)}
            className={`rounded-md border p-3 ${FRAME_BORDER}`}
          >
            <div className="font-medium text-navy">{row.label}</div>
            <NotEditable row={row} />
            {rowAction?.(row)}
            <div className="text-xs text-navy/70">
              {containsLines(row, ascending).map((l) => (
                <div key={l}>{l}</div>
              ))}
            </div>
            <div className="mb-2 text-xs text-navy/70">
              Barcode: <span data-testid={T.code(row.ref)}>{row.code ?? "No barcode"}</span>
            </div>
            <dl className="grid grid-cols-2 gap-2">
              {TIERS.map((t, i) => {
                const view = cellView(
                  row,
                  t,
                  names[i],
                  row.cells.find((c) => c.tier === t),
                );
                return (
                  <div key={t}>
                    <dt className="text-[11px] uppercase tracking-wide text-navy/60">{names[i]}</dt>
                    <dd>
                      <PriceCell
                        view={view}
                        testId={T.cell(row.ref, t)}
                        target={targetFor(row, i, "card")}
                      />
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>

      {showMsrp && (
        <p className="mt-3 text-xs text-navy/70">
          MSRP {formatMoney(product.msrp)}
          {baseLabel ? ` per ${baseLabel}` : ""}
        </p>
      )}
    </div>
  );
}
