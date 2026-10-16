"use client";

import * as React from "react";
import type { ProductPriceGridCellDto, ProductPriceGridRowDto } from "@routeflow/types";
import { useSubscription } from "@/lib/api/billing";
import { useTierLabels } from "@/lib/api/tier-labels";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { formatMoney } from "@/lib/format";
import { tierLabel } from "@/lib/tier-label";
import type { UnitsCardProduct } from "./ProductUnitsCard";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";

/**
 * The units v2 prices grid, READ ONLY: one row per unit, one column per price tier, values exactly
 * as the API gives them (no money math here, so no pricing package import). Phones get one
 * card per unit; wider screens get a table that scrolls in its own box with the Unit column pinned.
 */

const TIERS = [1, 2, 3, 4, 5] as const;
const MSRP_FLAG = "flag.msrp";

// V12: field-border token, scoped to this grid only (light #758380 / dark #6b7f7c).
const GRID_BORDER = "border-[#758380] dark:border-[#6b7f7c]";
const GRID_DIVIDER = "border-[#758380]/40 dark:border-[#6b7f7c]/40";

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
  const noPrice = row.kind === "pack" && tier === 1 && cell.value === 0;
  const display = noPrice ? "No price" : formatMoney(cell.value);
  const word = cell.source === "set" ? "Set" : "Auto";
  return { tier, display, word, aria: `${name} ${row.label} price, ${display}` };
}

function PriceCell({ view, testId }: { view: CellView; testId?: string }) {
  return (
    <div data-testid={testId} aria-label={view.aria} role="group" className="leading-tight">
      <div className="font-medium tabular-nums text-navy">{view.display}</div>
      {view.word && <div className="text-[11px] text-navy/60">{view.word}</div>}
    </div>
  );
}

export function ProductPricesGrid({
  product,
}: {
  product: UnitsCardProduct & { msrp?: number | string | null };
}) {
  const grid = usePriceGrid(product.id);
  const labels = useTierLabels().data;
  const sub = useSubscription({ staleTime: 60_000 });
  const showMsrp =
    product.msrp != null && product.msrp !== "" && (sub.data?.flags ?? []).includes(MSRP_FLAG);

  if (grid.isLoading) {
    return <p className="text-sm text-navy/60">Loading prices…</p>;
  }
  if (grid.isError || !grid.data) {
    return <p className="text-sm text-red-600">Prices could not be loaded.</p>;
  }

  const rows = [...grid.data.rows].sort((a, b) => b.factor - a.factor);
  const ascending = [...rows].reverse();
  const names = TIERS.map((t) => (t === 1 ? "Retail" : tierLabel(labels, t)));

  return (
    <div
      data-testid={T.grid}
      className={`rounded-lg border bg-white p-4 dark:bg-transparent ${GRID_BORDER}`}
    >
      <h2 className="mb-3 text-sm font-semibold text-navy">Prices by unit</h2>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr
              className={`border-b text-[11px] uppercase tracking-wide text-navy/60 ${GRID_DIVIDER}`}
            >
              <th className="sticky left-0 z-10 bg-white px-2 py-2 font-medium dark:bg-surface">
                Unit
              </th>
              <th className="px-2 py-2 font-medium">Contains</th>
              <th className="px-2 py-2 font-medium">Barcode</th>
              {names.map((n) => (
                <th key={n} className="px-2 py-2 font-medium">
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
                <td className="sticky left-0 z-10 bg-white px-2 py-3 font-medium text-navy dark:bg-surface">
                  {row.label}
                </td>
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
            data-testid={`units-v2-card-${row.ref}`}
            className={`rounded-md border p-3 ${GRID_BORDER}`}
          >
            <div className="font-medium text-navy">{row.label}</div>
            <div className="text-xs text-navy/70">{containsLines(row, ascending).join(" · ")}</div>
            <div className="mb-2 text-xs text-navy/70">Barcode: {row.code ?? "No barcode"}</div>
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
                      <PriceCell view={view} />
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>

      {showMsrp && <p className="mt-3 text-xs text-navy/70">MSRP {formatMoney(product.msrp)}</p>}
    </div>
  );
}
