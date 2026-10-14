"use client";

import * as React from "react";
import NextLink from "next/link";
import { ChevronRight, Search, X } from "lucide-react";
import { Select } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useProducts } from "@/lib/api/products";
import { useProductCategories } from "@/lib/api/product-labels";
import {
  attachParent,
  groupSearchRows,
  isFamilyProduct,
  isGroupExpanded,
  pickerProductName,
  type PickerRow,
} from "@/lib/product-search-groups";
import { useListboxNav } from "@/lib/use-listbox-nav";
import { countNoun } from "@/lib/plural";
import {
  PICKER_CHIP_COLLAPSE_AT,
  countsOf,
  targetCountText,
  type PickedTarget,
} from "@/lib/rule-targets";

/** Search results asked for at once (families carry all their variants, so 8 rows go a long way). */
const PRODUCT_LIMIT = 8;

type Row = PickerRow & { sku?: string | null };
type Item =
  | { type: "product"; row: Row }
  | { type: "group"; row: Row; expanded: boolean }
  | { type: "whole"; row: Row }
  | { type: "variant"; row: Row; parent: Row };

const rowClass =
  "flex min-h-[44px] w-full cursor-pointer items-center gap-2 px-3 text-left text-sm sm:min-h-[36px]";

/**
 * Row 509: pick MANY products and labels for a rule. One search box (families expand, a family can be
 * picked as a whole, Enter on a family row expands it as in the order pickers), one label select, and
 * the picks as removable chips below. Picking keeps focus in the search and clears it, so a long list
 * is built without leaving the keyboard. Controlled: the caller owns `value`.
 */
