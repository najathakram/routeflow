"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  MapPin,
  Pencil,
  Send as SendIcon,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge, Button, Select, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useCreateTrip,
  useCreateRouteRun,
  useDeleteRoute,
  useOptimizeTemplate,
  useRoute,
  useRouteSettings,
  useTripEligibility,
  useUpdateRoute,
  type TripOrigin,
} from "@/lib/api/routes";
import { useDrivers } from "@/lib/api/drivers";
import { loadTripDraft, clearTripDraft } from "@/lib/trip-draft";
import { groupOrdersForTrip, type TripStopGroup } from "@routeflow/types";
import { TemplateRouteMap } from "../../templates/[id]/TemplateRouteMap";
import {
  TripOriginPicker,
  type TripOriginKind,
  type TripOriginAddress,
} from "../_components/TripOriginPicker";
import { TripStopList } from "../_components/TripStopList";
import { TripSkippedPanel, type TripSkippedRow } from "../_components/TripSkippedPanel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function summaryLabel(stopCount: number, orderCount: number): string {
  return `${stopCount} stop${stopCount !== 1 ? "s" : ""} · ${orderCount} order${
    orderCount !== 1 ? "s" : ""
  }`;
}

function originKindLabel(kind: TripOriginKind): string {
  if (kind === "TENANT") return "Tenant depot";
  if (kind === "DRIVER") return "Driver's home base";
  return "Custom address";
}

