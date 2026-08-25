"use client";

import * as React from "react";
import Link from "next/link";
import { Building2, Home, MapPin } from "lucide-react";
import { cn } from "@routeflow/ui/web";

export type TripOriginKind = "TENANT" | "DRIVER" | "ADDRESS";

export interface TripOriginAddress {
  line1: string;
  city: string;
  state: string;
  zip: string;
}

export interface TripOriginPickerProps {
  kind: TripOriginKind;
  onKindChange: (kind: TripOriginKind) => void;
  address: TripOriginAddress;
  onAddressChange: (address: TripOriginAddress) => void;
  /** Tenant's configured depot address (from useRouteSettings), when set. */
  depotAddress?: string | null;
  hasDepot: boolean;
  /** Currently selected driver's name (the driver picker sits above this component). */
  driverName?: string | null;
  hasDriver: boolean;
  /**
   * Whether the selected driver has geocoded home coords — `TripsService.resolveOrigin`
   * 400s without them, so a driver with an empty home base can't start a trip.
   */
  hasDriverHome?: boolean;
  /** Selected driver's profile URL, so the "no home base" option isn't a dead end. */
  driverHref?: string | null;
  className?: string;
}

interface OptionMeta {
  kind: TripOriginKind;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  disabled: boolean;
  disabledReason?: string;
  /** Rendered under a disabled option as the fix-it link (Design directive 4 — no dead ends). */
  disabledHref?: string | null;
}

/**
 * Three-way trip start-point picker (Design directive 9 — disabled options must
 * look disabled and explain why). TENANT/DRIVER disable + explain when their
 * prerequisite (a configured depot / a selected driver WITH a saved home base —
 * the latter also links to the driver profile) is missing; ADDRESS is
 * always available and reveals structured line1/city/state/zip fields — the
 * server geocodes on submit, no Maps JS is loaded here.
 */
export function TripOriginPicker({
  kind,
  onKindChange,
  address,
  onAddressChange,
  depotAddress,
  hasDepot,
  driverName,
  hasDriver,
  hasDriverHome = false,
  driverHref,
  className,
}: TripOriginPickerProps) {
  const options: OptionMeta[] = [
    {
      kind: "TENANT",
      icon: <Building2 className="h-4 w-4" />,
      title: "Tenant depot",
      subtitle: depotAddress || "Configured depot",
      disabled: !hasDepot,
      // Points at a control that exists: the depot is the tenant's business
      // address (Settings → Business profile). There is no depot field on the
      // route-settings screen.
      disabledReason: "Add your business address in Settings → Business profile",
    },
    {
      kind: "DRIVER",
      icon: <Home className="h-4 w-4" />,
      title: "Driver's home base",
      subtitle: driverName ? `${driverName}'s home address` : "Driver's saved home address",
      // A selected driver isn't enough: the server resolves this origin from
      // homeLat/homeLng, which only exist once someone fills in the home base on
      // the driver profile (Drivers → Edit → Home Base).
      disabled: !hasDriver || !hasDriverHome,
      disabledReason: !hasDriver
        ? "Select a driver above first"
        : `${driverName ?? "This driver"} has no home base set`,
      disabledHref: hasDriver && !hasDriverHome ? driverHref : null,
    },
    {
      kind: "ADDRESS",
      icon: <MapPin className="h-4 w-4" />,
      title: "Custom address",
      subtitle: "Enter a one-off start address for this trip",
      disabled: false,
    },
  ];

  return (
    <div className={cn("space-y-2", className)}>
      <label className="text-sm font-medium text-navy">Start from</label>
      <div className="space-y-2">
        {options.map((opt) => {
          const selected = kind === opt.kind;
          return (
            <div key={opt.kind}>
              <button
                type="button"
                onClick={() => !opt.disabled && onKindChange(opt.kind)}
                disabled={opt.disabled}
                title={opt.disabled ? opt.disabledReason : undefined}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
                  selected
                    ? "border-brand-500 bg-brand-50"
                    : "border-surface-border bg-white hover:border-brand-300",
                  opt.disabled && "cursor-not-allowed opacity-50 hover:border-surface-border",
                )}
              >
                <span
                  className={cn("mt-0.5 shrink-0", selected ? "text-brand-600" : "text-navy/70")}
                >
                  {opt.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-navy">{opt.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-navy/70">
                    {opt.disabled ? opt.disabledReason : opt.subtitle}
                  </span>
                </span>
              </button>

              {opt.disabled && opt.disabledHref && (
                <Link
                  href={opt.disabledHref}
                  className="mt-1 block pl-[38px] text-xs font-medium text-brand-600 hover:underline"
                >
                  Add a home address on their profile
                </Link>
              )}

              {selected && opt.kind === "ADDRESS" && (
                <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-surface-border bg-surface-raised p-3">
                  <input
                    value={address.line1}
                    onChange={(e) => onAddressChange({ ...address, line1: e.target.value })}
                    placeholder="Street address"
                    className="col-span-2 h-9 rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <input
                    value={address.city}
                    onChange={(e) => onAddressChange({ ...address, city: e.target.value })}
                    placeholder="City"
                    className="h-9 rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <input
                    value={address.state}
                    onChange={(e) => onAddressChange({ ...address, state: e.target.value })}
                    placeholder="State"
                    className="h-9 rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <input
                    value={address.zip}
                    onChange={(e) => onAddressChange({ ...address, zip: e.target.value })}
                    placeholder="ZIP"
                    className="col-span-2 h-9 rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <p className="col-span-2 text-[11px] text-navy/70">
                    We&apos;ll locate this address when the trip is built.
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