export function RuleTargetPicker({
  value,
  onChange,
  lockedProductIds,
  lockedCategoryIds,
  lockedLabel = "In rule",
  error,
  searchRef,
}: {
  value: PickedTarget[];
  onChange: (next: PickedTarget[]) => void;
  /** Products the rule already holds (add mode): shown, disabled, marked `lockedLabel`. */
  lockedProductIds?: readonly string[];
  lockedCategoryIds?: readonly string[];
  lockedLabel?: string;
  error?: string;
  /** Lets a dialog whose whole job is picking put focus in the search when it opens. */
  searchRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const uid = React.useId();
  const ownRef = React.useRef<HTMLInputElement>(null);
  const inputRef = searchRef ?? ownRef;
  const [q, setQ] = React.useState("");
  const [term, setTerm] = React.useState("");
  const [toggled, setToggled] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const [addedFilter, setAddedFilter] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data } = useProducts(
    { search: term || undefined, isActive: true, limit: PRODUCT_LIMIT, includeVariants: true },
    { enabled: !!term },
  );
  const raw = React.useMemo<Row[]>(() => (term ? ((data?.data ?? []) as Row[]) : []), [term, data]);
  const groups = React.useMemo(() => groupSearchRows(raw), [raw]);

  const pickedProducts = React.useMemo(
    () => new Set(value.filter((t) => t.kind === "PRODUCT").map((t) => t.id)),
    [value],
  );
  const lockedProducts = React.useMemo(() => new Set(lockedProductIds ?? []), [lockedProductIds]);
  const stateOf = (id: string, parentId?: string | null): string | null => {
    if (pickedProducts.has(id) || (parentId && pickedProducts.has(parentId))) return "Added";
    if (lockedProducts.has(id) || (parentId && lockedProducts.has(parentId))) return lockedLabel;
    return null;
  };

  const items: Item[] = React.useMemo(() => {
    const out: Item[] = [];
    for (const row of groups.rows) {
      const hasVariants = (row.variants?.length ?? 0) > 0;
      if (!hasVariants) {
        out.push({ type: "product", row });
        continue;
      }
      const expanded = isGroupExpanded(toggled, groups.expandedIds, row.id);
      out.push({ type: "group", row, expanded });
      if (expanded) {
        out.push({ type: "whole", row });
        for (const v of row.variants ?? [])
          out.push({ type: "variant", row: attachParent(v as Row, row), parent: row });
      }
    }
    return out;
  }, [groups, toggled]);

  const open = q.trim() !== "" && items.length > 0;

  const addProduct = (t: PickedTarget) => {
    // A whole family covers its variants: their chips become redundant.
    const rest = t.isFamily ? value.filter((v) => v.parentId !== t.id) : value;
    onChange([...rest, t]);
    setQ("");
    setTerm("");
    setToggled(null);
    inputRef.current?.focus();
  };

  const pick = (item: Item) => {
    if (item.type === "group") {
      setToggled(item.expanded ? "" : item.row.id);
      return;
    }
    if (item.type === "whole") {
      if (stateOf(item.row.id)) return;
      addProduct({
        kind: "PRODUCT",
        id: item.row.id,
        name: `${item.row.name} (all variants)`,
        isFamily: true,
      });
      return;
    }
    const parentId = item.type === "variant" ? item.parent.id : (item.row.parentProductId ?? null);
    if (stateOf(item.row.id, parentId)) return;
    addProduct({
      kind: "PRODUCT",
      id: item.row.id,
      name:
        item.type === "variant"
          ? pickerProductName(item.row, item.parent)
          : pickerProductName(item.row),
      sku: item.row.sku ?? null,
      parentId,
    });
  };

  const nav = useListboxNav<Item>({
    items,
    open,
    onPick: pick,
    resetKey: q,
    idPrefix: `${uid}-targets`,
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (nav.onKeyDown(e)) return;
    if (e.key !== "Enter") return;
    // Enter never submits an enclosing form. With nothing highlighted it does what a click on the
    // FIRST shown row does (row 503): add a plain row, EXPAND a family; once that family is open it
    // adds the first row under it (the whole family).
    e.preventDefault();
    const first = items[0];
    if (!first) return;
    if (first.type === "group" && first.expanded) pick(items[1]);
    else pick(first);
  };

  // ── labels ──
  const categories = useProductCategories(false);
  const canManageLabels = useAuth().user?.role === "TENANT_ADMIN";
  const noLabels = categories.isSuccess && (categories.data ?? []).length === 0;
  const pickedLabels = new Set(value.filter((t) => t.kind === "CATEGORY").map((t) => t.id));
  const lockedLabels = new Set(lockedCategoryIds ?? []);
  const labelOptions = (categories.data ?? [])
    .filter((c) => !pickedLabels.has(c.id) && !lockedLabels.has(c.id))
    .map((c) => ({ value: c.id, label: c.name }));

  const remove = (t: PickedTarget) =>
    onChange(value.filter((v) => !(v.kind === t.kind && v.id === t.id)));

  const { products: nProducts, labels: nLabels } = countsOf(value);
  const collapsed = value.length > PICKER_CHIP_COLLAPSE_AT;
  const listing = collapsed && showAll;
  const shown = listing
    ? value.filter((t) => t.name.toLowerCase().includes(addedFilter.trim().toLowerCase()))
    : value;

  const chip = (t: PickedTarget) => (
    <li
      key={`${t.kind}-${t.id}`}
      className="flex min-h-11 items-center justify-between gap-1 rounded-full bg-surface-raised pl-3 text-sm text-navy sm:min-h-8"
    >
      <span className="min-w-0 break-words">
        {t.name}
        {t.kind === "CATEGORY" && <span className="ml-1.5 text-xs text-navy/60">label</span>}
      </span>
      <button
        type="button"
        aria-label={`Remove ${t.name}`}
        onClick={() => remove(t)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-navy/60 hover:text-navy sm:h-8 sm:w-8"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );

  const stateText = (s: string) => (
    <span className="ml-auto shrink-0 text-xs font-medium text-navy/60">{s}</span>
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/40"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="text"
          aria-label="Search products"
          aria-invalid={!!error}
          placeholder="Search products by name or SKU"
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setToggled(null);
          }}
          onKeyDown={onKeyDown}
          className="h-11 w-full rounded border border-surface-border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 sm:h-10"
          {...nav.inputProps}
        />
      </div>

      {open && (
        <ul
          id={nav.listId}
          role="listbox"
          aria-label="Matching products"
          className="max-h-64 overflow-y-auto rounded border border-surface-border bg-white"
        >
          {items.map((item, i) => {
            const parentId =
              item.type === "variant" ? item.parent.id : (item.row.parentProductId ?? null);
            const taken =
              item.type === "group"
                ? null
                : stateOf(item.row.id, item.type === "whole" ? null : parentId);
            const label =
              item.type === "whole"
                ? `${item.row.name} (all variants)`
                : item.type === "variant"
                  ? pickerProductName(item.row, item.parent)
                  : item.row.name;
            return (
              <li
                key={`${item.type}-${item.row.id}`}
                id={nav.optionId(i)}
                role="option"
                aria-selected={nav.highlight === i}
                aria-disabled={taken ? true : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(item)}
                className={`${rowClass} ${
                  item.type === "variant" || item.type === "whole"
                    ? "bg-surface-raised/50 pl-8"
                    : ""
                } ${nav.highlight === i ? "bg-surface-raised" : "hover:bg-surface-raised"} ${
                  taken ? "cursor-not-allowed opacity-60" : ""
                }`}
              >
                {item.type === "group" && (
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-navy/70 transition-transform ${
                      item.expanded ? "rotate-90" : ""
                    }`}
                    aria-hidden
                  />
                )}
                <span className="min-w-0 break-words font-medium text-navy">{label}</span>
                {item.type !== "group" && item.row.sku && (
                  <span className="shrink-0 font-mono text-xs text-navy/60">{item.row.sku}</span>
                )}
                {item.type === "group" && (
                  <span className="ml-auto shrink-0 text-xs text-navy/60">
                    {countNoun(item.row.variants?.length ?? 0, "variant")}
                    {isFamilyProduct(item.row) ? "" : " + itself"}
                  </span>
                )}
                {taken && stateText(taken)}
              </li>
            );
          })}
        </ul>
      )}
      {raw.length === PRODUCT_LIMIT && (
        <p className="text-xs text-navy/60">
          Showing the first {PRODUCT_LIMIT}. Refine your search.
        </p>
      )}
      {term && data && raw.length === 0 && (
        <p className="text-xs text-navy/60">No matching products</p>
      )}

      {noLabels ? (
        <div>
          <p className="text-sm text-navy/70">No product labels yet</p>
          {canManageLabels ? (
            <NextLink
              href="/settings/product-categories"
              className="text-sm font-medium text-navy underline"
            >
              Add product labels
            </NextLink>
          ) : (
            <p className="text-sm text-navy/70">Ask an account admin to add product labels.</p>
          )}
        </div>
      ) : (
        <Select
          label="Add a label"
          value=""
          onChange={(e) => {
            const id = e.target.value;
            const c = (categories.data ?? []).find((x) => x.id === id);
            if (c) onChange([...value, { kind: "CATEGORY", id: c.id, name: c.name }]);
          }}
          options={[{ value: "", label: "Choose a label", disabled: true }, ...labelOptions]}
        />
      )}

      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}

      {value.length === 0 ? (
        <p className="text-sm text-navy/60">
          Search to add products. A family includes all its variants.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3">
            <p role="status" className="text-sm font-medium text-navy">
              {targetCountText(nProducts, nLabels)}
            </p>
            {collapsed && (
              <button
                type="button"
                aria-expanded={showAll}
                onClick={() => {
                  setShowAll((s) => !s);
                  setAddedFilter("");
                }}
                className="min-h-11 text-sm font-medium text-navy underline sm:min-h-0"
              >
                {showAll ? "Hide" : "Show all"}
              </button>
            )}
          </div>
          {(!collapsed || listing) && (
            <>
              {listing && (
                <input
                  type="search"
                  aria-label="Search added"
                  placeholder="Search what you added"
                  value={addedFilter}
                  onChange={(e) => setAddedFilter(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
                  className="h-11 w-full rounded border border-surface-border bg-white px-3 text-sm sm:h-10"
                />
              )}
              <ul
                aria-label="Selected products and labels"
                className={
                  listing
                    ? "max-h-56 space-y-1 overflow-y-auto rounded border border-surface-border p-2"
                    : "flex flex-wrap gap-2"
                }
              >
                {shown.map(chip)}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
