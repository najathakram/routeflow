"use client";

import * as React from "react";
import {
  PRICE_TIERS,
  planPriceChange,
  type CustomerPricingWithId,
  type LadderView,
  type PriceChange,
  type PricePlan,
  type PriceTier,
  type TierRules,
} from "@routeflow/pricing";
import { Button } from "@routeflow/ui/web";
import { formatMoney } from "@/lib/format";
import { usePricesV2Enabled } from "@/lib/api/units-v2";
import { AlsoUpdatePanel } from "./AlsoUpdatePanel";
import {
  STALE_MESSAGE,
  buildPricePlanWrite,
  isStaleRevision,
  useAlsoUpdateSelection,
  type PricePlanWrite,
} from "./selection";
import { usePricePlanSave } from "./usePricePlanSave";

export interface ChangePricesPanelProps {
  open: boolean;
  productId: string;
  /** The product's priceRevision when the grid loaded: the save's compare-and-set. */
  expectedRevision: number;
  onOpenChange: (open: boolean) => void;
  view: LadderView;
  rules?: TierRules;
  tierName?: (tier: PriceTier) => string;
  customers?: readonly CustomerPricingWithId[];
  customerName?: (customerId: string) => string;
  /** Edit mode: hand the write to the draft instead of the save hook. */
  onApply?: (write: PricePlanWrite) => void | Promise<void>;
  onApplied?: () => void;
  /** The save came back 409 LADDER_REVISION_STALE: reload the grid. */
  onStale?: () => void;
}

// S12b: "Change prices" behind flag.units_prices_v2. Every price shown is planPriceChange's PricePlan; the
// customer opt-in is an unticked offer (SA-798 c, V03) and Apply sits in a sticky footer (V05).

const defaultTierName = (t: PriceTier): string => (t === 1 ? "Retail" : `Tier ${t}`);
const FIELD =
  "h-[34px] rounded-ctl border border-line-strong bg-paper px-2.5 text-[13px] text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const LBL = "text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70";
const SEG =
  "flex-1 basis-0 cursor-pointer select-none px-3 py-1.5 text-center text-[13px] text-navy peer-checked:bg-accent-strong peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-accent";

const NO_CHANGES = {
  patches: [],
  undo: [],
  followers: [],
  offers: [],
  customerChanges: [],
  changes: [],
  problems: [],
};
const listAnd = (items: string[]) => new Intl.ListFormat("en").format(items);

type Direction = PriceChange["direction"];
type Mode = PriceChange["mode"];

