"use client";

import * as React from "react";
import {
  PRICE_TIERS,
  planPriceChange,
  type LadderView,
  type PriceChange,
  type PricePlan,
} from "@routeflow/pricing";
import { Button } from "@routeflow/ui/web";
import { formatMoney } from "@/lib/format";
import { usePriceDraft, type PriceDraft } from "../edit/usePriceDraft";
import { PLAN_TESTIDS as T } from "./plan-testids";
import { PlanView } from "./PlanView";
import { foldPlan, parseAmount, usePlanSelection } from "./selection";
import { usePlanNames } from "./usePlanNames";

// S12b: "Change prices". Every price shown is planPriceChange's PricePlan. The customer opt-in is an unticked offer
// (SA-798 c, V03), Apply sits in a footer below the preview, in normal flow (V05, F02), and folds the plan into the
// shared draft: Save is the commit.

const FIELD =
  "h-[34px] rounded-ctl border border-line-strong bg-paper px-2.5 text-[13px] text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const LBL = "text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70";
// P13: the fill follows the state, never `peer-checked:` (a later label is a sibling of the checked radio before it, so
// both halves filled). Each half is outlined; the chosen one is filled.
const SEG =
  "flex-1 basis-0 cursor-pointer select-none border px-3 py-1.5 text-center text-[13px] peer-focus-visible:ring-2 peer-focus-visible:ring-accent";
const SEG_ON = "border-accent-strong bg-accent-strong text-white";
const SEG_OFF = "border-line-strong bg-paper text-navy";
const NO_CHANGES = {
  patches: [],
  undo: [],
  followers: [],
  offers: [],
  customerChanges: [],
  changes: [],
  problems: [],
};

type Mode = PriceChange["mode"];

/** Waits for the grid: the draft has no ladder view until it loads. */
export function ChangePricesPanel({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  /** Closes the panel after Apply (K11-15: focus goes to Save); without it Apply closes like Cancel. */
  onApplied?: () => void;
}) {
  const draft = usePriceDraft();
  return draft.view ? (
    <ChangePricesForm draft={draft} view={draft.view} onClose={onClose} onApplied={onApplied} />
  ) : null;
}

