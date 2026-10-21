"use client";

import * as React from "react";
import type { ProductPriceGridDto, ProductUnitLevel } from "@routeflow/types";
import { resolveUnitPrice, unitWords, type LadderProduct } from "@routeflow/pricing";
import { Button, Modal, Skeleton, useToast } from "@routeflow/ui/web";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DecimalInput } from "@/components/MoneyInput";
import { useAuth } from "@/lib/auth-context";
import { fmt } from "@/lib/formatting";
import { useTierLabels } from "@/lib/api/tier-labels";
import { productTierLabel } from "@/lib/tier-one-label";
import {
  useCreateProductUnit,
  useDeleteProductUnit,
  useProductUnits,
  useUnitsEnabled,
  useUpdateProductUnit,
} from "@/lib/api/product-units";
import { cascadePatch, proposeCascade, type CascadeProposal } from "@/lib/unit-cascade";
import { unitNotListedNotice } from "@/lib/api/tenant-units";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { MoneyFigure } from "./MoneyFigure";
import { PriceFigure, TIERS, packRowOf, rowForUnit } from "./PriceFigures";
import { usePriceWindowOpener } from "./PriceWindowHost";
import { PriceSaveStatus } from "./ProductPricingV2";
import { useDefaultOrderUnit } from "./units-v2/structure/useDefaultOrderUnit";
import { BTN } from "./units-v2/edit/PriceEditBar";
import { usePriceDraftOptional } from "./units-v2/edit/PriceDraftProvider";
import {
  shellHasUnitControls,
  shellRemovesUnit,
  unitStructureGoverned,
} from "./units-v2/structure/unit-structure";

/**
 * "Units & prices" (units_v1, ask 1-3): define Case / Pallet / Piece levels on a product, give
 * each an explicit price (or let it derive from the pack), and pick the default selling unit.
 * Own file — page.tsx is ~2.9k lines. Renders NOTHING unless the tenant is granted
 * `flag.units_v1`, so a merged PR changes nothing until the owner flips it.
 */

export interface UnitsCardProduct extends LadderProduct {
  id: string;
  unit: string;
  unitsPerBox?: number | null;
  pricePerUnit: number | string;
  /** Read only to tell a product the unit ladder can't be edited on (a family, recipe or variant). */
  kind?: string | null;
  parentProductId?: string | null;
}

const num = (v: string | number | null | undefined): number | null =>
  v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/** 0 means "derive" to the ladder (getTierPrice convention) — never store it as an explicit price. */
const priceOrNull = (v: number | null): number | null => (v != null && v > 0 ? v : null);

const FIELD =
  "h-10 w-full rounded-md border border-surface-border bg-white px-2.5 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";
const LABEL = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-navy/60";

type Draft = {
  label: string;
  factor: number | null;
  prices: Array<number | null>; // tiers 1..5
};

const draftOf = (u: ProductUnitLevel): Draft => ({
  label: u.label,
  factor: u.factorToBase,
  prices: [u.price, u.priceTier2, u.priceTier3, u.priceTier4, u.priceTier5].map(num),
});

const DEFAULT_RADIO = "default-selling-unit";
const DEFAULT_HINT_ID = "units-default-hint";
const DEFAULT_HINT = "Use arrow keys to move, Space to make it the default.";

/**
 * F18: a default-order-unit radio saves the moment it is chosen, so the keys must not choose by accident. Arrow keys only
 * MOVE focus through the group (natively they also select, which would write on every press); Space (a click) and Enter
 * commit. `commit` is a no-op for the radio that is already the default.
 */
function radioKeys(commit: () => void) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const group = Array.from(
      (e.currentTarget.closest("[data-units-card]") ?? document).querySelectorAll<HTMLInputElement>(
        `input[type="radio"][name="${DEFAULT_RADIO}"]`,
      ),
    );
    const at = group.indexOf(e.currentTarget);
    if (at < 0 || group.length < 2) return;
    group[(at + step + group.length) % group.length].focus();
  };
}

