"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  useRouteVariants,
  useApplyRouteVariant,
  type TripOrigin,
  type RoutePlanningEndDto,
  type RouteOptimizeMetric,
  type RouteVariant,
} from "@/lib/api/routes";
import { useDrivers } from "@/lib/api/drivers";
import { loadTripDraft, saveTripDraft, clearTripDraft } from "@/lib/trip-draft";
import { groupOrdersForTrip, type TripStopGroup } from "@routeflow/types";
import { TemplateRouteMap } from "../../routes/templates/[id]/TemplateRouteMap";
import type { VariantOverlay } from "../../routes/templates/[id]/TemplateRouteMap";
import {
  RoutePlanningControls,
  EMPTY_PLANNING_ADDRESS,
  EMPTY_END_DRAFT,
  type RoutePlanningValue,
  type RoutePlanningOriginKind,
  type RoutePlanningAddress,
  type RoutePlanningOriginSummary,
  type TripEndDraft,
  type RoutePlanningDriverOption,
} from "@/components/RoutePlanningControls";
import { RouteVariantsPanel } from "@/components/RouteVariantsPanel";
import { TripStopList } from "../_components/TripStopList";
import { TripSkippedPanel, type TripSkippedRow } from "../_components/TripSkippedPanel";
import { OrderPickerPanel } from "../_components/OrderPickerPanel";
import { DeliveryMobileLayout } from "../_components/DeliveryMobileLayout";
import type { DeliverySheetOverflowAction } from "../_components/DeliveryBottomSheet";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function summaryLabel(stopCount: number, orderCount: number): string {
  return `${stopCount} stop${stopCount !== 1 ? "s" : ""} · ${orderCount} order${
    orderCount !== 1 ? "s" : ""
  }`;
}

function originKindLabel(kind: RoutePlanningOriginKind): string {
  if (kind === "TENANT") return "Tenant depot";
  if (kind === "DRIVER") return "Driver's home base";
  return "Custom address";
}

/** Fixed candidate configs the variants endpoint solves under (WP3) — the
 *  `RouteVariant` response doesn't carry its own optimizeBy/avoidTolls, so
 *  this mirrors the server's config list to build ApplyRouteVariantDto. */
function variantConfigFor(
  key: RouteVariant["key"],
  currentAvoidTolls: boolean,
): { optimizeBy: RouteOptimizeMetric; avoidTolls: boolean } {
  if (key === "SHORTEST") return { optimizeBy: "DISTANCE", avoidTolls: currentAvoidTolls };
  if (key === "NO_TOLLS") return { optimizeBy: "TIME", avoidTolls: true };
  return { optimizeBy: "TIME", avoidTolls: currentAvoidTolls };
}