function ChangePricesForm({
  draft,
  view,
  onClose,
  onApplied,
}: {
  draft: PriceDraft;
  view: LadderView;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const { grid } = draft;
  const { tierName, customerName, customers, rules, customersTruncated } = usePlanNames();
  const ids = React.useId();
  const root = React.useRef<HTMLElement>(null);
  const { selection, toggleOffer, toggleKeep, toggleCustomerKeep, reset } = usePlanSelection();
  const [form, setForm] = React.useState<PriceChange>({
    unit: view.anchor,
    direction: "raise",
    mode: "percent",
    value: 0,
    also: false,
  });
  const [typed, setTyped] = React.useState("");
  const [blurred, setBlurred] = React.useState(false);
  const { unit, direction, mode, also } = form;
  const value = parseAmount(typed);

  // Ticks never carry onto a new plan (a new view, customers or revision is a new plan), nor onto a new question.
  React.useEffect(() => reset(), [reset, view, customers, rules, grid?.revision]);
  React.useEffect(() => root.current?.focus(), []);
  const change = (p: Partial<PriceChange>, text?: string) => {
    setForm((f) => ({ ...f, ...p }));
    if (text !== undefined) {
      setTyped(text);
      setBlurred(false);
    }
    reset();
  };

  // A refusal for "0" is not shown while the owner may still be typing "0.5": it waits for a value above zero or a blur.
  const plan: PricePlan | null = React.useMemo(
    () =>
      typed.trim() === "" || !(value > 0 || blurred)
        ? null
        : planPriceChange(view, { ...form, value }, rules, tierName, { customers }),
    [view, form, typed, value, blurred, rules, tierName, customers],
  );
  const canApply = plan != null && plan.problems.length === 0 && plan.changes.length > 0;
  const setCells = view.rows.flatMap((r) =>
    PRICE_TIERS.flatMap((t) =>
      r.set[t - 1] != null && !(r.ref === unit && t === 1)
        ? [`${r.label} ${tierName(t)} ${formatMoney(r.set[t - 1])}`]
        : [],
    ),
  );

  const apply = () => {
    if (!plan || !canApply) return;
    const folded = foldPlan(plan, selection);
    // The re-planner lets the customer offer follow the customers' prices if they change before Save (K3b).
    const how = mode === "percent" ? `${value}%` : formatMoney(value);
    const lead = `${view.rows.find((r) => r.ref === unit)?.label ?? unit} ${direction === "raise" ? "raised" : "lowered"} ${how}`;
    draft.applyPlan(
      folded.plan,
      (cs) => planPriceChange(view, { ...form, value }, rules, tierName, { customers: cs }),
      lead,
    );
    if (folded.customerTicked) draft.setOfferTicked(0, true);
    folded.customerKeeps.forEach((m) => draft.keepCustomer(m));
    reset();
    setTyped("");
    setForm((f) => ({ ...f, also: false }));
    (onApplied ?? onClose)();
  };

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
            Also {direction} the prices you set
            <span className="block text-xs text-ink-500">
              {new Intl.ListFormat("en").format(setCells)}
              {mode === "percent" && value > 0 ? `, by ${value}%.` : "."}
            </span>
          </span>
        </label>
      ) : (
        <p className="text-xs text-ink-500">Every other price is Auto and follows on its own.</p>
      )}
    </div>
  );

  return (
    <section
      id="change-panel"
      ref={root}
      tabIndex={-1}
      data-testid={T.changePanel}
      role="region"
      aria-labelledby={`${ids}-title`}
      className="rounded-lg border border-surface-border bg-white p-4 focus-visible:outline-none"
    >
      <h3 id={`${ids}-title`} className={LBL}>
        Change prices
      </h3>
      <p className="mt-1 text-sm text-ink-500">Pick one unit and say how much to move it.</p>
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
          <div role="radiogroup" aria-labelledby={`${ids}-dir`} className="flex">
            {(["raise", "lower"] as const).map((d) => (
              <span
                key={d}
                className="flex flex-1 basis-0 first:*:rounded-l-ctl last:*:rounded-r-ctl [&:not(:first-child)]:-ml-px"
              >
                <input
                  type="radio"
                  name={`${ids}-dir`}
                  id={`${ids}-${d}`}
                  className="peer sr-only"
                  checked={direction === d}
                  onChange={() => change({ direction: d })}
                />
                <label
                  htmlFor={`${ids}-${d}`}
                  className={`${SEG} ${direction === d ? SEG_ON : SEG_OFF}`}
                >
                  {d === "raise" ? "Raise" : "Lower"}
                </label>
              </span>
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
            onBlur={() => setBlurred(true)}
          />,
          mode === "percent"
            ? "Other units that move change by the same percent."
            : `Per ${view.rows.find((r) => r.ref === unit)?.label ?? "unit"}. Other units that move change in proportion to what they contain.`,
        )}
      </div>
      <div className="mt-4">
        <PlanView
          plan={plan ?? { ...NO_CHANGES, view }}
          selection={selection}
          onToggleOffer={toggleOffer}
          onToggleKeep={toggleKeep}
          onToggleCustomerKeep={toggleCustomerKeep}
          tierName={tierName}
          customerName={customerName}
          hideFollowers
          customersTruncated={customersTruncated}
          extraOffers={alsoBlock}
        />
      </div>
      <div data-testid={T.changePreview} className="mt-4">
        {plan == null ? (
          <p className="text-sm text-ink-500">Enter an amount above zero to see the new prices.</p>
        ) : (
          plan.changes.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[300px] text-sm">
                  <caption className="sr-only">Old and new prices for every unit and tier</caption>
                  <tbody>
                    {plan.changes.map((c) => (
                      <tr key={`${c.ref}|${c.tier}`} className="border-t border-surface-border">
                        <th scope="row" className="py-1 text-left font-normal text-navy">
                          {tierName(c.tier)} {c.label}
                        </th>
                        <td className="tabular-nums text-ink-500">{formatMoney(c.from)}</td>
                        <td className="tabular-nums font-medium text-navy">{formatMoney(c.to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-500">
                {plan.changes.length} price{plan.changes.length === 1 ? "" : "s"} will change.
              </p>
            </>
          )
        )}
      </div>
      <div
        data-testid={T.changeFooter}
        className="mt-4 flex gap-2 border-t border-surface-border bg-white py-2.5"
      >
        <Button id="ch-apply" type="button" disabled={!canApply} onClick={apply}>
          Apply
        </Button>
        <Button id="ch-cancel" variant="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