function UnitRow({
  unit,
  product,
  units,
  tierNames,
  busy,
  onSave,
  onDelete,
  onMakeDefault,
  hideRemove,
  figures,
}: {
  unit: ProductUnitLevel;
  product: UnitsCardProduct;
  units: ProductUnitLevel[];
  tierNames: Record<string, string> | undefined;
  busy: boolean;
  onSave: (unit: ProductUnitLevel, draft: Draft) => void;
  onDelete: (unit: ProductUnitLevel) => void;
  onMakeDefault: (unit: ProductUnitLevel) => void;
  /** K10d: the v2 shell has its own Remove under this unit's name, so there is one Remove per unit. */
  hideRemove?: boolean;
  /**
   * K11-20c: the v2 page. Prices are read-only figures from the served grid (buttons to the floating window) and this row
   * writes Name and factor only. `grid` is the served grid; `card` is the element the window hangs off.
   */
  figures?: {
    grid: ProductPriceGridDto | undefined;
    /** The grid query failed with nothing cached: figures show the stored prices as read-only text. */
    errored: boolean;
    card: () => HTMLElement | null;
    heading: () => HTMLElement | null;
  };
}) {
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(unit));
  const base = draftOf(unit);
  // Reset only when the SERVER values of this row change — a refetch that returns equal data
  // (or another row's save) must never wipe an in-progress edit.
  const baseKey = JSON.stringify(base);
  React.useEffect(() => setDraft(JSON.parse(baseKey) as Draft), [baseKey]);
  const dirty =
    draft.label !== base.label ||
    draft.factor !== base.factor ||
    (!figures && draft.prices.some((p, i) => p !== base.prices[i]));
  const gridRow = figures ? rowForUnit(figures.grid, unit) : undefined;
  const figure = (t: (typeof TIERS)[number]) =>
    figures ? (
      <PriceFigure
        row={gridRow}
        tier={t}
        anchor={figures.card}
        fallback={figures.heading}
        plainValue={figures.errored ? base.prices[t - 1] : undefined}
      />
    ) : null;
  const w = unitWords();
  const valid = draft.label.trim() !== "" && draft.factor != null && draft.factor >= 1;
  // What tier `t` would price at if THIS field were left blank: the row as currently drafted,
  // with only that tier cleared (so "derived" never previews the explicit price being replaced).
  const derived = (tier: number) => {
    try {
      const preview = units.map((u) =>
        u.id !== unit.id
          ? u
          : {
              ...u,
              price: draft.prices[0] == null || tier === 1 ? null : String(draft.prices[0]),
              priceTier2: tier === 2 || draft.prices[1] == null ? null : String(draft.prices[1]),
              priceTier3: tier === 3 || draft.prices[2] == null ? null : String(draft.prices[2]),
              priceTier4: tier === 4 || draft.prices[3] == null ? null : String(draft.prices[3]),
              priceTier5: tier === 5 || draft.prices[4] == null ? null : String(draft.prices[4]),
            },
      );
      return resolveUnitPrice(product, preview, unit.label, tier);
    } catch {
      return null;
    }
  };
  const isPiece = unit.factorToBase === 1;
  const idp = `unit-${unit.id}`;

  return (
    <li className="rounded-lg border border-surface-border bg-white p-3" data-testid="unit-row">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className={LABEL} htmlFor={`${idp}-label`}>
            Name
          </label>
          <input
            id={`${idp}-label`}
            aria-label={`${unit.label} name`}
            className={FIELD}
            value={draft.label}
            disabled={isPiece}
            maxLength={40}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`${idp}-factor`}>
            {isPiece ? "Smallest unit" : `${w.base.other} per ${unit.label.toLowerCase()}`}
          </label>
          <DecimalInput
            id={`${idp}-factor`}
            aria-label={isPiece ? "Smallest unit size" : `${w.base.other} per ${unit.label}`}
            className={FIELD}
            decimals={0}
            min={1}
            value={draft.factor}
            disabled={isPiece}
            onChange={(v) => setDraft({ ...draft, factor: v })}
          />
        </div>
        <div className="col-span-2">
          <label className={LABEL} htmlFor={`${idp}-price`}>
            Price
          </label>
          {figures ? (
            <div id={`${idp}-price`}>{figure(1)}</div>
          ) : (
            <DecimalInput
              id={`${idp}-price`}
              aria-label={`${unit.label} price`}
              className={FIELD}
              value={draft.prices[0]}
              placeholder={derived(1) != null ? fmt(derived(1) as number) : ""}
              onChange={(v) =>
                setDraft({ ...draft, prices: draft.prices.map((p, i) => (i ? p : v)) })
              }
            />
          )}
        </div>
      </div>
      {!figures && (
        <p className="mt-1.5 text-[11px] text-navy/50">
          A grey figure is worked out automatically from the {w.pack.lower} price. Type a price to
          set it yourself, or clear it to go back to automatic.
        </p>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-brand-600">Tier prices</summary>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[2, 3, 4, 5].map((t) => (
            <div key={t}>
              <label className={LABEL} htmlFor={`${idp}-t${t}`}>
                {productTierLabel(tierNames, t)}
              </label>
              {figures ? (
                <div id={`${idp}-t${t}`}>{figure(t as (typeof TIERS)[number])}</div>
              ) : (
                <DecimalInput
                  id={`${idp}-t${t}`}
                  aria-label={`${unit.label} ${productTierLabel(tierNames, t)} price`}
                  className={FIELD}
                  value={draft.prices[t - 1]}
                  placeholder={derived(t) != null ? fmt(derived(t) as number) : ""}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      prices: draft.prices.map((p, i) => (i === t - 1 ? v : p)),
                    })
                  }
                />
              )}
            </div>
          ))}
        </div>
      </details>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-navy">
          <input
            type="radio"
            name={DEFAULT_RADIO}
            aria-describedby={DEFAULT_HINT_ID}
            checked={unit.isDefaultSelling}
            onChange={() => onMakeDefault(unit)}
            onKeyDown={radioKeys(() => {
              if (!unit.isDefaultSelling) onMakeDefault(unit);
            })}
            aria-disabled={busy || undefined}
          />
          Default order unit
        </label>
        <div className="flex gap-2">
          {dirty && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setDraft(base)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => onSave(unit, draft)} disabled={busy || !valid}>
                Save
              </Button>
            </>
          )}
          {!hideRemove && (
            <Button size="sm" variant="secondary" onClick={() => onDelete(unit)} disabled={busy}>
              Remove
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

/** The badge a read-only row (or the pack row) wears instead of the Default order unit radio. */
const DefaultBadge = () => (
  <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-navy">
    Default order unit
  </span>
);

/**
 * Read-only row (the v2 grid owns every control now): name, size and each tier's price as text. Prices come from the
 * served grid; with no grid row (the query failed) the unit's own stored prices stand in, as the live row does.
 */
function UnitRowReadOnly({
  unit,
  grid,
  tierNames,
}: {
  unit: ProductUnitLevel;
  grid: ProductPriceGridDto | undefined;
  tierNames: Record<string, string> | undefined;
}) {
  const w = unitWords();
  const row = rowForUnit(grid, unit);
  const stored = draftOf(unit).prices;
  return (
    <li className="rounded-lg border border-surface-border bg-white p-3" data-testid="unit-row">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-navy">
          <span className="font-medium">{unit.label}</span>{" "}
          <span className="text-navy/60">
            · {unit.factorToBase} {w.baseFor(unit.factorToBase)}
          </span>
        </span>
        {unit.isDefaultSelling && <DefaultBadge />}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-5">
        {TIERS.map((t) => {
          const value = row ? row.cells.find((c) => c.tier === t)?.value : stored[t - 1];
          return (
            <div key={t}>
              <dt className="text-[11px] uppercase tracking-wide text-navy/60">
                {productTierLabel(tierNames, t)}
              </dt>
              <dd>
                {value == null ? (
                  <span aria-label="not set">—</span>
                ) : (
                  <MoneyFigure value={value} className="font-mono font-medium text-navy" />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </li>
  );
}

/**
 * K14 P05 (fallback of P02): under units v2 (the page passes hideAddForm) this card repeats the grid, so it steps aside
 * while the grid is edited inline and returns on Save or Cancel. Nothing is removed; flag off it always renders.
 */
export function ProductUnitsCard(props: React.ComponentProps<typeof ProductUnitsCardBody>) {
  const editingInline = usePriceDraftOptional()?.editingIn === "inline";
  if (props.hideAddForm && editingInline) return null;
  return <ProductUnitsCardBody {...props} />;
}

function ProductUnitsCardBody({
  product,
  hideAddForm = false,
  readOnly = false,
}: {
  product: UnitsCardProduct;
  /**
   * K10d: the v2 shell has its own single "Add a unit", so the page passes the v2 flag and the always-open form
   * goes. A product the shell does not mount it on (family, recipe, variant) keeps this form.
   */
  hideAddForm?: boolean;
  /**
   * Owner ruling D-2026-10-18: under the v2 grid this card only reads. Every live control (Add, Remove, Name / size, the
   * default order unit, Edit prices) sits beside the grid. Applies once the grid has mounted those controls, so until
   * then (or if its query fails) the card keeps its own, and nothing is ever without a control.
   */
  readOnly?: boolean;
}) {
  const { user } = useAuth();
  // GET /billing/subscription is OPERATOR-only — never fire it (and 403) for other roles.
  const canManage = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const enabled = useUnitsEnabled({ enabled: canManage });
  const { toast } = useToast();
  const { data: tiers } = useTierLabels();
  const list = useProductUnits(product.id, enabled);
  const create = useCreateProductUnit(product.id);
  const update = useUpdateProductUnit(product.id);
  const remove = useDeleteProductUnit(product.id);
  const [name, setName] = React.useState("");
  const [factor, setFactor] = React.useState<number | null>(null);
  const [price, setPrice] = React.useState<number | null>(null);
  const [proposals, setProposals] = React.useState<CascadeProposal[]>([]);
  const [removing, setRemoving] = React.useState<ProductUnitLevel | null>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  // K11-20c: under the v2 page's price host, prices are figures that open the floating window (the card writes none).
  const opener = usePriceWindowOpener();
  const pageDraft = usePriceDraftOptional();
  // After Dismiss, Undo or a committed change the CHECKED default radio takes focus (never another radio: one Space press
  // on it would flip the default). It is the pack radio when the pack is the default, so that one is never natively
  // disabled. Focus moves only if it is already on the page's body or inside this card, so a late write never steals it
  // from somewhere else; a plain click commit (focus not in the card) only scrolls. Scrolling never moves focus.
  const [refocus, setRefocus] = React.useState({ n: 0, needInside: false });
  React.useEffect(() => {
    if (refocus.n === 0) return;
    const card = cardRef.current;
    const checked = card?.querySelector<HTMLInputElement>(
      `input[type="radio"][name="${DEFAULT_RADIO}"]:checked`,
    );
    if (!card || !checked) return;
    const active = document.activeElement;
    const inside = active != null && active !== document.body && card.contains(active);
    const free = active == null || active === document.body;
    if (inside || (free && !refocus.needInside)) checked.focus();
    checked.scrollIntoView?.({ block: "nearest" });
  }, [refocus]);

  // K10d: the same grid the v2 shell reads. Until it has rows the shell has no Add / Remove, so the old ones stay.
  const shellOwns = hideAddForm && !unitStructureGoverned(product);
  const gridQuery = usePriceGrid(product.id, enabled && shellOwns);
  const grid = gridQuery.data;
  const figures = shellOwns && opener != null;
  const figureCtx = figures
    ? {
        grid,
        errored: gridQuery.isError && !grid,
        card: () => cardRef.current,
        heading: () => headingRef.current,
      }
    : undefined;
  const anyEditable = !!grid?.rows?.some((r) => r.editable);
  const units = list.data ?? [];
  const otherBusy = create.isPending || update.isPending || remove.isPending;
  // F18: the default order unit's write logic is shared with the v2 shell's units beside the grid.
  const packName = product.unit || unitWords().pack.one;
  const dflt = useDefaultOrderUnit(product.id, units, packName, {
    busy: otherBusy,
    onSettled: (needInside) => setRefocus((r) => ({ n: r.n + 1, needInside })),
  });
  const defaultNote = dflt.note;
  const busy = otherBusy || dflt.pending;
  if (!enabled) return null;
  const addInShell = shellOwns && shellHasUnitControls(grid);
  const ro = readOnly && addInShell;
  const tierNames = tiers;
  // B594: no component-level error toasts — app/providers.tsx's global MutationCache handler
  // already toasts the server's message for every failed mutation, so a second one here doubled it.

  // SA-810: the level saved, but its name was not added to the full unit list. Say so, once.
  const notListed = (saved: unknown) => {
    const notice = unitNotListedNotice(saved);
    if (notice) toast({ title: notice, variant: "info" });
  };

  const save = (unit: ProductUnitLevel, d: Draft) => {
    dflt.clearNote();
    const oldPrices = draftOf(unit).prices;
    const newPrices = d.prices.map(priceOrNull);
    // Only a price the operator changed is sent (a draft price that still equals the value the row was seeded with is
    // left out): a v2 price save moves prices outside this card, so the row's snapshot is never written back.
    const dirtyPrice = (i: number) => !figures && d.prices[i] !== oldPrices[i];
    const body = {
      id: unit.id,
      label: d.label.trim(),
      factorToBase: d.factor ?? unit.factorToBase,
      ...(dirtyPrice(0) ? { price: newPrices[0] } : {}),
      ...(dirtyPrice(1) ? { priceTier2: newPrices[1] } : {}),
      ...(dirtyPrice(2) ? { priceTier3: newPrices[2] } : {}),
      ...(dirtyPrice(3) ? { priceTier4: newPrices[3] } : {}),
      ...(dirtyPrice(4) ? { priceTier5: newPrices[4] } : {}),
    };
    update.mutate(body, {
      // EVERY tier cascades, each independently (a tier-2 edit offers tier 2 to the others).
      onSuccess: (saved) => {
        notListed(saved);
        // No price moved from this card in v2, so there is nothing to offer to the other units.
        if (!figures) setProposals(proposeCascade(units, unit.id, oldPrices, newPrices));
      },
    });
  };

  const applyCascade = async () => {
    dflt.clearNote();
    const todo = proposals;
    setProposals([]);
    const results = await Promise.allSettled(
      todo.map((p) => update.mutateAsync({ id: p.unitId, ...cascadePatch(p) })),
    );
    const failed = todo.filter((_, i) => results[i].status === "rejected");
    if (failed.length === 0) {
      toast({ title: "Other unit prices updated", variant: "success" });
    } else {
      toast({
        title: `Updated ${todo.length - failed.length} of ${todo.length} other units`,
        description: `Not updated: ${failed.map((p) => p.label).join(", ")}. Edit them directly.`,
        variant: "error",
      });
    }
  };

  const add = () => {
    if (!name.trim() || !factor) return;
    dflt.clearNote();
    create.mutate(
      {
        label: name.trim(),
        factorToBase: factor,
        // v2: prices are written only through the price window (S9), never by creating a unit.
        ...(figures ? {} : { price: priceOrNull(price) }),
      },
      {
        onSuccess: (saved) => {
          notListed(saved);
          setName("");
          setFactor(null);
          setPrice(null);
        },
      },
    );
  };

  const w = unitWords();
  const packPieces = product.unitsPerBox && product.unitsPerBox > 1 ? product.unitsPerBox : 1;
  const noneDefault = !units.some((u) => u.isDefaultSelling);

  return (
    <div
      ref={cardRef}
      data-units-card
      className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card"
    >
      <div data-testid="units-card-header" className="border-b border-surface-border px-5 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70 outline-none"
          >
            Units &amp; prices
          </h3>
          {figures && opener && anyEditable && !ro && (
            <button
              type="button"
              className={BTN}
              onClick={(e) =>
                opener.open({
                  origin: e.currentTarget,
                  anchor: cardRef.current,
                  fallback: () => headingRef.current,
                })
              }
            >
              Edit prices
            </button>
          )}
        </div>
        {figures && pageDraft && <PriceSaveStatus productId={product.id} surface="window" />}
      </div>
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-raised px-3 py-2.5 text-sm">
          <span className="text-navy">
            <span className="font-medium">{product.unit || w.pack.one}</span>{" "}
            <span className="text-navy/60">
              · {packPieces} {w.baseFor(packPieces)} ·{" "}
              {figures || ro ? (
                <>the {w.pack.lower}</>
              ) : (
                <>the {w.pack.lower} (edit its price above)</>
              )}
            </span>
          </span>
          <span className="flex items-center gap-4">
            {ro ? (
              <MoneyFigure
                value={
                  packRowOf(grid)?.cells.find((c) => c.tier === 1)?.value ?? product.pricePerUnit
                }
                className="font-mono font-medium text-navy"
              />
            ) : figures ? (
              <PriceFigure
                row={packRowOf(grid)}
                tier={1}
                anchor={() => cardRef.current}
                fallback={() => headingRef.current}
                plainValue={gridQuery.isError && !grid ? product.pricePerUnit : undefined}
              />
            ) : (
              <span className="font-mono tabular-nums text-navy">
                {fmt(Number(product.pricePerUnit) || 0)}
              </span>
            )}
            {ro ? (
              noneDefault && <DefaultBadge />
            ) : (
              <label className="flex items-center gap-2 text-navy">
                <input
                  type="radio"
                  name={DEFAULT_RADIO}
                  aria-describedby={DEFAULT_HINT_ID}
                  checked={noneDefault}
                  // Never natively disabled: a disabled radio drops focus the moment it becomes the checked default, so a
                  // screen-reader user would hear nothing. aria-disabled keeps it focusable; activating it does nothing.
                  aria-disabled={busy || noneDefault || undefined}
                  onChange={() => {
                    if (!busy && !noneDefault) dflt.change(null);
                  }}
                  onKeyDown={radioKeys(() => {
                    if (!busy && !noneDefault) dflt.change(null);
                  })}
                />
                Default order unit
              </label>
            )}
          </span>
        </div>

        {/* F18: always mounted, so the text it receives is announced. Undo and Dismiss sit beside it, not inside it. */}
        {!ro && (
          <p id={DEFAULT_HINT_ID} className="sr-only">
            {DEFAULT_HINT}
          </p>
        )}
        <div
          hidden={ro}
          className={
            defaultNote
              ? "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface-raised px-3 py-2 text-sm text-navy"
              : "sr-only"
          }
        >
          <p role="status" data-testid="units-default-note">
            {defaultNote?.text ?? ""}
          </p>
          {defaultNote?.undo && (
            <Button size="sm" variant="secondary" onClick={dflt.undo} disabled={busy}>
              Undo
            </Button>
          )}
          {defaultNote && (
            <button
              type="button"
              className="inline-flex min-h-11 items-center px-1 text-xs font-medium text-brand-600 underline"
              aria-label="Dismiss the default order unit message"
              onClick={dflt.dismiss}
            >
              Dismiss
            </button>
          )}
        </div>

        {list.isLoading ? (
          <Skeleton shape="block" height={96} />
        ) : list.isError ? (
          <p className="text-sm text-navy/70">
            Couldn&apos;t load units.{" "}
            <button
              type="button"
              className="font-medium text-brand-600"
              onClick={() => list.refetch()}
            >
              Try again
            </button>
          </p>
        ) : units.length === 0 ? (
          <p className="text-sm text-navy/70">
            No other units yet.{" "}
            {addInShell
              ? "Use Add a unit above to sell this product in bigger (or smaller) steps."
              : "Add a Case or Pallet below to sell this product in bigger (or smaller) steps."}
          </p>
        ) : (
          <ul className="space-y-3">
            {units.map((u) =>
              ro ? (
                <UnitRowReadOnly key={u.id} unit={u} grid={grid} tierNames={tierNames} />
              ) : (
                <UnitRow
                  key={u.id}
                  unit={u}
                  product={product}
                  units={units}
                  tierNames={tierNames}
                  busy={busy}
                  onSave={save}
                  onDelete={setRemoving}
                  hideRemove={shellOwns && !gridQuery.isError && shellRemovesUnit(grid, u.id)}
                  figures={figureCtx}
                  onMakeDefault={dflt.change}
                />
              ),
            )}
          </ul>
        )}

        {!addInShell && !ro && (
          <form
            className="grid grid-cols-2 items-end gap-3 border-t border-surface-border pt-3 sm:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <div>
              <label className={LABEL} htmlFor="new-unit-name">
                New unit
              </label>
              <input
                id="new-unit-name"
                className={FIELD}
                placeholder="e.g. Case"
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="new-unit-factor">
                {w.base.other} per new unit
              </label>
              <DecimalInput
                id="new-unit-factor"
                className={FIELD}
                decimals={0}
                min={1}
                value={factor}
                onChange={setFactor}
              />
            </div>
            {!figures && (
              <div>
                <label className={LABEL} htmlFor="new-unit-price">
                  Price (optional)
                </label>
                <DecimalInput
                  id="new-unit-price"
                  className={FIELD}
                  value={price}
                  onChange={setPrice}
                />
              </div>
            )}
            <Button type="submit" disabled={busy || !name.trim() || !factor}>
              Add unit
            </Button>
          </form>
        )}
      </div>

      <ConfirmDialog
        open={removing != null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.label ?? "unit"}?`}
        description="Its prices are deleted. Existing orders and invoices keep what they charged."
        confirmLabel="Remove"
        loading={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          dflt.clearNote();
          remove.mutate(removing.id, {
            onSuccess: () => setRemoving(null),
            onError: () => setRemoving(null),
          });
        }}
      />

      <Modal
        open={proposals.length > 0}
        onClose={() => setProposals([])}
        title="Update the other unit prices too?"
        className="max-w-md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setProposals([])}>
              No, leave them
            </Button>
            <Button onClick={applyCascade}>Yes, update</Button>
          </>
        }
      >
        <ul className="space-y-1 text-sm text-navy">
          {proposals.map((p) => (
            <li key={p.unitId}>
              <span className="font-medium">{p.label}</span>
              <ul className="ml-3">
                {p.changes.map((c) => (
                  <li key={c.field}>
                    {productTierLabel(tierNames, c.tier)}:{" "}
                    <span className="font-mono tabular-nums">
                      {fmt(c.from)} → {fmt(c.to)}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
