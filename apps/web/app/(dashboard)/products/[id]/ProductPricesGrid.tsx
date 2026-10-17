"use client";

import * as React from "react";
import type { ProductPriceGridCellDto, ProductPriceGridRowDto } from "@routeflow/types";
import { MSRP_ADDON } from "@/lib/api/addons";
import { useHasAddon } from "@/lib/api/tobacco";
import { useTierLabels } from "@/lib/api/tier-labels";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { formatMoney } from "@/lib/format";
import { productTierLabel } from "@/lib/tier-one-label";
import type { UnitsCardProduct } from "./ProductUnitsCard";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";
import type { GridEditApi } from "./units-v2/edit/edit-types";
import { useAddUnitIntent, type AddUnitIntent } from "./units-v2/edit/add-unit-intent";
import { canonicalPriceText } from "./units-v2/edit/price-text";
import { revealClearOfBar } from "./units-v2/edit/reveal-clear-of-bar";
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
// K11-10: the pinned Unit column. Bounded, so a long reason cannot widen it; a hairline shows while the table is scrolled.
const UNIT_CELL =
  "sticky left-0 z-10 min-w-[7rem] max-w-[10rem] whitespace-normal bg-white px-2 text-left group-data-[scrolled=true]:shadow-[inset_-1px_0_0_rgba(15,23,42,0.15)]";

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

/**
 * K11-11: the implicit base row of a product whose smallest unit does not exist yet. The grid still serves it a ladder
 * ("Piece $1.50 Auto"), but nothing backs it, so no price may be shown for it.
 */
const isMissingUnit = (row: ProductPriceGridRowDto): boolean =>
  row.kind === "base" && !row.editable && ADD_UNIT_FIRST(row.notEditableReason);

function cellView(
  row: ProductPriceGridRowDto,
  tier: number,
  name: string,
  cell: ProductPriceGridCellDto | undefined,
): CellView {
  if (isMissingUnit(row))
    return { tier, display: "—", word: null, aria: `${name} ${row.label} price, no unit yet` };
  if (!cell) return { tier, display: "—", word: null, aria: `${name} ${row.label} price, none` };
  const noPrice = row.kind === "pack" && tier === 1 && Number(cell.value) === 0;
  const display = noPrice ? "No price" : formatMoney(cell.value);
  const word = noPrice ? null : cell.source === "set" ? "Set" : "Auto";
  return { tier, display, word, aria: `${name} ${row.label} price, ${display}` };
}

/** The text an input starts from: a typed (Set) price in its money text ("30.00"); Auto and No price start empty. */
const originalText = (cell: ProductPriceGridCellDto | undefined): string =>
  cell && cell.source === "set" && Number(cell.value) > 0
    ? canonicalPriceText(String(cell.value))
    : "";

interface EditTarget {
  edit: GridEditApi;
  ref: string;
  name: string;
  unit: string;
  layout: "table" | "card";
  original: string;
}

/**
 * The price and its Auto/Set word. `dim` (edit mode, under the input) is the word alone, calmer (V16), and K11-14 says
 * "Set" only: an Auto box already shows its value as the grey placeholder, so its "Auto" is left to screen readers
 * (`wordId` is what the input's aria-describedby points at).
 */
