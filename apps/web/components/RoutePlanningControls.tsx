"use client";

import * as React from "react";
import { Building2, Clock, Home, MapPin, Navigation, Ruler } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import type { RouteOptimizeMetric } from "@/lib/api/routes";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoutePlanningOriginKind = "TENANT" | "DRIVER" | "ADDRESS";
export type TripEndType = "NONE" | "RETURN_TO_START" | "DRIVER_HOME" | "ADDRESS";

export interface RoutePlanningAddress {
  line1: string;
  city: string;
  state: string;
  zip: string;
}

export const EMPTY_PLANNING_ADDRESS: RoutePlanningAddress = {
  line1: "",
  city: "",
  state: "",
  zip: "",
};

/** Everything the picker needs about the tenant depot / selected driver that
 *  it can't derive itself — the driver picker itself lives above this
 *  component on the page. */
export interface RoutePlanningOriginSummary {
  /** Tenant's configured depot address (from useRouteSettings), when set. */
  depotAddress?: string | null;
  hasDepot: boolean;
  /** Currently selected driver's name (the driver picker sits above this component). */
  driverName?: string | null;
  hasDriver: boolean;
  /** Whether the selected driver has geocoded home coords — resolveOrigin/
   *  resolveEnd 400 without them. */
  hasDriverHome?: boolean;
  /** Selected driver's profile URL, so "no home base" isn't a dead end. */
  driverHref?: string | null;
}

export interface TripEndDraft {
  type: TripEndType;
  /** DRIVER_HOME — undefined means "use this route's assigned driver". */
  driverId?: string;
  /** ADDRESS */
  address: RoutePlanningAddress;
}

export const EMPTY_END_DRAFT: TripEndDraft = { type: "NONE", address: EMPTY_PLANNING_ADDRESS };

export interface RoutePlanningValue {
  originKind: RoutePlanningOriginKind;
  /** ADDRESS origin only. */
  originAddress: RoutePlanningAddress;
  originSummary: RoutePlanningOriginSummary;
  end: TripEndDraft;
  avoidTolls: boolean;
  optimizeBy: RouteOptimizeMetric;
}

export interface RoutePlanningDriverOption {
  id: string;
  name: string;
  hasHome: boolean;
}

export interface RoutePlanningControlsProps {
  value: RoutePlanningValue;
  onChange: (value: RoutePlanningValue) => void;
  /** Candidate drivers for the "End at driver's home" option — the origin's
   *  driver is chosen elsewhere on the page (see `originSummary`); this list
   *  lets the end point target a *different* driver's home when needed. */
  drivers?: RoutePlanningDriverOption[];
  disabled?: boolean;
  className?: string;
}

// ─── Small shared bits ─────────────────────────────────────────────────────────

/** Same role="switch" idiom as settings' MiniSwitch, inlined here to avoid a
 *  cross-page import (no shared Switch primitive exists in packages/ui yet). */
