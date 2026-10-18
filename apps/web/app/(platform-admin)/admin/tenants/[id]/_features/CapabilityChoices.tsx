"use client";

import * as React from "react";
import type {
  CapabilityPresetKey,
  CapabilityPresetSummary,
} from "@/lib/platform-admin/capabilities-contract";
import {
  CAPABILITY_LABELS,
  setDoorPayments,
  setOpensAs,
  ticksFromPreset,
  toggleCapability,
  type CapabilityBox,
  type CapabilityTicks,
} from "./capability-ticks";
import { opensAsChoosableFor } from "./opens-as";
import { profilePlainCopy } from "./profile-plain-copy";

export interface CapabilityChoicesProps {
  ticks: CapabilityTicks;
  onChange: (next: CapabilityTicks) => void;
  /** The presets "Start from…" lists; none = no menu button. A preset only ever pre-ticks. */
  presets: readonly CapabilityPresetSummary[];
  /** The server's `matchedPreset`: the ONLY thing that earns the "Current" mark. Never follows unsaved ticks. */
  matchedPreset?: CapabilityPresetKey | null;
  /** Unique per screen: prefixes every id and the radio group's name. */
  idPrefix: string;
  /** While a write is in flight (or the form is submitting). */
  disabled?: boolean;
  legend?: string;
  /** A capability the plan excludes, with the plan's name: shown disabled as "Not on the {Plan} plan.". */
  excluded?: Partial<Record<CapabilityBox, string>>;
}

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";

/**
 * What this business does: three checkboxes (Delivers on own trucks with its door-payments sub-option, Ships by
 * carrier, Sells at the counter), the "New staff orders open as" choice, and a "Start from…" menu of presets that only
 * pre-ticks. Controlled and shared by the tenant's Setup tab and the create-tenant form. It holds no server shape and
 * derives no mode: what the ticks mean is the preview's job.
 */
export function CapabilityChoices({
  ticks,
  onChange,
  presets,
  matchedPreset = null,
  idPrefix,
  disabled,
  legend = "What this business does",
  excluded,
}: CapabilityChoicesProps) {
  const id = (part: string) => `${idPrefix}-${part}`;
  const choosable = opensAsChoosableFor(ticks);
  const showOpensAs = ticks.counter && (ticks.delivery || ticks.shipping);
  const doorReasonId = id("door-reason");
  const opensReasonId = id("opens-reason");

  return (
    <div className="flex flex-col gap-3">
      {presets.length > 0 && (
        <StartFromMenu
          idPrefix={idPrefix}
          presets={presets}
          matchedPreset={matchedPreset}
          disabled={disabled}
          onPick={(preset) => onChange(ticksFromPreset(preset.ticks))}
        />
      )}

      <fieldset
        tabIndex={-1}
        data-focus-target="capabilities"
        disabled={disabled}
        className="flex flex-col gap-1 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400"
      >
        <legend className="mb-1 text-sm font-medium text-slate-300">{legend}</legend>

        <CheckRow
          id={id("delivery")}
          label={CAPABILITY_LABELS.delivery}
          checked={ticks.delivery}
          excludedPlan={excluded?.delivery}
          onChange={(on) => onChange(toggleCapability(ticks, "delivery", on))}
        />
        <div
          role="group"
          aria-labelledby={`${id("delivery")}-label`}
          className="ml-7 border-l border-slate-600 pl-4"
        >
          <CheckRow
            id={id("door")}
            label={CAPABILITY_LABELS.doorPayments}
            checked={ticks.delivery && ticks.doorPayments}
            disabled={!ticks.delivery}
            reason={!ticks.delivery ? "Turn on delivery first." : undefined}
            reasonId={doorReasonId}
            onChange={(on) => onChange(setDoorPayments(ticks, on))}
          />
        </div>

        <CheckRow
          id={id("shipping")}
          label={CAPABILITY_LABELS.shipping}
          checked={ticks.shipping}
          excludedPlan={excluded?.shipping}
          onChange={(on) => onChange(toggleCapability(ticks, "shipping", on))}
        />
        <CheckRow
          id={id("counter")}
          label={CAPABILITY_LABELS.counter}
          checked={ticks.counter}
          excludedPlan={excluded?.counter}
          focusTarget="counter"
          onChange={(on) => onChange(toggleCapability(ticks, "counter", on))}
        />

        {showOpensAs && (
          <>
            <hr className="my-2 border-slate-700" />
            <div
              role="radiogroup"
              aria-labelledby={id("opens-label")}
              aria-describedby={choosable ? undefined : opensReasonId}
            >
              <p id={id("opens-label")} className="mb-1 text-sm font-medium text-slate-300">
                New staff orders open as
              </p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["order", "Order"],
                    ["counter", "Counter sale"],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className={`flex min-h-[44px] items-center gap-2 rounded-lg px-3 py-2 text-sm ring-1 ring-white/10 ${
                      choosable ? "cursor-pointer text-white" : "cursor-not-allowed text-slate-400"
                    }`}
                  >
                    <input
                      type="radio"
                      name={id("opens-as")}
                      value={value}
                      checked={(choosable ? ticks.opensAs : "order") === value}
                      disabled={!choosable}
                      onChange={() => onChange(setOpensAs(ticks, value))}
                      className="h-5 w-5 shrink-0 accent-indigo-500"
                    />
                    {label}
                  </label>
                ))}
              </div>
              {!choosable && (
                <p id={opensReasonId} className="mt-1 text-xs text-slate-400">
                  Delivery orders always open as orders.
                </p>
              )}
            </div>
          </>
        )}
      </fieldset>
    </div>
  );
}

