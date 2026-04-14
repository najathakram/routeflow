"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { UseFormReturn } from "react-hook-form";
import { Plus, X, GripVertical, AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { Input, Select, Button, cn } from "@routeflow/ui/web";
import type { StopEntry, CustomerForMap } from "./page";

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CreateRouteLeftPanelProps {
  form: UseFormReturn<{ name: string; defaultDriverId?: string }>;
  driverOptions: { value: string; label: string }[];
  stops: StopEntry[];
  customers: CustomerForMap[];
  assignments: Record<string, { routeId: string; routeName: string }[]>;
  onAddStop: (customer: CustomerForMap) => void;
  onRemoveStop: (customerId: string) => void;
  onOptimize: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CreateRouteLeftPanel({
  form,
  driverOptions,
  stops,
  customers,
  assignments,
  onAddStop,
  onRemoveStop,
  onOptimize,
  onSubmit,
  isSubmitting,
}: CreateRouteLeftPanelProps) {
  const router = useRouter();
  const { register, formState: { errors } } = form;

  // ── Customer search ──
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [showDropdown, setShowDropdown] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(customerSearch), 300);
    return () => clearTimeout(t);
  }, [customerSearch]);

  const filteredCustomers = React.useMemo(() => {
    if (!debouncedSearch) return [];
    const q = debouncedSearch.toLowerCase();
    return customers
      .filter(
        (c) =>
          c.businessName?.toLowerCase().includes(q) ||
          c.contactName?.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [customers, debouncedSearch]);

  // Close dropdown when clicking outside
  const searchRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      noValidate
      className="flex flex-1 flex-col overflow-hidden"
    >
      {/* Route details */}
      <div className="shrink-0 border-b border-surface-border bg-white p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Route Name"
            placeholder="North Austin Loop"
            register={register("name")}
            error={errors.name?.message}
          />
          <Select
            label="Default Driver"
            placeholder="Select driver"
            options={driverOptions}
            register={register("defaultDriverId")}
            error={errors.defaultDriverId?.message}
          />
        </div>
      </div>

      {/* Stops header */}
      <div className="shrink-0 border-b border-surface-border bg-surface-raised px-4 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-navy/50">
          Stops ({stops.length})
        </p>
      </div>

      {/* Optimize button — shown when 2+ stops have geocoded coordinates */}
      {stops.filter((s) => s.lat != null && s.lng != null).length >= 2 && (
        <div className="shrink-0 border-b border-surface-border bg-white px-4 py-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            leftIcon={<Sparkles className="h-3.5 w-3.5" />}
            onClick={onOptimize}
            className="w-full"
          >
            Optimize Stop Order
          </Button>
        </div>
      )}

      {/* Customer search */}
      <div className="shrink-0 border-b border-surface-border bg-white px-4 py-3">
        <div className="relative" ref={searchRef}>
          <input
            type="search"
            placeholder="Search customers to add a stop…"
            value={customerSearch}
            onChange={(e) => {
              setCustomerSearch(e.target.value);
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {showDropdown && filteredCustomers.length > 0 && customerSearch && (
            <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-dropdown">
              {filteredCustomers.map((c) => {
                const isAdded = stops.some((s) => s.customerId === c.id);
                const routeAssigns = assignments[c.id];
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!isAdded) {
                          onAddStop(c);
                          setCustomerSearch("");
                          setDebouncedSearch("");
                          setShowDropdown(false);
                        }
                      }}
                      disabled={isAdded}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors",
                        isAdded
                          ? "cursor-not-allowed text-navy/30"
                          : "text-navy hover:bg-surface-raised",
                      )}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <span className="font-medium">{c.businessName}</span>
                        {c.contactName && (
                          <span className="ml-1.5 text-xs text-navy/50">{c.contactName}</span>
                        )}
                        {routeAssigns && routeAssigns.length > 0 && (
                          <p className="text-xs text-navy/40">
                            Also in: {routeAssigns.map((r) => r.routeName).join(", ")}
                          </p>
                        )}
                      </div>
                      {isAdded && (
                        <span className="ml-auto text-xs text-navy/30">Added</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Stops list (scrollable) */}
      <div className="flex-1 overflow-y-auto p-4">
        {stops.length > 0 ? (
          <ul className="space-y-2">
            {stops.map((stop, idx) => {
              const routeAssigns = assignments[stop.customerId];
              const hasCoords = stop.lat != null && stop.lng != null;
              return (
                <li
                  key={stop.id}
                  className="flex items-start gap-3 rounded-lg border border-surface-border bg-white px-3 py-2.5"
                >
                  <GripVertical className="mt-0.5 h-4 w-4 shrink-0 cursor-grab text-navy/20" />
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-medium text-navy">
                        {stop.customerName}
                      </p>
                      {!hasCoords && (
                        <span title="No GPS coordinates">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-navy/50">{stop.address}</p>
                    {routeAssigns && routeAssigns.length > 0 && (
                      <p className="mt-0.5 text-xs text-navy/40">
                        Also in: {routeAssigns.map((r) => r.routeName).join(", ")}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveStop(stop.customerId)}
                    className="mt-0.5 shrink-0 rounded p-1 text-navy/30 hover:bg-surface-raised hover:text-danger transition-colors"
                    title="Remove stop"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-12 text-center">
            <p className="text-sm text-navy/40">
              Click pins on the map or search above to add stops.
            </p>
          </div>
        )}
      </div>

      {/* Action bar (sticky bottom) */}
      <div className="shrink-0 border-t border-surface-border bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            onClick={() => router.push("/routes")}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="flex-1"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Creating…
              </>
            ) : (
              "Create Route"
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}
