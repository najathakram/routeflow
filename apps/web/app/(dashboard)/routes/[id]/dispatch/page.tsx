"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Package2,
  UserCheck,
  XCircle,
  Loader2,
  Printer,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  X,
  Save,
  MapPin,
  Clock,
  Sparkles,
  DoorOpen,
} from "lucide-react";
import { Badge, Button, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import {
  useRouteRun,
  useRunPackingList,
  useUpdateRouteRun,
  useUpdateRouteRunStatus,
  useOptimizeRoute,
  type RunPackingStop,
} from "@/lib/api/routes";
import { useDrivers } from "@/lib/api/drivers";
import { ArrivedStopSheet } from "@/components/ArrivedStopSheet";

// ─── Change Driver Modal ──────────────────────────────────────────────────────

function ChangeDriverModal({
  run,
  onClose,
}: {
  run: { id: string; driverId?: string | null };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: driversData } = useDrivers({ status: "ACTIVE", limit: 100 });
  const updateRun = useUpdateRouteRun();
  const initialDriverId = run.driverId ?? "";
  const [driverId, setDriverId] = React.useState(initialDriverId);
  const drivers = driversData?.data ?? [];

  const handleSave = () => {
    if (driverId === initialDriverId) {
      onClose();
      return;
    }
    updateRun.mutate(
      { id: run.id, driverId: driverId || null },
      {
        onSuccess: () => {
          toast({ title: "Driver updated", variant: "success" });
          onClose();
        },
        onError: (err) =>
          toast({ title: "Update failed", description: err.message, variant: "error" }),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
      <div className="w-full max-w-sm rounded-card border border-surface-border bg-white shadow-modal">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
          <h2 className="text-[15px] font-semibold text-navy">Change Driver</h2>
          <button
            onClick={onClose}
            className="rounded-ctl p-1 text-navy/50 transition-colors hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          <label className="mb-1.5 block text-xs font-semibold text-navy/70">Assign Driver</label>
          <select
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            className="h-9 w-full rounded-ctl border border-line-strong bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">No driver assigned</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.contactName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2 border-t border-surface-border px-5 py-3.5">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={updateRun.isPending}>
            {updateRun.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Cancel Run Modal ─────────────────────────────────────────────────────────

function CancelRunModal({
  runId,
  requiredCount,
  onClose,
}: {
  runId: string;
  requiredCount: number;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const updateStatus = useUpdateRouteRunStatus();

  const handleCancel = () => {
    updateStatus.mutate(
      { id: runId, status: "CANCELLED" },
      {
        onSuccess: () => {
          toast({ title: "Route run cancelled", variant: "success" });
          onClose();
        },
        onError: (err) =>
          toast({ title: "Cancel failed", description: err.message, variant: "error" }),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
      <div className="w-full max-w-sm rounded-card border border-surface-border bg-white shadow-modal">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
          <h2 className="text-[15px] font-semibold text-navy">Cancel Route Run?</h2>
          <button
            onClick={onClose}
            className="rounded-ctl p-1 text-navy/50 transition-colors hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          <div className="flex items-start gap-2.5 rounded-card border border-danger/30 bg-danger-bg px-3.5 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <p className="text-sm text-navy/80">
              {requiredCount > 0
                ? `${requiredCount} customer${requiredCount !== 1 ? "s" : ""} with orders will not be delivered.`
                : "This run will be cancelled. This action cannot be undone."}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-surface-border px-5 py-3.5">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Keep Run
          </Button>
          <button
            onClick={handleCancel}
            disabled={updateStatus.isPending}
            className="flex items-center gap-1.5 rounded-ctl bg-danger px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-danger/90 disabled:opacity-50"
          >
            {updateStatus.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            Yes, Cancel Run
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Stop card (required) ─────────────────────────────────────────────────────
//
// Ledger "Live Dispatch" stop node: a numbered circle (accent when the stop is
// in progress, otherwise the brand node) connected down a hairline spine, the
// customer name in ink-900, address/meta in ink-400, status pills to the side.

function RequiredStopCard({
  stop,
  isLast,
  onAtDoorActions,
}: {
  stop: RunPackingStop;
  isLast: boolean;
  onAtDoorActions?: (stop: RunPackingStop) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const totalItems = stop.orders.reduce(
    (sum, o) => sum + o.lineItems.reduce((s, li) => s + Number(li.qty), 0),
    0,
  );
  const isArrived = stop.status === "IN_PROGRESS";

  return (
    <div className="relative flex gap-3.5">
      {/* Timeline node + spine */}
      <div className="relative flex flex-col items-center">
        <div
          className={cn(
            "z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold",
            isArrived
              ? "bg-brand-500 text-white shadow-[0_0_0_4px_var(--accent-soft)]"
              : "bg-brand-500 text-white",
          )}
        >
          {stop.stopNumber}
        </div>
        {!isLast && <div className="w-px flex-1 bg-line-strong" />}
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1 pb-3">
        <button
          className="flex w-full items-start gap-3 text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-navy">
              {stop.customer?.businessName ?? "Unknown customer"}
            </p>
            {stop.customerAddress && (
              <p className="mt-0.5 text-xs text-navy/70">
                {stop.customerAddress.line1}, {stop.customerAddress.city},{" "}
                {stop.customerAddress.state}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.03em] text-brand-700">
                <CheckCircle2 className="h-3 w-3" />
                {stop.orders.length} order{stop.orders.length !== 1 ? "s" : ""}
              </span>
              <span className="text-xs text-navy/70">
                {totalItems % 1 === 0 ? totalItems : totalItems.toFixed(2)} items to deliver
              </span>
              {stop.customer?.deliveryWindowStart && stop.customer?.deliveryWindowEnd && (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.03em] text-[#B45309]">
                  <Clock className="h-3 w-3" />
                  {stop.customer.deliveryWindowStart}–{stop.customer.deliveryWindowEnd}
                </span>
              )}
            </div>
          </div>
          {isArrived && (
            <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.03em] text-accent-deep">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              Arrived
            </span>
          )}
          {expanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-navy/30" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-navy/30" />
          )}
        </button>

        {isArrived && onAtDoorActions && (
          <div className="no-print mt-2.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAtDoorActions(stop);
              }}
              className="flex items-center gap-1.5 rounded-ctl border border-line-strong bg-white px-2.5 py-1.5 text-xs font-semibold text-brand-700 shadow-card transition-colors hover:bg-surface-raised"
            >
              <DoorOpen className="h-3.5 w-3.5" />
              At-door actions
            </button>
          </div>
        )}

        {expanded && (
          <div className="mt-3 space-y-3 rounded-card border border-surface-border bg-surface-raised px-3.5 py-3">
            {stop.orders.map((order) => (
              <div key={order.id}>
                <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-navy/70">
                  <Package2 className="h-3.5 w-3.5" />
                  {order.orderNumber ? `Order #${order.orderNumber}` : "Order"}{" "}
                  <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.03em] text-navy/70">
                    {order.status}
                  </span>
                </p>
                <ul className="space-y-1 pl-4">
                  {order.lineItems.length > 0 ? (
                    order.lineItems.map((li) => (
                      <li
                        key={li.id}
                        className="flex items-center justify-between text-xs text-navy/80"
                      >
                        <span>{li.product?.name ?? "Product"}</span>
                        <span className="font-mono tabular-nums font-medium text-navy">
                          ×{Number(li.qty) % 1 === 0 ? Number(li.qty) : Number(li.qty).toFixed(2)}
                        </span>
                      </li>
                    ))
                  ) : (
                    <li className="text-xs italic text-navy/70">No line items</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Stop card (optional) ─────────────────────────────────────────────────────

function OptionalStopCard({ stop, isLast }: { stop: RunPackingStop; isLast: boolean }) {
  return (
    <div className="relative flex gap-3.5">
      <div className="relative flex flex-col items-center">
        <div className="z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-line-strong bg-sunken font-mono text-[11px] font-bold text-navy/40">
          {stop.stopNumber}
        </div>
        {!isLast && <div className="w-px flex-1 bg-line-strong" />}
      </div>
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium text-navy/70">
              {stop.customer?.businessName ?? "Unknown customer"}
            </p>
            {stop.customerAddress && (
              <p className="mt-0.5 text-xs text-navy/70">
                {stop.customerAddress.line1}, {stop.customerAddress.city},{" "}
                {stop.customerAddress.state}
              </p>
            )}
          </div>
          <span className="mt-0.5 shrink-0 rounded-full bg-sunken px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.03em] text-navy/50">
            No orders
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DispatchPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { user } = useAuth();
  const { toast } = useToast();
  const isOperator = user?.role === "OPERATOR";

  const { data: run, isLoading: runLoading } = useRouteRun(params.id);
  const { data: packingData, isLoading: packingLoading } = useRunPackingList(params.id);
  const { mutate: optimizeRoute, isPending: isOptimizing } = useOptimizeRoute();

  const [showDriverModal, setShowDriverModal] = React.useState(false);
  const [showCancelModal, setShowCancelModal] = React.useState(false);
  const [atDoorStop, setAtDoorStop] = React.useState<RunPackingStop | null>(null);

  const handleOptimize = () => {
    optimizeRoute(params.id, {
      onSuccess: (result) => {
        if (!result.usedFallback) {
          toast({
            title: "Route reordered",
            description: `${result.reorderedCount} stops reordered for the most efficient sequence.`,
          });
          return;
        }
        const fallbackHints: Record<string, string> = {
          ORS_NOT_CONFIGURED:
            "Route intelligence is not configured. Set ORS_API_KEY to enable true optimization.",
          ORS_RATE_LIMITED: "Route intelligence rate limit hit — try again in a minute.",
          ORS_HTTP_ERROR:
            "Couldn't reach route intelligence (server error). Used estimated distance instead.",
          ORS_NETWORK_ERROR:
            "Couldn't reach route intelligence (network error). Used estimated distance instead.",
        };
        const hint =
          (result.fallbackReason && fallbackHints[result.fallbackReason]) ??
          "Used estimated distance instead of route intelligence.";
        toast({
          title: "Route reordered (fallback)",
          description: `${result.reorderedCount} stops reordered. ${hint}`,
          variant: "warning",
        });
      },
      onError: (err) =>
        toast({ title: "Optimization failed", description: err.message, variant: "error" }),
    });
  };

  const routeName = run?.route?.name ?? "Dispatch";
  React.useEffect(() => {
    setTitle(`Dispatch — ${routeName}`);
  }, [setTitle, routeName]);

  const isLoading = runLoading || packingLoading;

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Route run not found.</p>
        <Button variant="secondary" href="/routes">
          Back to Routes
        </Button>
      </div>
    );
  }

  const stops = packingData?.stops ?? [];
  const requiredStops = stops.filter((s) => s.orders.length > 0);
  const optionalStops = stops.filter((s) => s.orders.length === 0);
  const packingList = packingData?.packingList ?? [];

  const scheduledDate = new Date(run.scheduledDate).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const driverName = run.driver?.contactName ?? "Unassigned";

  return (
    <>
      {showDriverModal && (
        <ChangeDriverModal
          run={{ id: run.id, driverId: run.driver?.id }}
          onClose={() => setShowDriverModal(false)}
        />
      )}
      {showCancelModal && (
        <CancelRunModal
          runId={run.id}
          requiredCount={requiredStops.length}
          onClose={() => setShowCancelModal(false)}
        />
      )}
      <ArrivedStopSheet
        open={!!atDoorStop}
        onClose={() => setAtDoorStop(null)}
        customerName={atDoorStop?.customer?.businessName ?? "Customer"}
        orders={atDoorStop?.orders}
      />

      {/* Print styles */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-section { page-break-inside: avoid; }
        }
      `}</style>

      <div className="min-h-[calc(100vh-64px)] bg-surface-raised">
        {/* ── Page header (Ledger .ph-row idiom) ── */}
        <div className="no-print sticky top-0 z-10 border-b border-surface-border bg-white px-6 py-4">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <div className="flex flex-1 flex-col gap-2">
              <Link
                href={`/routes/${params.id}`}
                className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-navy/70 transition-colors hover:text-navy"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Route Detail
              </Link>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-semibold tracking-[-0.01em] text-navy">
                  {run.route?.name ?? "Route"}
                </h1>
                <Badge
                  status={
                    run.status === "IN_PROGRESS"
                      ? "IN_PROGRESS"
                      : run.status === "COMPLETED"
                        ? "COMPLETED"
                        : run.status === "CANCELLED"
                          ? "CANCELLED"
                          : "SCHEDULED"
                  }
                />
              </div>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-navy/70">
                <span>{scheduledDate}</span>
                <span className="text-navy/30">·</span>
                <span className="inline-flex items-center gap-1">
                  <UserCheck className="h-3.5 w-3.5" />
                  {driverName}
                </span>
              </p>
            </div>

            {/* Operator controls */}
            {isOperator && run.status !== "CANCELLED" && run.status !== "COMPLETED" && (
              <div className="flex shrink-0 items-center gap-2 self-center">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleOptimize}
                  disabled={isOptimizing}
                >
                  {isOptimizing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {isOptimizing ? "Optimizing…" : "Optimize"}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setShowDriverModal(true)}>
                  <UserCheck className="mr-1.5 h-3.5 w-3.5" />
                  Change Driver
                </Button>
                <button
                  onClick={() => setShowCancelModal(true)}
                  className="flex items-center gap-1.5 rounded-ctl border border-danger/40 px-3 py-1.5 text-sm font-semibold text-danger transition-colors hover:bg-danger-bg"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Cancel Run
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Cancelled banner ── */}
        {run.status === "CANCELLED" && (
          <div className="mx-6 mt-4 flex items-center gap-3 rounded-card border border-danger/30 bg-danger-bg px-4 py-3">
            <XCircle className="h-5 w-5 shrink-0 text-danger" />
            <p className="text-sm font-semibold text-danger">This route run has been cancelled.</p>
          </div>
        )}

        {/* ── Split layout: stops left, packing list right ── */}
        <div className="flex h-[calc(100vh-64px-73px)] overflow-hidden">
          {/* ── Left: Stops ── */}
          <div className="w-[45%] shrink-0 overflow-y-auto border-r border-surface-border bg-white p-6">
            {/* Required stops */}
            <div className="print-section mb-6 rounded-card border border-surface-border bg-white shadow-card">
              <div className="flex items-center justify-between gap-3 border-b border-surface-border px-4 py-3.5">
                <div className="flex items-center gap-2">
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-500">
                    <CheckCircle2 className="h-3 w-3 text-white" />
                  </div>
                  <h3 className="text-[13px] font-semibold text-navy">Must Stop</h3>
                </div>
                <span className="text-xs text-navy/70">
                  {requiredStops.length} customer{requiredStops.length !== 1 ? "s" : ""} with orders
                </span>
              </div>

              <div className="px-4 py-4">
                {requiredStops.length === 0 ? (
                  <div className="rounded-card border border-dashed border-line-strong bg-surface-raised px-4 py-6 text-center">
                    <p className="text-sm italic text-navy/70">
                      No customers have active orders for this run.
                    </p>
                  </div>
                ) : (
                  <div>
                    {requiredStops.map((stop, i) => (
                      <RequiredStopCard
                        key={stop.id}
                        stop={stop}
                        isLast={i === requiredStops.length - 1}
                        onAtDoorActions={setAtDoorStop}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Optional stops */}
            {optionalStops.length > 0 && (
              <div className="print-section rounded-card border border-surface-border bg-white shadow-card">
                <div className="flex items-center justify-between gap-3 border-b border-surface-border px-4 py-3.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-line-strong">
                      <MapPin className="h-2.5 w-2.5 text-navy/40" />
                    </div>
                    <h3 className="text-[13px] font-semibold text-navy">Optional Stops</h3>
                  </div>
                  <span className="text-xs text-navy/70">
                    {optionalStops.length} with no current orders
                  </span>
                </div>
                <div className="px-4 py-4">
                  <p className="mb-3 text-xs text-navy/70">
                    These stops are on the route but have no orders today. Stop at your discretion.
                  </p>
                  <div>
                    {optionalStops.map((stop, i) => (
                      <OptionalStopCard
                        key={stop.id}
                        stop={stop}
                        isLast={i === optionalStops.length - 1}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Right: Loading Manifest ── */}
          <div className="flex-1 overflow-y-auto bg-surface-raised p-6">
            <div className="print-section rounded-card border border-surface-border bg-white shadow-card">
              <div className="flex items-center justify-between gap-3 border-b border-surface-border px-4 py-3.5">
                <div className="flex items-center gap-2">
                  <Package2 className="h-4 w-4 text-navy/70" />
                  <h3 className="text-[13px] font-semibold text-navy">Loading Manifest</h3>
                  <span className="text-xs font-normal text-navy/70">
                    — what to load before departure
                  </span>
                </div>
                {packingList.length > 0 && (
                  <button
                    onClick={() => window.print()}
                    className="no-print flex items-center gap-1.5 rounded-ctl border border-line-strong bg-white px-2.5 py-1.5 text-xs font-semibold text-navy/70 shadow-card transition-colors hover:bg-surface-raised hover:text-navy"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    Print
                  </button>
                )}
              </div>

              {packingList.length === 0 ? (
                <div className="px-4 py-9 text-center">
                  <div className="mx-auto mb-3 flex h-14 w-[72px] items-center justify-center rounded-card border border-dashed border-line-strong bg-surface-raised">
                    <Package2 className="h-6 w-6 text-navy/30" />
                  </div>
                  <p className="font-display text-[17px] text-navy">Nothing to pack</p>
                  <p className="mt-1 text-xs text-navy/70">
                    No active orders are assigned to this run&apos;s stops.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b-2 border-navy text-left">
                        <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                          Product
                        </th>
                        <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                          SKU
                        </th>
                        <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                          Total Qty
                        </th>
                        <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                          Customers
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-border">
                      {packingList.map((item) => (
                        <tr key={item.productId} className="transition-colors hover:bg-brand-50/40">
                          <td className="px-4 py-3 font-semibold text-navy">{item.productName}</td>
                          <td className="px-4 py-3 font-mono text-navy/70">{item.sku ?? "—"}</td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-bold text-navy">
                            {item.totalQty % 1 === 0 ? item.totalQty : item.totalQty.toFixed(2)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {item.customers.map((c) => (
                                <span
                                  key={c.name}
                                  className="inline-flex items-center rounded bg-sunken px-1.5 py-0.5 text-[11px] text-navy/70"
                                >
                                  {c.name}{" "}
                                  <span className="ml-1 font-mono tabular-nums font-semibold text-navy">
                                    ×{c.qty % 1 === 0 ? c.qty : c.qty.toFixed(2)}
                                  </span>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-surface-border bg-surface-raised">
                        <td
                          colSpan={2}
                          className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70"
                        >
                          Total
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-sm font-bold text-navy">
                          {(() => {
                            const t = packingList.reduce((s, i) => s + i.totalQty, 0);
                            return t % 1 === 0 ? t : t.toFixed(2);
                          })()}
                        </td>
                        <td className="px-4 py-3 text-xs text-navy/70">
                          {packingList.length} product{packingList.length !== 1 ? "s" : ""}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
