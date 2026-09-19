"use client";

import * as React from "react";
import type { ProductUnitLevel } from "@routeflow/types";
import { resolveUnitPrice, type LadderProduct } from "@routeflow/pricing";
import { Button, Modal, Skeleton, useToast } from "@routeflow/ui/web";
import { DecimalInput } from "@/components/MoneyInput";
import { fmt } from "@/lib/formatting";
import { useTierLabels } from "@/lib/api/tier-labels";
import { tierLabel } from "@/lib/tier-label";
import {
  useCreateProductUnit,
  useDeleteProductUnit,
  useProductUnits,
  useUnitsEnabled,
  useUpdateProductUnit,
} from "@/lib/api/product-units";
import { proposeCascade, type CascadeProposal } from "@/lib/unit-cascade";

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
}

const num = (v: string | number | null | undefined): number | null =>
  v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;

const errText = (e: unknown): string =>
  String(
    (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message ??
      "Check the fields and try again.",
  );

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
}: {
  unit: ProductUnitLevel;
  product: UnitsCardProduct;
  units: ProductUnitLevel[];
  tierNames: Record<string, string> | undefined;
  busy: boolean;
  onSave: (unit: ProductUnitLevel, draft: Draft) => void;
  onDelete: (unit: ProductUnitLevel) => void;
  onMakeDefault: (unit: ProductUnitLevel) => void;
}) {
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(unit));
  React.useEffect(() => setDraft(draftOf(unit)), [unit]);
  const base = draftOf(unit);
  const dirty =
    draft.label !== base.label ||
    draft.factor !== base.factor ||
    draft.prices.some((p, i) => p !== base.prices[i]);
  const derived = (tier: number) => {
    try {
      return resolveUnitPrice(product, units, unit.label, tier);
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
            className={FIELD}
            value={draft.label}
            disabled={isPiece}
            maxLength={40}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`${idp}-factor`}>
            Pieces per unit
          </label>
          <DecimalInput
            id={`${idp}-factor`}
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
            className={FIELD}
            value={draft.prices[0]}
            placeholder={derived(1) != null ? `${fmt(derived(1) as number)} (derived)` : ""}
            onChange={(v) =>
              setDraft({ ...draft, prices: draft.prices.map((p, i) => (i ? p : v)) })
            }
          />
        </div>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-brand-600">Tier prices</summary>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[2, 3, 4, 5].map((t) => (
            <div key={t}>
              <label className={LABEL} htmlFor={`${idp}-t${t}`}>
                {tierLabel(tierNames, t)}
              </label>
              <DecimalInput
                id={`${idp}-t${t}`}
                className={FIELD}
                value={draft.prices[t - 1]}
                placeholder={derived(t) != null ? `${fmt(derived(t) as number)} (derived)` : ""}
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
          Sells by default
        </label>
        <div className="flex gap-2">
          {dirty && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setDraft(base)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => onSave(unit, draft)} disabled={busy}>
                Save
              </Button>
            </>
          )}
          <Button size="sm" variant="secondary" onClick={() => onDelete(unit)} disabled={busy}>
            Remove
          </Button>
        </div>
      </div>
    </li>
  );
}

export function ProductUnitsCard({ product }: { product: UnitsCardProduct }) {
  const enabled = useUnitsEnabled();
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

  if (!enabled) return null;
  const units = list.data ?? [];
  const busy = create.isPending || update.isPending || remove.isPending;
  const tierNames = tiers;
  const fail = (title: string) => (e: unknown) =>
    toast({ title, description: errText(e), variant: "error" });

  const save = (unit: ProductUnitLevel, d: Draft) => {
    const oldPrice = num(unit.price);
    const body = {
      id: unit.id,
      label: d.label.trim(),
      factorToBase: d.factor ?? unit.factorToBase,
      price: d.prices[0],
      priceTier2: d.prices[1],
      priceTier3: d.prices[2],
      priceTier4: d.prices[3],
      priceTier5: d.prices[4],
    };
    update.mutate(body, {
      onSuccess: () => setProposals(proposeCascade(units, unit.id, oldPrice, d.prices[0])),
      onError: fail("Couldn't save the unit"),
    });
  };

  const applyCascade = async () => {
    const todo = proposals;
    setProposals([]);
    try {
      for (const p of todo) await update.mutateAsync({ id: p.unitId, price: p.to });
      toast({ title: "Other unit prices updated", variant: "success" });
    } catch (e) {
      fail("Couldn't update the other units")(e);
    }
  };

  const add = () => {
    if (!name.trim() || !factor) return;
    create.mutate(
      { label: name.trim(), factorToBase: factor, price },
      {
        onSuccess: () => {
          setName("");
          setFactor(null);
          setPrice(null);
        },
        onError: fail("Couldn't add the unit"),
      },
    );
  };

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
            <span className="font-medium">{product.unit || "Box"}</span>{" "}
            <span className="text-navy/60">
              · {packPieces} {packPieces === 1 ? "piece" : "pieces"} · the pack (edit its price
              above)
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
                    update.mutate(
                      { id: current.id, isDefaultSelling: false },
                      { onError: fail("Couldn't change the default") },
                    );
                  }
                }}
              />
              Sells by default
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
            No other units yet. Add a Case or Pallet below to sell this product in bigger (or
            smaller) steps.
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
                onDelete={(x) => remove.mutate(x.id, { onError: fail("Couldn't remove the unit") })}
                onMakeDefault={(x) =>
                  update.mutate(
                    { id: x.id, isDefaultSelling: true },
                    { onError: fail("Couldn't change the default") },
                  )
                }
              />
            ))}
          </ul>
        )}

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
              Pieces per unit
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
            <DecimalInput id="new-unit-price" className={FIELD} value={price} onChange={setPrice} />
          </div>
          <Button type="submit" disabled={busy || !name.trim() || !factor}>
            Add unit
          </Button>
        </form>
      </div>

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
              {p.label}:{" "}
              <span className="font-mono tabular-nums">
                {fmt(p.from)} → {fmt(p.to)}
              </span>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