function CheckRow({
  id,
  label,
  checked,
  disabled,
  reason,
  reasonId,
  excludedPlan,
  focusTarget,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  /** Why the box is off, as visible text tied to the input by aria-describedby. */
  reason?: string;
  reasonId?: string;
  excludedPlan?: string;
  focusTarget?: string;
  onChange: (on: boolean) => void;
}) {
  const excludedId = `${id}-plan`;
  const why = excludedPlan ? `Not on the ${excludedPlan} plan.` : reason;
  const whyId = excludedPlan ? excludedId : reasonId;
  const off = disabled || !!excludedPlan;
  return (
    <div>
      <label
        htmlFor={id}
        className={`flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 py-2 ring-1 ring-white/10 ${
          checked ? "bg-indigo-900/30" : "bg-slate-900/40"
        } ${off ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:ring-slate-500"}`}
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={off}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={why ? whyId : undefined}
          data-focus-target={focusTarget}
          className="h-5 w-5 shrink-0 accent-indigo-500"
        />
        <span id={`${id}-label`} className="text-sm font-medium text-white">
          {label}
        </span>
      </label>
      {why && (
        <p id={whyId} className="mt-1 pl-3 text-xs text-slate-400">
          {why}
        </p>
      )}
    </div>
  );
}

function StartFromMenu({
  idPrefix,
  presets,
  matchedPreset,
  disabled,
  onPick,
}: {
  idPrefix: string;
  presets: readonly CapabilityPresetSummary[];
  matchedPreset: CapabilityPresetKey | null;
  disabled?: boolean;
  onPick: (preset: CapabilityPresetSummary) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = `${idPrefix}-presets`;

  React.useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const outside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    const items = itemRefs.current.filter((i): i is HTMLButtonElement => !!i);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`flex min-h-[44px] items-center rounded-lg px-4 text-sm font-medium text-slate-200 ring-1 ring-white/15 hover:bg-slate-700 disabled:opacity-50 ${FOCUS_RING}`}
      >
        Start from…
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Start from a preset"
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 right-0 z-20 mt-1 flex max-h-[60vh] flex-col gap-1 overflow-y-auto rounded-xl bg-slate-800 p-2 shadow-2xl ring-1 ring-white/10 sm:right-auto sm:w-96"
        >
          {presets.map((p, i) => {
            const copy = profilePlainCopy(p.key, p.label, p.description);
            const current = matchedPreset === p.key;
            const unavailable = !p.available;
            const lineId = `${idPrefix}-preset-${p.key}-line`;
            return (
              <button
                key={p.key}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-label={current ? `${copy.name}, current setup` : copy.name}
                aria-describedby={lineId}
                aria-disabled={unavailable || undefined}
                onClick={() => {
                  if (unavailable) return;
                  onPick(p);
                  close(true);
                }}
                className={`flex min-h-[44px] w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-slate-700 ${FOCUS_RING} ${
                  unavailable ? "cursor-not-allowed opacity-60" : ""
                }`}
              >
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
                  {copy.name}
                  {current && (
                    <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-medium text-slate-200">
                      Current
                    </span>
                  )}
                </span>
                <span id={lineId} className="text-xs text-slate-400">
                  {unavailable ? "Not available for this tenant." : copy.line}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
