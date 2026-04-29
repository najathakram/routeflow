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

// ─── Change Driver Modal ──────────────────────────────────────────────────────

function ChangeDriverModal({
  run,
  onClose,
}: {
  run: { id: string; driverId?: string | null };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: driversData } = useDrivers({ limit: 100 });
  const updateRun = useUpdateRouteRun();
  const [driverId, setDriverId] = React.useState(run.driverId ?? "");
  const drivers = driversData?.data ?? [];

  const handleSave = () => {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-navy">Change Driver</h2>
          <button onClick={onClose} className="text-navy/40 hover:text-navy">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-navy/60">Assign Driver</label>
          <select
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            className="h-9 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">No driver assigned</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.contactName}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-5 flex justify-end gap-2">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-navy">Cancel Route Run?</h2>
          <button onClick={onClose} className="text-navy/40 hover:text-navy">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="rounded-lg border border-danger/30 bg-danger-bg p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <p className="text-sm text-navy/80">
              {requiredCount > 0
                ? `${requiredCount} customer${requiredCount !== 1 ? "s" : ""} with orders will not be delivered.`
                : "This run will be cancelled. This action cannot be undone."}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Keep Run
          </Button>
          <button
            onClick={handleCancel}
            disabled={updateStatus.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-sm font-semibold text-white hover:bg-danger/90 disabled:opacity-50"
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

function RequiredStopCard({ stop }: { stop: RunPackingStop }) {
  const [expanded, setExpanded] = React.useState(false);
  const totalItems = stop.orders.reduce(
    (sum, o) => sum + o.lineItems.reduce((s, li) => s + Number(li.qty), 0),
    0,
  );

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50">
      <button
        className="flex w-full items-start gap-3 p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">
          {stop.stopNumber}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-navy">
            {stop.customer?.businessName ?? "Unknown customer"}
          </p>
          {stop.customerAddress && (
            <p className="mt-0.5 text-xs text-navy/50">
              {stop.customerAddress.line1}, {stop.customerAddress.city},{" "}
              {stop.customerAddress.state}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
              <CheckCircle2 className="h-3 w-3" />
              {stop.orders.length} order{stop.orders.length !== 1 ? "s" : ""}
            </span>
            <span className="text-xs text-navy/50">
              {totalItems % 1 === 0 ? totalItems : totalItems.toFixed(2)} items to deliver
            </span>
            {stop.customer?.deliveryWindowStart && stop.customer?.deliveryWindowEnd && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                <Clock className="h-3 w-3" />
                {stop.customer.deliveryWindowStart}–{stop.customer.deliveryWindowEnd}
              </span>
            )}
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-navy/30" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-navy/30" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-brand-200 px-4 pb-4 pt-3 space-y-3">
          {stop.orders.map((order) => (
            <div key={order.id}>
              <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-navy/60">
                <Package2 className="h-3.5 w-3.5" />
                {order.orderNumber ? `Order #${order.orderNumber}` : "Order"}{" "}
                <span className="rounded bg-surface-raised px-1 py-0.5 text-[10px] font-medium text-navy/50">
                  {order.status}
                </span>
              </p>
              <ul className="space-y-0.5 pl-4">
                {order.lineItems.length > 0 ? (
                  order.lineItems.map((li) => (
                    <li key={li.id} className="flex items-center justify-between text-xs text-navy/80">
                      <span>{li.product?.name ?? "Product"}</span>
                      <span className="font-medium text-navy">
                        ×{Number(li.qty) % 1 === 0 ? Number(li.qty) : Number(li.qty).toFixed(2)}
                      </span>
                    </li>
                  ))
                ) : (
                  <li className="text-xs italic text-navy/40">No line items</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Stop card (optional) ─────────────────────────────────────────────────────

function OptionalStopCard({ stop }: { stop: RunPackingStop }) {
  return (
    <div className="rounded-lg border border-surface-border bg-white">
      <div className="flex items-start gap-3 p-4">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-navy/20 text-xs font-bold text-navy/30">
          {stop.stopNumber}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-navy/60">
            {stop.customer?.businessName ?? "Unknown customer"}
          </p>
          {stop.customerAddress && (
            <p className="mt-0.5 text-xs text-navy/40">
              {stop.customerAddress.line1}, {stop.customerAddress.city},{" "}
              {stop.customerAddress.state}
            </p>
          )}
        </div>
        <span className="mt-0.5 shrink-0 text-xs italic text-navy/40">No orders</span>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DispatchPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { user } = useAuth();
  const isOperator = user?.role === "OPERATOR";

  const { data: run, isLoading: runLoading } = useRouteRun(params.id);
  const { data: packingData, isLoading: packingLoading } = useRunPackingList(params.id);
  const { mutate: optimizeRoute, isPending: isOptimizing } = useOptimizeRoute();

  const [showDriverModal, setShowDriverModal] = React.useState(false);
  const [showCancelModal, setShowCancelModal] = React.useState(false);

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
          ORS_HTTP_ERROR: "Couldn't reach route intelligence (server error). Used estimated distance instead.",
          ORS_NETWORK_ERROR: "Couldn't reach route intelligence (network error). Used estimated distance instead.",
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

      {/* Print styles */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-section { page-break-inside: avoid; }
        }
      `}</style>

      <div className="min-h-[calc(100vh-64px)] bg-surface-raised">
        {/* ── Top bar ── */}
        <div className="no-print sticky top-0 z-10 border-b border-surface-border bg-white px-6 py-4">
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href={`/routes/${params.id}`}
              className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Route Detail
            </Link>
            <div className="h-4 w-px bg-surface-border" />
            <div className="flex flex-1 flex-wrap items-center gap-3">
              <h1 className="text-lg font-bold text-navy">{run.route?.name ?? "Route"}</h1>
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
              <span className="text-sm text-navy/60">{scheduledDate}</span>
              <span className="text-sm text-navy/40">·</span>
              <span className="flex items-center gap-1 text-sm text-navy/60">
                <UserCheck className="h-3.5 w-3.5" />
                {driverName}
              </span>
            </div>

            {/* Operator controls */}
            {isOperator && run.status !== "CANCELLED" && run.status !== "COMPLETED" && (
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="secondary" size="sm" onClick={handleOptimize} disabled={isOptimizing}>
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
                  className="flex items-center gap-1.5 rounded-lg border border-danger/40 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/5 transition-colors"
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
          <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
            <XCircle className="h-5 w-5 shrink-0 text-danger" />
            <p className="text-sm font-semibold text-danger">This route run has been cancelled.</p>
          </div>
        )}

        {/* ── Split layout: stops left, packing list right ── */}
        <div className="flex h-[calc(100vh-64px-65px)] overflow-hidden">
          {/* ── Left: Stops ── */}
          <div className="w-[45%] shrink-0 overflow-y-auto border-r border-surface-border bg-white p-6">
            {/* Required stops */}
            <div className="print-section mb-6">
              <div className="mb-3 flex items-center gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-500">
                  <CheckCircle2 className="h-3 w-3 text-white" />
                </div>
                <h2 className="text-sm font-bold uppercase tracking-wider text-navy">
                  Must Stop
                  <span className="ml-1.5 font-normal normal-case text-navy/50">
                    ({requiredStops.length} — customers with orders)
                  </span>
                </h2>
              </div>

              {requiredStops.length === 0 ? (
                <div className="rounded-lg border border-surface-border bg-surface-raised p-4 text-center">
                  <p className="text-sm italic text-navy/40">
                    No customers have active orders for this run.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {requiredStops.map((stop) => (
                    <RequiredStopCard key={stop.id} stop={stop} />
                  ))}
                </div>
              )}
            </div>

            {/* Optional stops */}
            {optionalStops.length > 0 && (
              <div className="print-section">
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-navy/20">
                    <MapPin className="h-2.5 w-2.5 text-navy/30" />
                  </div>
                  <h2 className="text-sm font-bold uppercase tracking-wider text-navy">
                    Optional Stops
                    <span className="ml-1.5 font-normal normal-case text-navy/50">
                      ({optionalStops.length} — no current orders)
                    </span>
                  </h2>
                </div>
                <p className="mb-2 text-xs text-navy/40">
                  These stops are on the route but have no orders today. Stop at your discretion.
                </p>
                <div className="space-y-2">
                  {optionalStops.map((stop) => (
                    <OptionalStopCard key={stop.id} stop={stop} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Right: Loading Manifest ── */}
          <div className="flex-1 overflow-y-auto bg-surface-raised p-6">
            <div className="print-section">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package2 className="h-5 w-5 text-navy/50" />
                  <h2 className="text-sm font-bold uppercase tracking-wider text-navy">
                    Loading Manifest
                    <span className="ml-1.5 font-normal normal-case text-navy/50">
                      — what to load before departure
                    </span>
                  </h2>
                </div>
                {packingList.length > 0 && (
                  <button
                    onClick={() => window.print()}
                    className="no-print flex items-center gap-1.5 rounded border border-surface-border bg-white px-2.5 py-1.5 text-xs font-medium text-navy/60 hover:border-navy/30 hover:text-navy transition-colors"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    Print
                  </button>
                )}
              </div>

              {packingList.length === 0 ? (
                <div className="rounded-lg border border-surface-border bg-white p-8 text-center">
                  <Package2 className="mx-auto mb-3 h-8 w-8 text-navy/20" />
                  <p className="text-sm font-medium text-navy/60">Nothing to pack</p>
                  <p className="mt-1 text-xs text-navy/40">
                    No active orders are assigned to this run&apos;s stops.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-surface-border bg-white overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-border bg-surface-raised text-left">
                        <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-navy/50">
                          Product
                        </th>
                        <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-navy/50">
                          SKU
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/50">
                          Total Qty
                        </th>
                        <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-navy/50">
                          Customers
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-border">
                      {packingList.map((item) => (
                        <tr key={item.productId} className="hover:bg-surface-raised/50 transition-colors">
                          <td className="px-4 py-3 font-medium text-navy">{item.productName}</td>
                          <td className="px-4 py-3 text-navy/50">{item.sku ?? "—"}</td>
                          <td className="px-4 py-3 text-right font-bold text-navy">
                            {item.totalQty % 1 === 0 ? item.totalQty : item.totalQty.toFixed(2)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {item.customers.map((c) => (
                                <span
                                  key={c.name}
                                  className="inline-flex items-center rounded bg-surface-raised px-1.5 py-0.5 text-[11px] text-navy/70"
                                >
                                  {c.name}{" "}
                                  <span className="ml-1 font-semibold text-navy">
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
                          className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-navy/50"
                        >
                          Total
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-bold text-navy">
                          {(() => {
                            const t = packingList.reduce((s, i) => s + i.totalQty, 0);
                            return t % 1 === 0 ? t : t.toFixed(2);
                          })()}
                        </td>
                        <td className="px-4 py-3 text-xs text-navy/40">
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