type Phase = "PICKING" | "BUILT";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NewTripPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => {
    setTitle("Plan a delivery");
  }, [setTitle]);

  // ── Order selection (from the orders-list "Plan delivery trip" bulkbar
  //    action, OR built up in-page via OrderPickerPanel) ──
  // orderIds is the real source of truth — every add/remove persists via
  // saveTripDraft so a refresh keeps the selection. Seeded ONCE from
  // loadTripDraft() client-side only (sessionStorage isn't available during
  // the SSR pass) — `hydrated` gates the initial render so we never flash an
  // empty picker before a real draft has had a chance to load.
  const [hydrated, setHydrated] = React.useState(false);
  const [orderIds, setOrderIds] = React.useState<string[]>([]);
  // Below `lg` (1024px, matches Tailwind's `lg:` breakpoint used everywhere
  // else on this page), the map-canvas + bottom-sheet layout replaces the
  // desktop two-column body — see DeliveryMobileLayout's doc comment for why
  // this is a JS boolean (deciding which ONE TemplateRouteMap mounts) rather
  // than a second `lg:hidden` CSS tree: a Google Maps instance is real and
  // billable, so exactly one may ever be live. Resolved in the same
  // client-only effect as `hydrated`, so there is no SSR/hydration flash —
  // both start out gated behind the `!hydrated` loading spinner below.
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    setOrderIds(loadTripDraft()?.orderIds ?? []);
    setHydrated(true);
    function updateIsMobile() {
      setIsMobile(window.innerWidth < 1024);
    }
    updateIsMobile();
    window.addEventListener("resize", updateIsMobile);
    return () => window.removeEventListener("resize", updateIsMobile);
  }, []);

  function persistOrderIds(next: string[]) {
    setOrderIds(next);
    saveTripDraft(next);
  }

  // ── Phase / created-route state ──
  const [phase, setPhase] = React.useState<Phase>("PICKING");
  const [routeId, setRouteId] = React.useState<string | null>(null);

  // ── Form state (PICKING) ──
  const [driverId, setDriverId] = React.useState("");
  const [originKind, setOriginKind] = React.useState<RoutePlanningOriginKind>("TENANT");
  const [originAddress, setOriginAddress] =
    React.useState<RoutePlanningAddress>(EMPTY_PLANNING_ADDRESS);
  const [end, setEnd] = React.useState<TripEndDraft>(EMPTY_END_DRAFT);
  const [avoidTolls, setAvoidTolls] = React.useState(false);
  const [optimizeBy, setOptimizeBy] = React.useState<RouteOptimizeMetric>("TIME");
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
  const [frozenOriginKind, setFrozenOriginKind] = React.useState<RoutePlanningOriginKind>("TENANT");

  // ── Route variants (Fastest/Shortest/No-tolls comparison, post-Build) ──
  const [variants, setVariants] = React.useState<RouteVariant[]>([]);
  const [selectedVariantKey, setSelectedVariantKey] = React.useState<RouteVariant["key"] | null>(
    null,
  );

  // ── Data ──
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
  const routeVariants = useRouteVariants();
  const applyVariant = useApplyRouteVariant();

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

  // ── Route planning controls (start/end/tolls/objective) ──
  // originSummary is display-only data RoutePlanningControls needs but can't
  // derive itself (the driver picker sits above it on this page) — recomputed
  // every render from routeSettings/selectedDriver, never stored in state.
  const originSummary: RoutePlanningOriginSummary = React.useMemo(
    () => ({
      depotAddress: routeSettings?.depotAddress,
      hasDepot,
      driverName: selectedDriver?.contactName,
      hasDriver: !!driverId,
      hasDriverHome,
      driverHref: driverId ? `/drivers/${driverId}` : null,
    }),
    [routeSettings?.depotAddress, hasDepot, selectedDriver?.contactName, driverId, hasDriverHome],
  );

  const planningValue: RoutePlanningValue = {
    originKind,
    originAddress,
    originSummary,
    end,
    avoidTolls,
    optimizeBy,
  };

  function handlePlanningChange(next: RoutePlanningValue) {
    setOriginKind(next.originKind);
    setOriginAddress(next.originAddress);
    setEnd(next.end);
    setAvoidTolls(next.avoidTolls);
    setOptimizeBy(next.optimizeBy);
  }

  // Candidate drivers for the "End at driver's home" option — distinct from
  // the origin's driver (chosen via the Driver select above).
  const endDriverOptions: RoutePlanningDriverOption[] = React.useMemo(
    () =>
      drivers.map((d) => ({
        id: d.id,
        name: d.contactName,
        hasHome: d.homeLat != null && d.homeLng != null,
      })),
    [drivers],
  );

  // ── Variant overlays for the map — only variants with a real polyline draw
  //    (a solver-only fallback with encodedPolyline: null never gets an overlay,
  //    which is exactly "keep today's single-route view" when Google fails). ──
  const variantOverlays: VariantOverlay[] = React.useMemo(
    () =>
      variants
        .filter((v): v is RouteVariant & { encodedPolyline: string } => !!v.encodedPolyline)
        .map((v) => ({
          encodedPolyline: v.encodedPolyline,
          color: "#3b82f6",
          selected: v.key === selectedVariantKey,
        })),
    [variants, selectedVariantKey],
  );
  const selectedVariant = variants.find((v) => v.key === selectedVariantKey) ?? null;

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

  // orderIds (the persisted draft) IS the picking selection now — grouping
  // already reflects it end-to-end via the eligibility query, so there's no
  // separate client-side exclusion set to intersect here (removal mutates
  // orderIds directly; see handleRemoveCustomer/handleRemoveOrder below).
  const pickingGroups = grouping.groups;
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
        : originAddress.line1.trim().length > 0;

  // The end point is resolved server-side exactly like the origin (geocode /
  // driver lookup, hard 400 on failure) — gate it client-side the same way
  // rather than letting Build fail after the click.
  const endReady =
    end.type === "ADDRESS"
      ? end.address.line1.trim().length > 0
      : end.type === "DRIVER_HOME"
        ? !!(end.driverId ?? driverId)
        : true;

  const endBlockedReason =
    end.type === "ADDRESS" && !endReady
      ? "Enter the custom end address in Route options"
      : end.type === "DRIVER_HOME" && !endReady
        ? "Choose a driver for the end point in Route options"
        : null;

  const canBuild =
    !createTrip.isPending &&
    !eligLoading &&
    !eligError &&
    pickingGroups.length > 0 &&
    originReady &&
    endReady;

  function buildOrigin(): TripOrigin {
    if (originKind === "DRIVER") return { type: "DRIVER", driverId };
    if (originKind === "ADDRESS")
      return {
        type: "ADDRESS",
        line1: originAddress.line1.trim(),
        city: originAddress.city.trim() || undefined,
        state: originAddress.state.trim() || undefined,
        zip: originAddress.zip.trim() || undefined,
      };
    return { type: "TENANT" };
  }

  function buildEndDto(): RoutePlanningEndDto | undefined {
    if (end.type === "NONE") return undefined;
    if (end.type === "RETURN_TO_START") return { type: "RETURN_TO_START" };
    if (end.type === "DRIVER_HOME") return { type: "DRIVER_HOME", driverId: end.driverId };
    return {
      type: "ADDRESS",
      line1: end.address.line1.trim(),
      city: end.address.city.trim() || undefined,
      state: end.address.state.trim() || undefined,
      zip: end.address.zip.trim() || undefined,
    };
  }

  function handleRemoveCustomer(customerId: string) {
    const group = pickingGroups.find((g) => g.customerId === customerId);
    if (!group) return;
    const toRemove = new Set(group.orderIds);
    persistOrderIds(orderIds.filter((id) => !toRemove.has(id)));
  }

  function handleRemoveOrder(orderId: string) {
    persistOrderIds(orderIds.filter((id) => id !== orderId));
  }

  function handleAddOrder(orderId: string) {
    if (orderIds.includes(orderId)) return;
    persistOrderIds([...orderIds, orderId]);
  }

  function handleBuild() {
    if (!canBuild) return;
    const groupsSnapshot = pickingGroups;
    const idsSnapshot = remainingIds;
    const skippedSnapshot = skippedRows;
    setVariants([]);
    setSelectedVariantKey(null);
    createTrip.mutate(
      {
        orderIds: idsSnapshot,
        driverId: driverId || undefined,
        origin: buildOrigin(),
        end: buildEndDto(),
        avoidTolls,
        optimizeBy,
      },
      {
        onSuccess: (route) => {
          setRouteId(route.id);
          setFrozenGroups(groupsSnapshot);
          setFrozenOrderIds(idsSnapshot);
          setFrozenSkipped(skippedSnapshot);
          setFrozenOriginKind(originKind);
          setPhase("BUILT");
          toast({
            title: "Delivery created",
            description: `${summaryLabel(groupsSnapshot.length, idsSnapshot.length)} — review and send below.`,
            variant: "success",
          });
          optimizeTemplate.mutate(route.id, {
            onError: (err) =>
              toast({
                title: "Delivery created; optimization unavailable — stops in selection order",
                description: err.message,
                variant: "warning",
              }),
          });
          // Never blocks/errors the BUILT view — a Google failure (or the
          // mutation itself rejecting) just means no comparison cards, and
          // the page falls back to today's single-route map unchanged.
          routeVariants.mutate(route.id, {
            onSuccess: (result) => {
              setVariants(result.variants);
              const preferred =
                result.variants.find((v) => v.key === "FASTEST") ?? result.variants[0];
              setSelectedVariantKey(preferred?.key ?? null);
            },
            onError: () => {
              setVariants([]);
              setSelectedVariantKey(null);
            },
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
            toast({
              title: "Failed to create delivery",
              description: err.message,
              variant: "error",
            });
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

  function handleUseVariant() {
    if (!routeId || !selectedVariant || applyVariant.isPending) return;
    const config = variantConfigFor(selectedVariant.key, avoidTolls);
    applyVariant.mutate(
      {
        routeId,
        key: selectedVariant.key,
        stopIds: selectedVariant.stopIds,
        optimizeBy: config.optimizeBy,
        avoidTolls: config.avoidTolls,
        encodedPolyline: selectedVariant.encodedPolyline,
      },
      {
        onSuccess: () => {
          // useApplyRouteVariant already invalidates ["routes", routeId], so
          // useRoute(routeId) above refetches on its own — the stop list and
          // map re-number from the fresh builtRoute.stops without extra code.
          setOptimizeBy(config.optimizeBy);
          setAvoidTolls(config.avoidTolls);
          toast({
            title: "Route updated",
            description: "Using the selected route.",
            variant: "success",
          });
        },
        onError: (err) =>
          toast({ title: "Failed to apply route", description: err.message, variant: "error" }),
      },
    );
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
                  title: "Delivery dispatched with skipped orders",
                  description: `${summaryLabel(frozenGroups.length, attached)}${driverSuffix} — ${dropped} order${
                    dropped !== 1 ? "s" : ""
                  } changed since you built the delivery and were left off.`,
                  variant: "warning",
                }
              : {
                  title: "Delivery dispatched",
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
        toast({ title: "Delivery discarded", variant: "success" });
        router.push("/deliveries");
      },
      onError: (err) =>
        toast({ title: "Failed to discard delivery", description: err.message, variant: "error" }),
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
          toast({ title: "Delivery name saved", variant: "success" });
        },
        onError: (err) =>
          toast({ title: "Save failed", description: err.message, variant: "error" }),
      },
    );
  }

  // ── Mobile (< lg) sheet content — built here, not inside the desktop JSX
  //    below, so the desktop branch stays byte-for-byte what it was before
  //    this batch (owner spec item 8). A little markup duplication (the
  //    driver/date grid, the built-phase summary box) is the trade for that
  //    guarantee — see DeliveryMobileLayout's doc comment for the map-mount
  //    half of the same guarantee. ──
  const mobilePlanningSlot = (
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
      <div className="mt-4">
        <RoutePlanningControls
          value={planningValue}
          onChange={handlePlanningChange}
          drivers={endDriverOptions}
        />
      </div>
    </>
  );

  const mobileBuiltSummarySlot = (
    <div className="space-y-1 rounded-lg border border-surface-border bg-surface-raised p-3 text-sm">
      <p className="text-navy">
        <span className="font-medium">Start:</span> {originKindLabel(frozenOriginKind)}
        {builtRoute?.depotAddress ? ` — ${builtRoute.depotAddress}` : ""}
      </p>
      <p className="text-navy">
        <span className="font-medium">Driver:</span> {selectedDriver?.contactName ?? "Unassigned"}
      </p>
      <p className="text-navy">
        <span className="font-medium">Date:</span> {new Date(date).toLocaleDateString()}
      </p>
    </div>
  );

  const mobileSummary =
    phase === "BUILT"
      ? summaryLabel(frozenGroups.length, frozenOrderIds.length)
      : summaryLabel(pickingGroups.length, remainingIds.length);

  const mobilePrimary =
    phase === "PICKING"
      ? {
          label: createTrip.isPending
            ? "Building…"
            : `Build ${summaryLabel(pickingGroups.length, remainingIds.length)}`,
          onClick: handleBuild,
          disabled: !canBuild,
          loading: createTrip.isPending,
        }
      : {
          label: createRun.isPending
            ? "Sending…"
            : `Send${selectedDriver ? ` to ${selectedDriver.contactName}` : ""}`,
          onClick: handleSend,
          disabled: createRun.isPending,
          loading: createRun.isPending,
        };

  const mobileOverflow: DeliverySheetOverflowAction[] | undefined =
    phase === "BUILT"
      ? confirmDiscard
        ? [
            {
              key: "discard-confirm",
              label: deleteRoute.isPending ? "Discarding…" : "Yes, discard delivery",
              onClick: handleDiscard,
              disabled: deleteRoute.isPending,
              destructive: true,
            },
            {
              key: "discard-cancel",
              label: "Cancel",
              onClick: () => setConfirmDiscard(false),
            },
          ]
        : [
            {
              key: "reoptimize",
              label: optimizeTemplate.isPending ? "Optimizing…" : "Re-optimize",
              onClick: handleReoptimize,
              disabled: optimizeTemplate.isPending || (builtRoute?.stops?.length ?? 0) < 2,
            },
            {
              key: "discard",
              label: "Discard delivery",
              onClick: () => setConfirmDiscard(true),
              destructive: true,
              keepOpen: true,
            },
          ]
      : undefined;

  // ── Loading (Design directive 4 — no dead ends): direct navigation with no
  //    (or an expired) draft no longer dead-ends into a separate empty-state
  //    screen — it falls straight into the same builder below with orderIds
  //    starting empty, OrderPickerPanel expanded, and a hint pointing back to
  //    the Orders list bulk action. ──

  if (!hydrated) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      {/* ── Top bar ── */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-surface-border bg-white px-6 py-3">
        <Link
          href="/deliveries"
          className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Deliveries
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
            {builtRoute?.name ?? "Delivery"}
            <Pencil className="h-3 w-3 text-navy/40" />
          </button>
        ) : (
          <h2 className="text-base font-bold text-navy">Plan a delivery</h2>
        )}

        <Badge
          variant="neutral"
          label={
            phase === "BUILT"
              ? "Draft delivery"
              : `${orderIds.length} order${orderIds.length !== 1 ? "s" : ""} selected`
          }
        />

        {/* Below `lg` the primary action + Re-optimize/Discard move into the
            bottom sheet's own header (DeliveryMobileLayout) — see owner spec
            item 5. `hidden lg:flex` keeps this row's lg+ rendering identical
            to before; it's simply invisible (and inert) under 1024px. */}
        <div className="ml-auto hidden items-center gap-2 lg:flex">
          {phase === "PICKING" && (
            <Button
              loading={createTrip.isPending}
              onClick={handleBuild}
              disabled={!canBuild}
              title={
                !originReady
                  ? "Choose a valid start point first"
                  : (endBlockedReason ??
                    (pickingGroups.length === 0 ? "No eligible stops selected" : undefined))
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
                  <span className="text-xs font-medium text-danger">Discard delivery?</span>
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
                  title="Discard this delivery"
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
      {isMobile ? (
        <DeliveryMobileLayout
          phase={phase}
          mapStops={phase === "BUILT" ? (builtRoute?.stops ?? []) : []}
          depotLat={
            phase === "BUILT" ? (builtRoute?.depotLat ?? undefined) : routeSettings?.depotLat
          }
          depotLng={
            phase === "BUILT" ? (builtRoute?.depotLng ?? undefined) : routeSettings?.depotLng
          }
          depotAddress={
            phase === "BUILT"
              ? (builtRoute?.depotAddress ?? undefined)
              : routeSettings?.depotAddress
          }
          plannedPolyline={phase === "BUILT" ? builtRoute?.plannedPolyline : undefined}
          variantOverlays={
            phase === "BUILT" && variantOverlays.length > 0 ? variantOverlays : undefined
          }
          groups={displayGroups}
          orderLookup={orderLookup}
          skipped={displaySkipped}
          onRemoveCustomer={handleRemoveCustomer}
          onRemoveOrder={handleRemoveOrder}
          stopsLoading={eligLoading}
          stopsError={eligError}
          onRetryStops={() => refetchEligibility()}
          orderIds={orderIds}
          onAddOrder={handleAddOrder}
          orderPickerHint={
            orderIds.length === 0
              ? 'You can also select orders on the Orders list and choose "Plan delivery trip".'
              : undefined
          }
          variants={variants}
          selectedVariantKey={selectedVariantKey}
          onSelectVariant={(v) => setSelectedVariantKey(v.key)}
          variantsLoading={routeVariants.isPending}
          onUseVariant={handleUseVariant}
          useVariantDisabled={!selectedVariant}
          useVariantPending={applyVariant.isPending}
          summary={mobileSummary}
          primary={mobilePrimary}
          overflow={mobileOverflow}
          planningSlot={mobilePlanningSlot}
          builtSummarySlot={mobileBuiltSummarySlot}
        />
      ) : (
        <div className="flex min-h-0 flex-1" data-testid="delivery-desktop-layout">
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

                <RoutePlanningControls
                  value={planningValue}
                  onChange={handlePlanningChange}
                  drivers={endDriverOptions}
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

            {phase === "PICKING" && (
              <OrderPickerPanel
                excludeIds={orderIds}
                onAdd={handleAddOrder}
                defaultOpen={orderIds.length === 0}
                hint={
                  orderIds.length === 0
                    ? 'You can also select orders on the Orders list and choose "Plan delivery trip".'
                    : undefined
                }
              />
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
                  onRemoveOrder={phase === "PICKING" ? handleRemoveOrder : undefined}
                  emptyMessage="No eligible stops selected."
                />
              )}
            </div>

            <TripSkippedPanel rows={displaySkipped} />
          </div>

          {/* Right panel — variants + map */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {phase === "BUILT" ? (
              <>
                {(routeVariants.isPending || variants.length > 0) && (
                  <div className="shrink-0 space-y-2 border-b border-surface-border bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                        Compare routes
                      </h3>
                      {variants.length > 0 && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={handleUseVariant}
                          disabled={!selectedVariant || applyVariant.isPending}
                        >
                          {applyVariant.isPending ? "Applying…" : "Use this route"}
                        </Button>
                      )}
                    </div>
                    <RouteVariantsPanel
                      variants={variants}
                      selectedKey={selectedVariantKey}
                      onSelect={(v) => setSelectedVariantKey(v.key)}
                      loading={routeVariants.isPending}
                    />
                  </div>
                )}
                <div className="flex-1 overflow-hidden">
                  {/* `!isMobile` never changes this render at `lg`+ (isMobile is
                    always false there) — see DeliveryMobileLayout's doc
                    comment for why it guards this mount: only one live,
                    billable TemplateRouteMap/Google-Maps instance may exist
                    at a time, and DeliveryMobileLayout owns the other one. */}
                  {!isMobile && (
                    <TemplateRouteMap
                      stops={builtRoute?.stops ?? []}
                      depotLat={builtRoute?.depotLat ?? undefined}
                      depotLng={builtRoute?.depotLng ?? undefined}
                      depotAddress={builtRoute?.depotAddress ?? undefined}
                      plannedPolyline={builtRoute?.plannedPolyline}
                      variantOverlays={variantOverlays.length > 0 ? variantOverlays : undefined}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-raised text-navy/70">
                <MapPin className="h-10 w-10" />
                <p className="text-sm">The route map appears here once the delivery is built.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
