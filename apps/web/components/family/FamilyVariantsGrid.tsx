"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import { Button, cn } from "@routeflow/ui/web";
import { unitWords } from "@routeflow/pricing";
import { MAX_FAMILY_ROWS, blankRow, type GridRow, type RowField } from "@/lib/family-grid";
import { formatMoney } from "@/lib/format";

export interface CellMessage {
  message: string;
  /** The ACTIVE holder of a taken code / name: the message links to it. */
  productId?: string;
}

// U-3a: the family grid carries no per-product label yet, so it prints the default words.
const W = unitWords();

const COLUMNS: Array<{
  field: RowField;
  label: string;
  ariaLabel: string;
  placeholder?: string;
  width: string;
  inputMode?: "decimal" | "numeric";
  /** V20: money lines up on its right edge, with tabular numbers. */
  align?: "right";
  /** K11-24: read-only prints this as money. */
  money?: boolean;
  /** K11-24: read-only keeps this column on a phone; the others return from `sm` up. */
  core?: boolean;
}> = [
  { field: "name", label: "Name", ariaLabel: "name", width: "min-w-[10rem]", core: true },
  { field: "sku", label: "SKU", ariaLabel: "SKU", width: "min-w-[7rem]" },
  { field: "barcode", label: "Barcode", ariaLabel: "barcode", width: "min-w-[8rem]" },
  { field: "unitSku", label: "Unit code", ariaLabel: "unit code", width: "min-w-[7rem]" },
  {
    field: "unitsPerBox",
    label: `${W.base.other} per ${W.pack.lower}`,
    ariaLabel: `${W.base.lowerOther} per ${W.pack.lower}`,
    width: "min-w-[5rem]",
    inputMode: "numeric",
  },
  {
    field: "pricePerUnit",
    label: "Price",
    ariaLabel: "price",
    width: "min-w-[5rem]",
    inputMode: "decimal",
    align: "right",
    money: true,
    core: true,
  },
  {
    field: "standardCost",
    label: "Cost",
    ariaLabel: "cost",
    placeholder: "Family cost",
    width: "min-w-[5rem]",
    inputMode: "decimal",
    money: true,
  },
];
const CODE_FIELDS = new Set<RowField>(["sku", "barcode", "unitSku"]);

let seq = 0;
const newKey = () => `new-${Date.now().toString(36)}-${(seq += 1)}`;

/**
 * WS8: the editable variants grid shared by the "New family" dialog and the family detail page.
 * Controlled and presentational: validation and server conflicts arrive as `cellMessages`
 * (`row:field` -> message), keyed the same way `lib/family-conflicts` keys them.
 */