export function ChangePricesPanel({
  open,
  productId,
  expectedRevision,
  onOpenChange,
  view,
  rules,
  tierName,
  customers,
  customerName,
  onApply,
  onApplied,
  onStale,
}: ChangePricesPanelProps) {
  const enabled = usePricesV2Enabled();
  const { save, isPending } = usePricePlanSave();
  const ids = React.useId();
  const { selection, toggleOffer, toggleKeep, toggleCustomerKeep, reset } =
    useAlsoUpdateSelection();
  const [form, setForm] = React.useState<PriceChange>({
    unit: view.anchor,
    direction: "raise",
    mode: "percent",
    value: 0,
    also: false,
  });
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const name = tierName ?? defaultTierName;
  const { unit, direction, mode, also } = form;

  // A new question gets a new plan, so nothing ticked for the old one carries over.
  const change = (p: Partial<PriceChange>, text?: string) => {
    setForm((f) => ({ ...f, ...p }));
    if (text !== undefined) setTyped(text);
    reset();
    setError(null);
  };

  const plan: PricePlan | null = React.useMemo(() => {
    if (!enabled || !open || typed.trim() === "") return null;
    const value = Number(typed.replace(/[$,%\s]/g, ""));
    return planPriceChange(view, { ...form, value }, rules, tierName, { customers });
  }, [enabled, open, view, form, typed, rules, tierName, customers]);

  if (!enabled || !open) return null;

  const verb = direction === "raise" ? "raise" : "lower";
  const unitRow = view.rows.find((r) => r.ref === unit);
  const setCells = view.rows.flatMap((r) =>
    PRICE_TIERS.flatMap((t) =>
      r.set[t - 1] != null && !(r.ref === unit && t === 1)
        ? [`${r.label} ${name(t)} ${formatMoney(r.set[t - 1])}`]
        : [],
    ),
  );
  const canApply = plan != null && plan.problems.length === 0 && plan.changes.length > 0;

  const apply = async () => {
    if (!plan || !canApply || busy) return;
    const write = buildPricePlanWrite(plan, selection, { productId, expectedRevision });
    setBusy(true);
    setError(null);
    try {
      await (onApply ?? save)(write);
      onApplied?.();
      onOpenChange(false);
    } catch (e) {
      if (isStaleRevision(e)) {
        setError(STALE_MESSAGE);
        onStale?.();
      } else setError(e instanceof Error ? e.message : "Could not change the prices.");
    } finally {
      setBusy(false);
    }
  };

  const alsoBlock = (
    <div className="py-1.5">
      {setCells.length > 0 ? (
        <label className="flex items-start gap-2 text-sm text-navy">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={also}
            onChange={(e) => change({ also: e.target.checked })}
          />
          <span>
            Also {verb} the prices you set
            <span className="block text-xs text-ink-500">
              {listAnd(setCells)}
              {mode === "percent" && typed.trim() !== "" ? `, by ${typed.trim()}%.` : "."}
            </span>
          </span>
        </label>
      ) : (
        <p className="text-xs text-ink-500">Every other price is Auto and follows on its own.</p>
      )}
    </div>
  );
  const field = (id: string, label: string, control: React.ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${ids}-${id}`} className={LBL}>
        {label}
      </label>
      {control}
      {hint && <span className="text-xs text-ink-500">{hint}</span>}
    </div>
  );
  const select = (id: string, v: string, on: (v: string) => void, opts: [string, string][]) => (
    <select id={`${ids}-${id}`} className={FIELD} value={v} onChange={(e) => on(e.target.value)}>
      {opts.map(([val, text]) => (
        <option key={val} value={val}>
          {text}
        </option>
      ))}
    </select>
  );

  return (
    <section
      id="change-panel"
      data-testid="change-prices-panel"
      role="region"
      aria-labelledby={`${ids}-title`}
      onKeyDown={(e) => e.key === "Escape" && onOpenChange(false)}
      className="rounded-lg border border-surface-border bg-white p-4"
    >
      <h3 id={`${ids}-title`} className={LBL}>
        Change prices
      </h3>
      <p className="mt-1 text-sm text-ink-500">
        Pick one unit and say how much to move it. You see every price before anything changes.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {field(
          "unit",
          "Unit",
          select(
            "unit",
            unit,
            (v) => change({ unit: v }),
            view.rows.map((r) => [r.ref, r.label]),
          ),
        )}
        <div className="flex flex-col gap-1">
          <span id={`${ids}-dir`} className={LBL}>
            Direction
          </span>
          <div
            role="radiogroup"
            aria-labelledby={`${ids}-dir`}
            className="flex overflow-hidden rounded-ctl border border-line-strong"
          >
            {(["raise", "lower"] as const).map((d) => (
              <React.Fragment key={d}>
                <input
                  type="radio"
                  name={`${ids}-dir`}
                  id={`${ids}-${d}`}
                  className="peer sr-only"
                  checked={direction === d}
                  onChange={() => change({ direction: d })}
                />
                <label htmlFor={`${ids}-${d}`} className={SEG}>
                  {d === "raise" ? "Raise" : "Lower"}
                </label>
              </React.Fragment>
            ))}
          </div>
        </div>
        {field(
          "by",
          "By",
          select("by", mode, (v) => change({ mode: v as Mode }), [
            ["percent", "A percent (%)"],
            ["amount", "An amount ($)"],
          ]),
        )}
        {field(
          "value",
          "Amount",
          <input
            id={`${ids}-value`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className={FIELD}
            value={typed}
            onChange={(e) => change({}, e.target.value)}
          />,
          mode === "percent"
            ? "Other units that move change by the same percent."
            : `Per ${unitRow?.label ?? "unit"}. Other units that move change in proportion to what they contain.`,
        )}
      </div>
      <div className="mt-4">
        <AlsoUpdatePanel
          plan={plan ?? { ...NO_CHANGES, view }}
          selection={selection}
          onToggleOffer={toggleOffer}
          onToggleKeep={toggleKeep}
          onToggleCustomerKeep={toggleCustomerKeep}
          tierName={tierName}
          customerName={customerName}
          hideFollowers
          extraOffers={alsoBlock}
        />
      </div>
      <div data-testid="change-prices-preview" className="mt-4">
        {plan == null ? (
          <p className="text-sm text-ink-500">Enter an amount above zero to see the new prices.</p>
        ) : (
          plan.changes.length > 0 && (
            <>
              <table className="w-full min-w-[300px] text-sm">
                <caption className="sr-only">Old and new prices for every unit and tier</caption>
                <tbody>
                  {plan.changes.map((c) => (
                    <tr key={`${c.ref}|${c.tier}`} className="border-t border-surface-border">
                      <th scope="row" className="py-1 text-left font-normal text-navy">
                        {name(c.tier)} {c.label}
                      </th>
                      <td className="tabular-nums text-ink-500">{formatMoney(c.from)}</td>
                      <td className="tabular-nums font-medium text-navy">{formatMoney(c.to)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-ink-500">
                {plan.changes.length} price{plan.changes.length === 1 ? "" : "s"} will change.
              </p>
            </>
          )
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div
        data-testid="change-prices-footer"
        className="sticky bottom-0 z-[2] mt-4 flex gap-2 border-t border-surface-border bg-white py-2.5"
        style={{ bottom: "var(--editbar-h, 0px)" }}
      >
        <Button
          id="ch-apply"
          type="button"
          disabled={!canApply || busy || isPending}
          onClick={apply}
        >
          Apply
        </Button>
        <Button
          id="ch-cancel"
          variant="secondary"
          type="button"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}