function CellDisplay({ view, dim, wordId }: { view: CellView; dim?: boolean; wordId?: string }) {
  return (
    <>
      {!dim && <div className="font-medium tabular-nums text-navy">{view.display}</div>}
      {view.word && !(dim && view.word === "Auto") && (
        <div className={`text-[11px] ${dim ? "mt-0.5 text-navy/45" : "text-navy/60"}`}>
          {view.word}
        </div>
      )}
      {dim && view.word === "Auto" && (
        <span id={wordId} className="sr-only">
          Auto
        </span>
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

/**
 * Open the Add a unit panel (K11-11): never toggle it shut. A panel that is already open keeps its form and takes
 * focus in its first field; a closed one opens, as the Piece when `asPiece` and the shell shares an intent flag.
 */
function openAddUnit(intent: AddUnitIntent | null, asPiece: boolean) {
  const el = addUnitTarget();
  if (!el) return;
  if (el.dataset.testid !== "units-v2-add-open") {
    el.scrollIntoView?.({ block: "center" });
    el.focus();
    return;
  }
  const opener = el as HTMLButtonElement;
  if (opener.getAttribute("aria-expanded") === "true") {
    const panel = document.getElementById("units-v2-add-panel");
    panel?.scrollIntoView?.({ block: "center" });
    panel?.querySelector<HTMLElement>("input")?.focus();
    return;
  }
  opener.scrollIntoView?.({ block: "center" });
  // Waiting on unsaved prices disables it: scrolled to, its hint says why.
  if (opener.disabled) return;
  if (intent) intent.current = asPiece;
  try {
    opener.click();
  } finally {
    if (intent) intent.current = false;
  }
}

/**
 * A pointer from a missing unit (or a refused first price) to the Add unit control: nothing when the control does not
 * exist. `button` is the missing unit's row head, a real secondary button; the inline form sits in a refusal message.
 */
function AddUnitPointer({ unit, button = false }: { unit: string; button?: boolean }) {
  // Checked after paint: the v2 opener is a sibling of the grid, so it is not in the DOM yet while this renders.
  const [has, setHas] = React.useState(false);
  React.useEffect(() => setHas(addUnitTarget() != null), []);
  const intent = useAddUnitIntent();
  if (!has) return null;
  return (
    <button
      type="button"
      data-testid={T.addUnitPointer}
      className={
        button
          ? "mt-1 block h-8 rounded-md border border-line-strong bg-white px-2.5 text-xs font-medium text-navy hover:bg-surface-muted"
          : "mt-0.5 block underline"
      }
      onClick={() => openAddUnit(intent, true)}
    >
      {button ? `Add ${unit} unit` : `Add a ${unit} unit`}
    </button>
  );
}

/** A family-governed row is read-only: say why, quietly. */
function NotEditable({ row }: { row: ProductPriceGridRowDto }) {
  if (row.editable || !row.notEditableReason) return null;
  return (
    <p data-testid={T.notEditable(row.ref)} className="mt-0.5 text-[11px] font-normal text-navy/55">
      {row.notEditableReason}
      {isMissingUnit(row) && <AddUnitPointer unit={row.label} button />}
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
      // K11-13: then bring it clear of the save bar, once the bar has measured itself.
      revealClearOfBar(el.current);
      edit.focused();
    }
  });
  const addUnit = edit.addUnitProblem(t.ref, tier);
  const problem = edit.problem(t.ref, tier) ?? addUnit;
  const pid = T.problem(t.layout, t.ref, tier);
  // K11-14: an Auto box's "Auto" is not drawn under it, so the input is described by the hidden word instead.
  const describedBy =
    [problem ? pid : null, view.word === "Auto" ? T.word(t.layout, t.ref, tier) : null]
      .filter(Boolean)
      .join(" ") || undefined;
  // K11-12: the text the box held when it took focus (Escape puts it back), and whether focus is in it. While it is
  // not, a price shows in its money text, so a value a plan drafted ("1.4") reads "1.40" too.
  const atFocus = React.useRef<string | null>(null);
  const justFocused = React.useRef(false);
  const [inside, setInside] = React.useState(false);
  const text = edit.text(t.ref, tier, t.original);
  return (
    <>
      <span className="relative block w-fit">
        <span
          aria-hidden="true"
          data-testid={T.inputPrefix(t.ref, tier, t.layout)}
          className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-sm text-navy/50"
        >
          $
        </span>
        <input
          ref={el}
          type="text"
          inputMode="decimal"
          data-testid={T.input(t.ref, tier)}
          aria-label={`${t.name} ${t.unit} price`}
          aria-invalid={problem ? true : undefined}
          aria-describedby={describedBy}
          placeholder={view.display}
          value={inside ? text : canonicalPriceText(text)}
          onFocus={(e) => {
            atFocus.current = text;
            justFocused.current = true;
            setInside(true);
            e.currentTarget.select();
          }}
          onMouseUp={(e) => {
            // The click that gave the box focus must not collapse the selection the focus made (Safari does).
            if (justFocused.current) e.preventDefault();
            justFocused.current = false;
          }}
          onBlur={() => {
            justFocused.current = false;
            setInside(false);
            // A price the user typed settles to its money text; one equal to the saved price is then no change at all.
            // (Not while the server's "add the unit first" refusal of this very text is showing: its pointer is what
            // the user is about to click, and rewriting the text would take it away.)
            if (atFocus.current !== null && text !== atFocus.current && !addUnit) {
              const settled = canonicalPriceText(text);
              if (settled !== text) edit.setText(t.ref, tier, settled, t.original);
            }
            atFocus.current = null;
          }}
          onKeyDown={(e) => {
            // Escape puts the box back to what it held on focus; with nothing to put back it goes on to the page.
            if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
            if (atFocus.current === null || text === atFocus.current) return;
            e.preventDefault();
            e.stopPropagation();
            edit.setText(t.ref, tier, atFocus.current, t.original);
          }}
          onChange={(e) => edit.setText(t.ref, tier, e.target.value, t.original)}
          className={`h-9 w-[5.5rem] rounded-md border bg-white pl-[1.125rem] pr-1.5 text-sm tabular-nums text-navy focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 ${
            problem
              ? "border-red-600"
              : edit.changed(t.ref, tier)
                ? "border-brand-500"
                : FIELD_BORDER
          }`}
        />
      </span>
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
          <CellDisplay view={view} dim wordId={T.word(target.layout, target.ref, view.tier)} />
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

/** "Tier 4", "Tier 4 and Tier 5", "A, B and C". */
const joinNames = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * K11-10: the table's scroll box. Wherever it is narrower than its table, a fade on its right edge and a line under it
 * name the tiers that are actually cut off (an IntersectionObserver on the tier headers, rooted at the box, so the
 * names are never hard-coded and the line goes away once the end is in view). The pinned Unit column gets a divider
 * while the box is scrolled.
 */
function ScrollRegion({ names, children }: { names: string[]; children: React.ReactNode }) {
  const region = React.useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = React.useState<number[]>([]);
  const [scrolled, setScrolled] = React.useState(false);
  React.useEffect(() => {
    const root = region.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const cut = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const tier = Number((e.target as HTMLElement).dataset.tierHead);
          const edge = e.rootBounds?.right ?? Infinity;
          // Cut off on the RIGHT only: a header scrolled out on the left is not "more to scroll for".
          if (e.intersectionRatio < 0.98 && e.boundingClientRect.right > edge + 0.5) cut.add(tier);
          else cut.delete(tier);
        }
        setClipped([...cut].sort((a, b) => a - b));
      },
      { root, threshold: [0, 0.5, 0.98, 1] },
    );
    root.querySelectorAll("th[data-tier-head]").forEach((th) => observer.observe(th));
    return () => observer.disconnect();
  }, []);
  const hidden = clipped.map((t) => names[t - 1]);
  return (
    <div className="hidden md:block">
      <div className="relative">
        <div
          ref={region}
          role="region"
          data-testid={T.unitsTable}
          data-scrolled={scrolled}
          aria-labelledby="units-v2-grid-title"
          tabIndex={0}
          onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}
          className="group overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          {children}
        </div>
        <div
          aria-hidden="true"
          data-testid={T.scrollFade}
          className={`pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-r from-transparent to-white transition-opacity duration-150 motion-reduce:transition-none ${
            clipped.length > 0 ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>
      {clipped.length > 0 && (
        <p data-testid={T.scrollCue} className="mt-2 text-xs text-navy/60">
          Scroll for {joinNames(hidden)}
        </p>
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
  rowAction?: (row: ProductPriceGridRowDto, layout: "table" | "card") => React.ReactNode;
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
  const names = TIERS.map((t) => productTierLabel(labels, t));
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
        tabIndex={-1}
        className="mb-3 text-sm font-semibold text-navy focus:outline-none"
      >
        Prices by unit
      </h2>

      <ScrollRegion names={names}>
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr
              className={`border-b text-[11px] uppercase tracking-wide text-navy/60 ${GRID_DIVIDER}`}
            >
              <th scope="col" className={`${UNIT_CELL} py-2 font-medium`}>
                Unit
              </th>
              {rowAction && (
                <th scope="col" className="px-2 py-2 font-medium">
                  <span className="sr-only">Unit actions</span>
                </th>
              )}
              <th scope="col" className="min-w-[7rem] px-2 py-2 font-medium">
                Contains
              </th>
              {names.map((n, i) => (
                <th key={i} scope="col" data-tier-head={i + 1} className="px-2 py-2 font-medium">
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
                <th scope="row" className={`${UNIT_CELL} py-3 font-medium text-navy`}>
                  {row.label}
                  <div
                    data-testid={T.code(row.ref)}
                    className="mt-0.5 text-xs font-normal tabular-nums text-navy/60"
                  >
                    {row.code ?? "No barcode"}
                  </div>
                  <NotEditable row={row} />
                </th>
                {rowAction && <td className="px-2 py-3">{rowAction(row, "table")}</td>}
                <td className="min-w-[7rem] px-2 py-3 text-navy/80">
                  {containsLines(row, ascending).map((l, n) => (
                    <div
                      key={l}
                      className={
                        n === 0 ? "whitespace-nowrap" : "whitespace-nowrap text-xs text-navy/60"
                      }
                    >
                      {l}
                    </div>
                  ))}
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
      </ScrollRegion>

      <div className="space-y-3 md:hidden">
        {rows.map((row) => (
          <div
            key={row.ref}
            data-testid={T.card(row.ref)}
            className={`rounded-md border p-3 ${FRAME_BORDER}`}
          >
            <div className="font-medium text-navy">{row.label}</div>
            <NotEditable row={row} />
            {rowAction?.(row, "card")}
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