export function FamilyVariantsGrid({
  rows,
  onChange,
  cellMessages,
  onCodeBlur,
  readOnly = false,
  disabled = false,
  showCostHint = true,
  maxRows = MAX_FAMILY_ROWS,
  focusId,
}: {
  rows: GridRow[];
  onChange: (rows: GridRow[]) => void;
  cellMessages: Record<string, CellMessage>;
  /** A code cell lost focus with this value: the parent may ask the availability endpoint. */
  onCodeBlur?: (rowIndex: number, field: "sku" | "barcode" | "unitSku", value: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
  /** Create-time only: a blank cost means the family cost. An update cannot clear a cost, so no hint there. */
  showCostHint?: boolean;
  /** The create form caps the grid at 200; a saved family's cap is on the REQUEST, not its row count. */
  maxRows?: number;
  /** K13 F18: a saved variant to bring into view (scroll, focus its link, mark it briefly) on arrival. */
  focusId?: string;
}) {
  const [marked, setMarked] = React.useState<string | null>(focusId ?? null);
  const tableRef = React.useRef<HTMLTableSectionElement>(null);
  React.useEffect(() => {
    if (!focusId) return;
    const row = Array.from(
      tableRef.current?.querySelectorAll<HTMLElement>("[data-variant-id]") ?? [],
    ).find((el) => el.dataset.variantId === focusId);
    if (!row) return;
    setMarked(focusId);
    row.scrollIntoView?.({ block: "center" });
    row.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
    const t = window.setTimeout(() => setMarked(null), 3000);
    return () => window.clearTimeout(t);
  }, [focusId, rows.length]);
  const atCap = rows.length >= maxRows;
  // K12: a saved family with no SKU / barcode / unit code on any variant drops those empty columns.
  const columns = readOnly
    ? COLUMNS.filter((c) => !CODE_FIELDS.has(c.field) || rows.some((r) => r[c.field]))
    : COLUMNS;
  const setCell = (i: number, field: RowField, value: string) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-navy/70">
            <tr>
              <th className="w-8 px-2 py-2">#</th>
              {columns.map((c) => (
                <th
                  key={c.field}
                  className={cn(
                    "px-2 py-2 font-semibold",
                    (c.align === "right" || (readOnly && c.money)) && "text-right",
                    readOnly && c.money && "whitespace-nowrap",
                    readOnly && !c.core && "max-sm:hidden",
                  )}
                >
                  {c.label}
                </th>
              ))}
              {!readOnly && <th className="w-10 px-2 py-2" aria-label="Remove" />}
            </tr>
          </thead>
          <tbody ref={tableRef}>
            {rows.map((r, i) => (
              <tr
                key={r.key}
                data-variant-id={r.id || undefined}
                data-focused-variant={r.id && r.id === marked ? "true" : undefined}
                className={cn(
                  "border-t border-surface-border align-top",
                  r.id && r.id === marked && "bg-brand-500/10 transition-colors",
                  readOnly && r.id && "relative hover:bg-surface-raised/60",
                )}
              >
                <td className="px-2 py-2 text-navy/60">{i + 1}</td>
                {columns.map((c) => {
                  const msg = cellMessages[`${i}:${c.field}`];
                  return (
                    <td
                      key={c.field}
                      className={cn(
                        "px-2 py-1.5",
                        c.width,
                        readOnly && c.money && "whitespace-nowrap",
                        readOnly && !c.core && "max-sm:hidden",
                      )}
                    >
                      {readOnly ? (
                        <span
                          className={cn(
                            (c.align === "right" || c.money) && "block text-right tabular-nums",
                          )}
                        >
                          {!r[c.field] ? (
                            "—"
                          ) : c.money ? (
                            formatMoney(r[c.field])
                          ) : c.field === "name" && r.id ? (
                            <Link
                              href={`/products/${r.id}`}
                              className="font-medium text-brand-600 underline-offset-2 after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand-500"
                            >
                              {r.name}
                            </Link>
                          ) : (
                            r[c.field]
                          )}
                        </span>
                      ) : (
                        <input
                          aria-label={`Variant ${i + 1} ${c.ariaLabel}`}
                          aria-invalid={msg ? "true" : undefined}
                          aria-describedby={msg ? `family-cell-${i}-${c.field}` : undefined}
                          value={r[c.field]}
                          placeholder={showCostHint ? c.placeholder : undefined}
                          inputMode={c.inputMode}
                          disabled={disabled}
                          onChange={(e) => setCell(i, c.field, e.target.value)}
                          onBlur={() => {
                            if (CODE_FIELDS.has(c.field) && r[c.field].trim()) {
                              onCodeBlur?.(
                                i,
                                c.field as "sku" | "barcode" | "unitSku",
                                r[c.field].trim(),
                              );
                            }
                          }}
                          className={cn(
                            "w-full rounded border bg-white px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500",
                            c.align === "right" && "text-right tabular-nums",
                            msg ? "border-danger" : "border-surface-border",
                          )}
                        />
                      )}
                      {msg && (
                        <p id={`family-cell-${i}-${c.field}`} className="mt-1 text-xs text-danger">
                          {msg.message}
                          {msg.productId && (
                            <>
                              {" "}
                              <Link
                                href={`/products/${msg.productId}`}
                                className="underline underline-offset-2"
                              >
                                View product
                              </Link>
                            </>
                          )}
                        </p>
                      )}
                    </td>
                  );
                })}
                {!readOnly && (
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      aria-label={`Remove variant ${i + 1}`}
                      disabled={disabled}
                      onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                      className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {showCostHint ? (
            <p className="text-xs text-navy/60">Leave cost blank to use the family cost.</p>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {atCap && (
              <span className="text-xs text-navy/70">
                A family takes up to {MAX_FAMILY_ROWS} variants at a time.
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              leftIcon={<Plus className="h-4 w-4" />}
              disabled={atCap || disabled}
              onClick={() => onChange([...rows, blankRow(newKey())])}
            >
              Add variant
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