function PlanningSwitch({
  checked,
  disabled,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-brand-500" : "bg-navy/20",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

const addressInputClass =
  "h-9 rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500";

/** One radio-style option card: selected = brand border/tint, disabled =
 *  dimmed with a reason, expanding detail panel when selected. */
function OptionCard({
  icon,
  title,
  subtitle,
  selected,
  disabled,
  disabledReason,
  onSelect,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  selected: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={() => !disabled && onSelect()}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
          selected
            ? "border-brand-500 bg-brand-50"
            : "border-surface-border bg-white hover:border-brand-300",
          disabled && "cursor-not-allowed opacity-50 hover:border-surface-border",
        )}
      >
        <span className={cn("mt-0.5 shrink-0", selected ? "text-brand-600" : "text-navy/70")}>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-navy">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-navy/70">
            {disabled ? disabledReason : subtitle}
          </span>
        </span>
      </button>
      {selected && children && (
        <div className="mt-2 space-y-2 rounded-lg border border-surface-border bg-surface-raised p-3">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

/**
 * Controlled start/end/tolls/objective planning controls, shared by the
 * ad-hoc trip builder, the scheduled route builder, and route-detail editing.
 * Presentational only — callers own `value` and persist it (via
 * `useCreateTrip`/`useUpdateRoutePlanning`/route-create) on their own cadence.
 */
export function RoutePlanningControls({
  value,
  onChange,
  drivers = [],
  disabled,
  className,
}: RoutePlanningControlsProps) {
  const { originKind, originAddress, originSummary, end, avoidTolls, optimizeBy } = value;

  const patch = (partial: Partial<RoutePlanningValue>) => onChange({ ...value, ...partial });

  return (
    <div className={cn("space-y-5", className)}>
      {/* ── Start ────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-navy">Start from</label>
        <div className="space-y-2">
          <OptionCard
            icon={<Building2 className="h-4 w-4" />}
            title="Tenant depot"
            subtitle={originSummary.depotAddress || "Configured depot"}
            selected={originKind === "TENANT"}
            disabled={!originSummary.hasDepot || disabled}
            disabledReason="Add your business address in Settings → Business profile"
            onSelect={() => patch({ originKind: "TENANT" })}
          />
          <OptionCard
            icon={<Home className="h-4 w-4" />}
            title="Driver's home base"
            subtitle={
              originSummary.driverName
                ? `${originSummary.driverName}'s home address`
                : "Driver's saved home address"
            }
            selected={originKind === "DRIVER"}
            disabled={!originSummary.hasDriver || !originSummary.hasDriverHome || disabled}
            disabledReason={
              !originSummary.hasDriver
                ? "Select a driver above first"
                : `${originSummary.driverName ?? "This driver"} has no home base set`
            }
            onSelect={() => patch({ originKind: "DRIVER" })}
          />
          <OptionCard
            icon={<MapPin className="h-4 w-4" />}
            title="Custom address"
            subtitle="Enter a one-off start address for this route"
            selected={originKind === "ADDRESS"}
            disabled={disabled}
            onSelect={() => patch({ originKind: "ADDRESS" })}
          >
            <AddressAutocomplete
              label="Street address"
              value={originAddress.line1}
              onChange={(v) => patch({ originAddress: { ...originAddress, line1: v } })}
              onAddressSelect={(parts) =>
                patch({
                  originAddress: {
                    line1: parts.street || originAddress.line1,
                    city: parts.city,
                    state: parts.state,
                    zip: parts.zip,
                  },
                })
              }
              disabled={disabled}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={originAddress.city}
                onChange={(e) =>
                  patch({ originAddress: { ...originAddress, city: e.target.value } })
                }
                placeholder="City"
                disabled={disabled}
                className={addressInputClass}
              />
              <input
                value={originAddress.state}
                onChange={(e) =>
                  patch({ originAddress: { ...originAddress, state: e.target.value } })
                }
                placeholder="State"
                disabled={disabled}
                className={addressInputClass}
              />
            </div>
            <input
              value={originAddress.zip}
              onChange={(e) => patch({ originAddress: { ...originAddress, zip: e.target.value } })}
              placeholder="ZIP"
              disabled={disabled}
              className={cn(addressInputClass, "w-full")}
            />
          </OptionCard>
        </div>
      </div>

      {/* ── End ──────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-navy">End at</label>
        <div className="space-y-2">
          <OptionCard
            icon={<MapPin className="h-4 w-4" />}
            title="Last stop"
            subtitle="No return trip"
            selected={end.type === "NONE"}
            disabled={disabled}
            onSelect={() => patch({ end: { ...end, type: "NONE" } })}
          />
          <OptionCard
            icon={<Navigation className="h-4 w-4" />}
            title="Return to start"
            subtitle="Back to the same point the route started from"
            selected={end.type === "RETURN_TO_START"}
            disabled={disabled}
            onSelect={() => patch({ end: { ...end, type: "RETURN_TO_START" } })}
          />
          <OptionCard
            icon={<Home className="h-4 w-4" />}
            title="Driver's home"
            subtitle="End at a driver's saved home address"
            selected={end.type === "DRIVER_HOME"}
            disabled={disabled}
            onSelect={() => patch({ end: { ...end, type: "DRIVER_HOME" } })}
          >
            {drivers.length > 0 ? (
              <div>
                <label
                  htmlFor="route-planning-end-driver"
                  className="mb-1 block text-xs font-medium text-navy/70"
                >
                  Whose home base?
                </label>
                <select
                  id="route-planning-end-driver"
                  value={end.driverId ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    patch({ end: { ...end, driverId: e.target.value || undefined } })
                  }
                  className={cn(addressInputClass, "w-full")}
                >
                  <option value="">This route&apos;s assigned driver</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id} disabled={!d.hasHome}>
                      {d.name}
                      {!d.hasHome ? " (no home address set)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="text-xs text-navy/70">Uses this route&apos;s assigned driver.</p>
            )}
          </OptionCard>
          <OptionCard
            icon={<MapPin className="h-4 w-4" />}
            title="Custom address"
            subtitle="Enter a one-off end address for this route"
            selected={end.type === "ADDRESS"}
            disabled={disabled}
            onSelect={() => patch({ end: { ...end, type: "ADDRESS" } })}
          >
            <AddressAutocomplete
              label="Street address"
              value={end.address.line1}
              onChange={(v) => patch({ end: { ...end, address: { ...end.address, line1: v } } })}
              onAddressSelect={(parts) =>
                patch({
                  end: {
                    ...end,
                    address: {
                      line1: parts.street || end.address.line1,
                      city: parts.city,
                      state: parts.state,
                      zip: parts.zip,
                    },
                  },
                })
              }
              disabled={disabled}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={end.address.city}
                onChange={(e) =>
                  patch({ end: { ...end, address: { ...end.address, city: e.target.value } } })
                }
                placeholder="City"
                disabled={disabled}
                className={addressInputClass}
              />
              <input
                value={end.address.state}
                onChange={(e) =>
                  patch({ end: { ...end, address: { ...end.address, state: e.target.value } } })
                }
                placeholder="State"
                disabled={disabled}
                className={addressInputClass}
              />
            </div>
            <input
              value={end.address.zip}
              onChange={(e) =>
                patch({ end: { ...end, address: { ...end.address, zip: e.target.value } } })
              }
              placeholder="ZIP"
              disabled={disabled}
              className={cn(addressInputClass, "w-full")}
            />
          </OptionCard>
        </div>
      </div>

      {/* ── Tolls + objective ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-6 rounded-lg border border-surface-border bg-white p-3">
        <div className="flex items-center gap-2">
          <PlanningSwitch
            checked={avoidTolls}
            disabled={disabled}
            onToggle={() => patch({ avoidTolls: !avoidTolls })}
            ariaLabel={avoidTolls ? "Allow tolls" : "Avoid tolls"}
          />
          <span className="text-sm text-navy">Avoid tolls</span>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-surface-border bg-surface-raised p-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => patch({ optimizeBy: "TIME" })}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              optimizeBy === "TIME" ? "bg-white text-brand-700 shadow-sm" : "text-navy/70",
            )}
          >
            <Clock className="h-3.5 w-3.5" />
            Fastest time
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => patch({ optimizeBy: "DISTANCE" })}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              optimizeBy === "DISTANCE" ? "bg-white text-brand-700 shadow-sm" : "text-navy/70",
            )}
          >
            <Ruler className="h-3.5 w-3.5" />
            Shortest distance
          </button>
        </div>
      </div>
    </div>
  );
}