type Phase = "PICKING" | "BUILT";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NewTripPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => {
    setTitle("Plan Delivery Trip");
  }, [setTitle]);

  // ── Draft (from the orders-list "Plan delivery trip" bulkbar action) ──
  // Read client-side only — sessionStorage isn't available during the SSR
  // pass, so undefined = "not checked yet" avoids flashing the empty state.
  const [draft, setDraft] = React.useState<ReturnType<typeof loadTripDraft> | undefined>(undefined);
  React.useEffect(() => {
    setDraft(loadTripDraft());
  }, []);

  // ── Phase / created-route state ──
  const [phase, setPhase] = React.useState<Phase>("PICKING");
  const [routeId, setRouteId] = React.useState<string | null>(null);

  // ── Form state (PICKING) ──
  const [removedCustomerIds, setRemovedCustomerIds] = React.useState<Set<string>>(new Set());
  const [driverId, setDriverId] = React.useState("");
  const [originKind, setOriginKind] = React.useState<TripOriginKind>("TENANT");
  const [address, setAddress] = React.useState<TripOriginAddress>({
    line1: "",
    city: "",
    state: "",
    zip: "",
  });
  const today = new Date().toISOString().split("T")[0];
  const [date, setDate] = React.useState(today);

  // ── BUILT-phase chrome ──
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [editingName, setEditingName] = React.useState(false);
  const [nameValue, setNameValue] = React.useState("");

  // ── Snapshot taken at Build time — the BUILT review stays stable even if
  //    the underlying eligibility query refetches afterward. ──
  const [frozenGroups, setFrozenGroups] = React.useState<TripStopGroup[]>([]);
  const [frozenOrderIds, setFrozenOrderIds] = React.useState<string[]>([]);
  const [frozenSkipped, setFrozenSkipped] = React.useState<TripSkippedRow[]>([]);
  const [frozenOriginKind, setFrozenOriginKind] = React.useState<TripOriginKind>("TENANT");

  // ── Data ──
  const orderIds = draft?.orderIds ?? [];
  const {
    data: eligibility,
    isLoading: eligLoading,
    isError: eligError,
    refetch: refetchEligibility,
  } = useTripEligibility(orderIds);
  const { data: driversData } = useDrivers({ status: "ACTIVE", limit: 100 });
  const { data: routeSettings } = useRouteSettings();
  const { data: builtRoute } = useRoute(routeId ?? "");

  // ── Mutations ──
  const createTrip = useCreateTrip();
  const optimizeTemplate = useOptimizeTemplate();
  const createRun = useCreateRouteRun();
  const deleteRoute = useDeleteRoute();
  const updateRoute = useUpdateRoute();

  const drivers = driversData?.data ?? [];
  const selectedDriver = drivers.find((d) => d.id === driverId);
  // Mirror what the server can actually resolve (TripsService.resolveTenantDepot):
  // tier 2 = the cached depot coords, tier 3 = geocoding the tenant's business
  // address. depotLat/depotLng are only ever written as a side effect of a
  // successful geocode, so gating on them alone locks out every tenant that has
  // a business address but has never optimized. Mobile gates on depotAddress —
  // this predicate covers both, so the two clients agree.
  const hasDepot =
    (routeSettings?.depotLat != null && routeSettings?.depotLng != null) ||
    !!routeSettings?.depotAddress;
  // The DRIVER origin resolves from homeLat/homeLng only (TripsService.resolveOrigin),
  // which the driver profile's Home Base section writes on a successful geocode.
  const hasDriverHome = selectedDriver?.homeLat != null && selectedDriver?.homeLng != null;

  // ── Eligibility → stop groups + skipped panel ──
  const eligibleRows = React.useMemo(
    () => (eligibility ?? []).filter((r) => r.eligible),
    [eligibility],
  );
  const ineligibleRows = React.useMemo(
    () => (eligibility ?? []).filter((r) => !r.eligible),
    [eligibility],
  );

  const grouping = React.useMemo(
    () =>
      groupOrdersForTrip(
        eligibleRows.map((r) => ({
          id: r.orderId,
          orderNumber: r.orderNumber,
          customerId: r.customerId,
          customerName: r.customerName,
        })),
      ),
    [eligibleRows],
  );

  const skippedRows: TripSkippedRow[] = React.useMemo(() => {
    const fromServer: TripSkippedRow[] = ineligibleRows.map((r) => ({
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      reason: r.reason ?? "NOT_FOUND",
      detail: r.detail ?? null,
    }));
    const fromGrouping: TripSkippedRow[] = grouping.skipped.map((s) => ({
      orderId: s.orderId,
      orderNumber: s.orderNumber,
      reason: s.reason,
      detail: null,
    }));
    return [...fromServer, ...fromGrouping];
  }, [ineligibleRows, grouping.skipped]);

  const orderLookup = React.useMemo(() => {
    const map: Record<string, { orderNumber: string | null }> = {};
    for (const row of eligibility ?? []) map[row.orderId] = { orderNumber: row.orderNumber };
    return map;
  }, [eligibility]);

  const pickingGroups = React.useMemo(
    () => grouping.groups.filter((g) => !removedCustomerIds.has(g.customerId)),
    [grouping.groups, removedCustomerIds],
  );
  const remainingIds = React.useMemo(
    () => pickingGroups.flatMap((g) => g.orderIds),
    [pickingGroups],
  );

  // BUILT: render the server's stop order. The post-create optimize reorders
  // stops and the map beside this list already shows that order — reading from
  // frozenGroups here would number the review list differently from the map.
  // frozenGroups still backs the CTA counts (what we asked the server to build).
  const builtGroups = React.useMemo<TripStopGroup[]>(() => {
    const stops = builtRoute?.stops;
    if (!stops || stops.length === 0) return frozenGroups;
    const byCustomer = new Map(frozenGroups.map((g) => [g.customerId, g]));
    return [...stops]
      .sort((a, b) => a.stopNumber - b.stopNumber)
      .map((s) => ({
        customerId: s.customerId,
        customerName:
          s.customer?.businessName ?? byCustomer.get(s.customerId)?.customerName ?? null,
        orderIds: byCustomer.get(s.customerId)?.orderIds ?? [],
      }));
  }, [builtRoute?.stops, frozenGroups]);

  const displayGroups = phase === "BUILT" ? builtGroups : pickingGroups;
  const displaySkipped = phase === "BUILT" ? frozenSkipped : skippedRows;

  const originReady =
    originKind === "TENANT"
      ? hasDepot
      : originKind === "DRIVER"
        ? !!driverId && hasDriverHome
        : address.line1.trim().length > 0;

  const canBuild =
    !createTrip.isPending && !eligLoading && !eligError && pickingGroups.length > 0 && originReady;

  function buildOrigin(): TripOrigin {
    if (originKind === "DRIVER") return { type: "DRIVER", driverId };
    if (originKind === "ADDRESS")
      return {
        type: "ADDRESS",
        line1: address.line1.trim(),
        city: address.city.trim() || undefined,
        state: address.state.trim() || undefined,
        zip: address.zip.trim() || undefined,
      };
    return { type: "TENANT" };
  }

  function handleRemoveCustomer(customerId: string) {
    setRemovedCustomerIds((prev) => new Set(prev).add(customerId));
  }

  function handleBuild() {
    if (!canBuild) return;
    const groupsSnapshot = pickingGroups;
    const idsSnapshot = remainingIds;
    const skippedSnapshot = skippedRows;
    createTrip.mutate(
      { orderIds: idsSnapshot, driverId: driverId || undefined, origin: buildOrigin() },
      {
        onSuccess: (route) => {
          setRouteId(route.id);
          setFrozenGroups(groupsSnapshot);
          setFrozenOrderIds(idsSnapshot);
          setFrozenSkipped(skippedSnapshot);
          setFrozenOriginKind(originKind);
          setPhase("BUILT");
          toast({
            title: "Trip created",
            description: `${summaryLabel(groupsSnapshot.length, idsSnapshot.length)} — review and send below.`,
            variant: "success",
          });
          optimizeTemplate.mutate(route.id, {
            onError: (err) =>
              toast({
                title: "Trip created; optimization unavailable — stops in selection order",
                description: err.message,
                variant: "warning",
              }),
          });
        },
        onError: (err) => {
          const ineligible = (err as { response?: { data?: { ineligible?: unknown[] } } })?.response
            ?.data?.ineligible;
          if (Array.isArray(ineligible) && ineligible.length > 0) {
            toast({
              title: `${ineligible.length} order${ineligible.length !== 1 ? "s" : ""} became ineligible`,
              description: "Check the skipped list below and try again.",
              variant: "warning",
            });
            refetchEligibility();
          } else {
            toast({ title: "Failed to create trip", description: err.message, variant: "error" });
          }
        },
      },
    );
  }

  function handleReoptimize() {
    if (!routeId || optimizeTemplate.isPending) return;
    optimizeTemplate.mutate(routeId, {
      onSuccess: (result) =>
        toast({
          title: result.usedFallback ? "Optimized (local fallback)" : "Optimized",
          description:
            result.reorderedCount > 0
              ? `${result.reorderedCount} stop${result.reorderedCount === 1 ? "" : "s"} reordered`
              : "Stops are already in optimal order",
          variant: "success",
        }),
      onError: (err) =>
        toast({
          title: "Optimization unavailable — stops kept in current order",
          description: err.message,
          variant: "warning",
        }),
    });
  }

  function handleSend() {
    if (!routeId || createRun.isPending) return;
    createRun.mutate(
      { routeId, scheduledDate: date, driverId: driverId || undefined, orderIds: frozenOrderIds },
      {
        onSuccess: (run) => {
          clearTripDraft();
          // The dispatch sweep re-checks eligibility server-side, so orders
          // cancelled or dispatched elsewhere since Build silently drop out.
          // Report what actually attached rather than the frozen count.
          const attached = run.attachedOrderCount ?? frozenOrderIds.length;
          const dropped = frozenOrderIds.length - attached;
          const driverSuffix = selectedDriver ? ` to ${selectedDriver.contactName}` : "";
          toast(
            dropped > 0
              ? {
                  title: "Trip dispatched with skipped orders",
                  description: `${summaryLabel(frozenGroups.length, attached)}${driverSuffix} — ${dropped} order${
                    dropped !== 1 ? "s" : ""
                  } changed since you built the trip and were left off.`,
                  variant: "warning",
                }
              : {
                  title: "Trip dispatched",
                  description: `${summaryLabel(frozenGroups.length, attached)}${driverSuffix}`,
                  variant: "success",
                },
          );
          router.replace(`/routes/${run.id}`);
        },
        onError: (err) =>
          toast({ title: "Dispatch failed", description: err.message, variant: "error" }),
      },
    );
  }

  function handleDiscard() {
    if (!routeId || deleteRoute.isPending) return;
    deleteRoute.mutate(routeId, {
      onSuccess: () => {
        clearTripDraft();
        toast({ title: "Trip discarded", variant: "success" });
        router.push("/orders");
      },
      onError: (err) =>
        toast({ title: "Failed to discard trip", description: err.message, variant: "error" }),
    });
  }

  function handleStartEditName() {
    setNameValue(builtRoute?.name ?? "");
    setEditingName(true);
  }

  function handleSaveName() {
    const trimmed = nameValue.trim();
    if (!routeId || !trimmed || trimmed === builtRoute?.name) {
      setEditingName(false);
      return;
    }
    updateRoute.mutate(
      { id: routeId, name: trimmed },
      {
        onSuccess: () => {
          setEditingName(false);
          toast({ title: "Trip name saved", variant: "success" });
        },
        onError: (err) =>
          toast({ title: "Save failed", description: err.message, variant: "error" }),
      },
    );
  }

  // ── Empty / expired states (Design directive 4 — no dead ends) ──

  if (draft === undefined) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  if (draft === null) {
    const expired = Number(searchParams.get("n") ?? "0") > 0;
    return (
      <div className="flex h-[calc(100vh-64px)] flex-col items-center justify-center gap-4 p-8 text-center">
        <MapPin className="h-10 w-10 text-navy/20" />
        <p className="text-base font-medium text-navy">
          {expired ? "Your trip selection expired" : "Plan a delivery trip"}
        </p>
        <p className="max-w-sm text-sm text-navy/70">
          {expired
            ? "Selections expire after 30 minutes. Go back to Orders and select them again."
            : 'Select orders from the Orders list, then choose "Plan delivery trip" to start building a trip here.'}
        </p>
        <Button onClick={() => router.push("/orders")}>Go to Orders</Button>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      {/* ── Top bar ── */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-surface-border bg-white px-6 py-3">
        <Link
          href="/routes"
          className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Routes
        </Link>
        <div className="h-4 w-px bg-surface-border" />

        {phase === "BUILT" && editingName ? (
          <input
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={handleSaveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSaveName();
              if (e.key === "Escape") setEditingName(false);
            }}
            className="rounded border border-brand-500 bg-white px-2 py-0.5 text-base font-bold text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            autoFocus
          />
        ) : phase === "BUILT" ? (
          <button
            onClick={handleStartEditName}
            title="Click to rename"
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-base font-bold text-navy hover:bg-surface-raised transition-colors"
          >
            {builtRoute?.name ?? "Trip"}
            <Pencil className="h-3 w-3 text-navy/40" />
          </button>
        ) : (
          <h2 className="text-base font-bold text-navy">Plan Delivery Trip</h2>
        )}

        <Badge
          variant="neutral"
          label={
            phase === "BUILT"
              ? "Draft trip"
              : `${orderIds.length} order${orderIds.length !== 1 ? "s" : ""} selected`
          }
        />

        <div className="ml-auto flex items-center gap-2">
          {phase === "PICKING" && (
            <Button
              loading={createTrip.isPending}
              onClick={handleBuild}
              disabled={!canBuild}
              title={
                !originReady
                  ? "Choose a valid start point first"
                  : pickingGroups.length === 0
                    ? "No eligible stops selected"
                    : undefined
              }
            >
              {createTrip.isPending
                ? "Building…"
                : `Build ${summaryLabel(pickingGroups.length, remainingIds.length)}`}
            </Button>
          )}

          {phase === "BUILT" && (
            <>
              <Button
                variant="secondary"
                leftIcon={
                  optimizeTemplate.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )
                }
                onClick={handleReoptimize}
                disabled={optimizeTemplate.isPending || (builtRoute?.stops?.length ?? 0) < 2}
              >
                {optimizeTemplate.isPending ? "Optimizing…" : "Re-optimize"}
              </Button>

              {confirmDiscard ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-danger">Discard trip?</span>
                  <button
                    onClick={handleDiscard}
                    disabled={deleteRoute.isPending}
                    className="rounded px-2 py-1 text-xs font-semibold text-white bg-danger hover:bg-danger/80 transition-colors"
                  >
                    {deleteRoute.isPending ? "Discarding…" : "Yes, discard"}
                  </button>
                  <button
                    onClick={() => setConfirmDiscard(false)}
                    className="rounded px-2 py-1 text-xs font-medium text-navy/70 hover:text-navy transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDiscard(true)}
                  title="Discard this trip"
                  className="flex h-8 items-center gap-1.5 rounded border border-surface-border bg-white px-2.5 text-sm font-medium text-navy/70 hover:border-danger hover:text-danger transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}

              <Button
                leftIcon={
                  createRun.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <SendIcon className="h-4 w-4" />
                  )
                }
                onClick={handleSend}
                disabled={createRun.isPending}
              >
                {createRun.isPending
                  ? "Sending…"
                  : `Send ${summaryLabel(frozenGroups.length, frozenOrderIds.length)}${
                      selectedDriver ? ` to ${selectedDriver.contactName}` : ""
                    }`}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1">
        {/* Left panel — form + stop list + skipped panel */}
        <div className="flex w-2/5 min-w-[360px] flex-col gap-4 overflow-y-auto border-r border-surface-border p-4">
          {phase === "PICKING" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-navy">Driver</label>
                  <Select
                    value={driverId}
                    onChange={(e) => setDriverId(e.target.value)}
                    options={[
                      { value: "", label: "Unassigned" },
                      ...drivers.map((d) => ({ value: d.id, label: d.contactName })),
                    ]}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-navy">Run date</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              </div>

              <TripOriginPicker
                kind={originKind}
                onKindChange={setOriginKind}
                address={address}
                onAddressChange={setAddress}
                depotAddress={routeSettings?.depotAddress}
                hasDepot={hasDepot}
                driverName={selectedDriver?.contactName}
                hasDriver={!!driverId}
                hasDriverHome={hasDriverHome}
                driverHref={driverId ? `/drivers/${driverId}` : null}
              />
            </>
          ) : (
            <div className="space-y-1 rounded-lg border border-surface-border bg-surface-raised p-3 text-sm">
              <p className="text-navy">
                <span className="font-medium">Start:</span> {originKindLabel(frozenOriginKind)}
                {builtRoute?.depotAddress ? ` — ${builtRoute.depotAddress}` : ""}
              </p>
              <p className="text-navy">
                <span className="font-medium">Driver:</span>{" "}
                {selectedDriver?.contactName ?? "Unassigned"}
              </p>
              <p className="text-navy">
                <span className="font-medium">Date:</span> {new Date(date).toLocaleDateString()}
              </p>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-navy/70">
              Stops ({displayGroups.length})
            </h3>
            {eligLoading ? (
              <div className="h-24 animate-pulse rounded-lg border border-surface-border bg-surface-raised" />
            ) : eligError ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2">
                <span className="text-xs text-danger">Failed to check eligibility.</span>
                <button
                  onClick={() => refetchEligibility()}
                  className="text-xs font-medium text-danger underline"
                >
                  Retry
                </button>
              </div>
            ) : (
              <TripStopList
                groups={displayGroups}
                orderLookup={orderLookup}
                onRemoveCustomer={phase === "PICKING" ? handleRemoveCustomer : undefined}
                emptyMessage="No eligible stops selected."
              />
            )}
          </div>

          <TripSkippedPanel rows={displaySkipped} />
        </div>

        {/* Right panel — map */}
        <div className="flex-1 overflow-hidden">
          {phase === "BUILT" ? (
            <TemplateRouteMap
              stops={builtRoute?.stops ?? []}
              depotLat={builtRoute?.depotLat ?? undefined}
              depotLng={builtRoute?.depotLng ?? undefined}
              depotAddress={builtRoute?.depotAddress ?? undefined}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-raised text-navy/70">
              <MapPin className="h-10 w-10" />
              <p className="text-sm">The route map appears here once the trip is built.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
