"use client";

import * as React from "react";
import type { ProductUnitLevel } from "@routeflow/types";
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
    draft.prices.some((p, i) => p !== base.prices[i]);
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
        </div>
      </div>
      <p className="mt-1.5 text-[11px] text-navy/50">
        A grey figure is worked out automatically from the {w.pack.lower} price. Type a price to set
        it yourself, or clear it to go back to automatic.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-brand-600">Tier prices</summary>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[2, 3, 4, 5].map((t) => (
            <div key={t}>
              <label className={LABEL} htmlFor={`${idp}-t${t}`}>
                {productTierLabel(tierNames, t)}
              </label>
              <DecimalInput
                id={`${idp}-t${t}`}
                aria-label={`${unit.label} ${productTierLabel(tierNames, t)} price`}
                className={FIELD}
                value={draft.prices[t - 1]}
                placeholder={derived(t) != null ? fmt(derived(t) as number) : ""}
                onChange={(v) =>
                  setDraft({ ...draft, prices: draft.prices.map((p, i) => (i === t - 1 ? v : p)) })
                }
              />
            </div>
          ))}
        </div>
      </details>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-navy">
          <input
            type="radio"
            name="default-selling-unit"
            checked={unit.isDefaultSelling}
            onChange={() => onMakeDefault(unit)}
            disabled={busy}
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

export function ProductUnitsCard({
  product,
  hideAddForm = false,
}: {
  product: UnitsCardProduct;
  /**
   * K10d: the v2 shell has its own single "Add a unit", so the page passes the v2 flag and the always-open form
   * goes. A product the shell does not mount it on (family, recipe, variant) keeps this form.
   */
  hideAddForm?: boolean;
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

  // K10d: the same grid the v2 shell reads. Until it has rows the shell has no Add / Remove, so the old ones stay.
  const shellOwns = hideAddForm && !unitStructureGoverned(product);
  const gridQuery = usePriceGrid(product.id, enabled && shellOwns);
  const grid = gridQuery.data;
  if (!enabled) return null;
  const addInShell = shellOwns && shellHasUnitControls(grid);
  const units = list.data ?? [];
  const busy = create.isPending || update.isPending || remove.isPending;
  const tierNames = tiers;
  // B594: no component-level error toasts — app/providers.tsx's global MutationCache handler
  // already toasts the server's message for every failed mutation, so a second one here doubled it.

  // SA-810: the level saved, but its name was not added to the full unit list. Say so, once.
  const notListed = (saved: unknown) => {
    const notice = unitNotListedNotice(saved);
    if (notice) toast({ title: notice, variant: "info" });
  };

  const save = (unit: ProductUnitLevel, d: Draft) => {
    const oldPrices = draftOf(unit).prices;
    const newPrices = d.prices.map(priceOrNull);
    // Only a price the operator changed is sent (a draft price that still equals the value the row was seeded with is
    // left out): a v2 price save moves prices outside this card, so the row's snapshot is never written back.
    const dirtyPrice = (i: number) => d.prices[i] !== oldPrices[i];
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
        setProposals(proposeCascade(units, unit.id, oldPrices, newPrices));
      },
    });
  };

  const applyCascade = async () => {
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
    create.mutate(
      { label: name.trim(), factorToBase: factor, price: priceOrNull(price) },
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
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="border-b border-surface-border px-5 py-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Units &amp; prices
        </h3>
      </div>
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-raised px-3 py-2.5 text-sm">
          <span className="text-navy">
            <span className="font-medium">{product.unit || w.pack.one}</span>{" "}
            <span className="text-navy/60">
              · {packPieces} {w.baseFor(packPieces)} · the {w.pack.lower} (edit its price above)
            </span>
          </span>
          <span className="flex items-center gap-4">
            <span className="font-mono tabular-nums text-navy">
              {fmt(Number(product.pricePerUnit) || 0)}
            </span>
            <label className="flex items-center gap-2 text-navy">
              <input
                type="radio"
                name="default-selling-unit"
                checked={noneDefault}
                disabled={busy || noneDefault}
                onChange={() => {
                  const current = units.find((u) => u.isDefaultSelling);
                  if (current) {
                    update.mutate({ id: current.id, isDefaultSelling: false });
                  }
                }}
              />
              Default order unit
            </label>
          </span>
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
            {units.map((u) => (
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
                onMakeDefault={(x) => update.mutate({ id: x.id, isDefaultSelling: true })}
              />
            ))}
          </ul>
        )}

        {!addInShell && (
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
