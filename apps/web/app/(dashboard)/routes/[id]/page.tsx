"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  Package,
  FileText,
  ChevronDown,
  ChevronRight,
  Sparkles,
  GripVertical,
  Pencil,
  Trash2,
  DoorOpen,
  Settings2,
  GitCompare,
  ExternalLink,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Badge, Button, Modal, cn, useToast } from "@routeflow/ui/web";
import { useQueryClient } from "@tanstack/react-query";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import {
  useRouteRun,
  useOptimizeRoute,
  useReorderRunStops,
  useDeleteRouteRun,
  useUpdateRouteRunStatus,
  useRoute,
  useRouteSettings,
  useUpdateRoutePlanning,
  useRouteVariants,
  useApplyRouteVariant,
  type RouteRunStop,
  type Route,
  type RouteVariant,
  type RouteOptimizeMetric,
  type TripOrigin,
  type RoutePlanningEndDto,
} from "@/lib/api/routes";
import { useDrivers, useDriver } from "@/lib/api/drivers";
import {
  RoutePlanningControls,
  EMPTY_PLANNING_ADDRESS,
  type RoutePlanningValue,
  type RoutePlanningDriverOption,
} from "@/components/RoutePlanningControls";
import { RouteVariantsPanel } from "@/components/RouteVariantsPanel";
import { buildGoogleMapsLegs, type GmapsPoint } from "@/lib/gmaps-export";
import { EditRunModal } from "../_components/EditRunModal";
import { RouteMap, type VariantOverlay } from "./RouteMap";
import { ArrivedStopSheet } from "@/components/ArrivedStopSheet";

// ─── Open in Google Maps export ───────────────────────────────────────────────
//
// Pure client-side URL building (lib/gmaps-export.ts) — no server call, no key.
// A single leg renders as a plain link; a long stop list chunks into
// sequential legs behind a small dropdown so a driver can tap through them.

function GmapsExportButton({ points }: { points: GmapsPoint[] }) {
  const [open, setOpen] = React.useState(false);
  const legs = React.useMemo(() => buildGoogleMapsLegs(points), [points]);

  if (legs.length === 0) return null;

  const linkClass =
    "flex items-center gap-1.5 rounded border border-surface-border px-2.5 py-1.5 text-xs font-medium text-navy/70 shadow-card transition-colors hover:border-brand-300 hover:text-navy";

  if (legs.length === 1) {
    return (
      <a
        href={legs[0].url}
        target="_blank"
        rel="noopener noreferrer"
        title="Stop order is preserved — Google Maps re-checks roads live."
        className={linkClass}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in Google Maps
      </a>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Stop order is preserved — Google Maps re-checks roads live."
        className={linkClass}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in Google Maps
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <ul className="absolute right-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-lg border border-surface-border bg-white shadow-lg">
            {legs.map((leg) => (
              <li key={leg.label}>
                <a
                  href={leg.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className="block px-3 py-2 text-xs font-medium text-navy hover:bg-surface-raised transition-colors"
                >
                  {leg.label}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ─── Route planning summaries ─────────────────────────────────────────────────

function planningOriginLabel(route?: Route | null): string {
  if (!route) return "Loading…";
  if (route.originKind === "DRIVER") return route.depotAddress || "Driver's home base";
  if (route.originKind === "ADDRESS") return route.depotAddress || "Custom address";
  return route.depotAddress || "Tenant depot";
}

function planningEndLabel(route?: Route | null): string {
  if (!route) return "Loading…";
  switch (route.endKind) {
    case "RETURN_TO_START":
      return "Return to start";
    case "DRIVER_HOME":
      return route.endAddress || "Driver's home";
    case "ADDRESS":
      return route.endAddress || "Custom address";
    default:
      return "End at last stop";
  }
}

/** Mirrors the server's variant configs (route-optimization.service.ts §WP3) so
 *  the client can round-trip optimizeBy/avoidTolls when applying a chosen
 *  variant — `RouteVariant` itself only carries stopIds/duration/distance/etc.
 *  When the route already enforces avoidTolls, every config (including
 *  Fastest/Shortest) is solved under avoidTolls too — mirror that here. */
function variantSettings(
  key: RouteVariant["key"],
  currentAvoidTolls: boolean,
): { optimizeBy: RouteOptimizeMetric; avoidTolls: boolean } {
  if (key === "NO_TOLLS") return { optimizeBy: "TIME", avoidTolls: true };
  if (key === "SHORTEST") return { optimizeBy: "DISTANCE", avoidTolls: currentAvoidTolls };
  return { optimizeBy: "TIME", avoidTolls: currentAvoidTolls };
}

// ─── Stop status icon ─────────────────────────────────────────────────────────

type StopStatus = RouteRunStop["status"];

function StopIcon({ status }: { status: StopStatus }) {
  if (status === "COMPLETED") return <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />;
  if (status === "IN_PROGRESS")
    return <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-500" />;
  if (status === "SKIPPED") return <XCircle className="h-5 w-5 shrink-0 text-danger" />;
  return <Circle className="h-5 w-5 shrink-0 text-navy/25" />;
}

// ─── Sortable stop item ────────────────────────────────────────────────────────

function SortableStopItem({ stop, draggable }: { stop: RouteRunStop; draggable: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stop.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <li ref={setNodeRef} style={style}>
      <StopItem
        stop={stop}
        dragHandleProps={draggable ? { ...attributes, ...listeners } : undefined}
      />
    </li>
  );
}

// ─── Stop item ────────────────────────────────────────────────────────────────

function StopItem({
  stop,
  dragHandleProps,
  onAtDoorActions,
}: {
  stop: RouteRunStop;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  onAtDoorActions?: (stop: RouteRunStop) => void;
}) {
  const [expanded, setExpanded] = React.useState(stop.status === "IN_PROGRESS");

  const addressLine = stop.customerAddress
    ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}, ${stop.customerAddress.state}`
    : null;

  const completedAt = stop.completedAt
    ? new Date(stop.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        stop.status === "IN_PROGRESS"
          ? "border-brand-200 bg-brand-50"
          : stop.status === "COMPLETED"
            ? "border-surface-border bg-white"
            : "border-surface-border bg-white opacity-70",
      )}
    >
      <div className="flex items-start gap-2 p-3">
        {dragHandleProps && (
          <button
            {...dragHandleProps}
            className="mt-0.5 cursor-grab touch-none text-navy/25 hover:text-navy/70 active:cursor-grabbing"
            aria-label="Drag to reorder"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <button
          className="flex flex-1 items-start gap-3 text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          <StopIcon status={stop.status} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-navy/70">#{stop.stopNumber}</span>
              <span className="font-medium text-navy truncate">
                {stop.customer?.businessName ?? stop.customerId}
              </span>
              {stop.status === "IN_PROGRESS" && (
                <span className="ml-auto shrink-0 rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold text-white">
                  CURRENT
                </span>
              )}
            </div>
            {addressLine && <p className="mt-0.5 truncate text-xs text-navy/70">{addressLine}</p>}
            {completedAt && (
              <p className="mt-0.5 text-xs text-success/80">Completed {completedAt}</p>
            )}
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-navy/30" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-navy/30" />
          )}
        </button>
      </div>

      {stop.status === "IN_PROGRESS" && onAtDoorActions && (
        <div className="px-3 pb-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtDoorActions(stop);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-xs font-semibold text-brand-700 shadow-card transition-colors hover:bg-surface-raised"
          >
            <DoorOpen className="h-3.5 w-3.5" />
            At-door actions
          </button>
        </div>
      )}

      {expanded && (
        <div className="border-t border-surface-border px-3 pb-3 pt-2 space-y-2">
          {stop.orders && stop.orders.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-navy/70">
                <Package className="h-3.5 w-3.5" /> Orders
              </p>
              <ul className="space-y-0.5">
                {stop.orders.map((order) => (
                  <li
                    key={order.id}
                    className="flex items-center justify-between text-xs text-navy"
                  >
                    <span>
                      {order.orderNumber ? (
                        `#${order.orderNumber}`
                      ) : (
                        <span className="text-navy/70 italic">No order #</span>
                      )}
                    </span>
                    <span className="text-navy/70">{order.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {stop.driverNote && (
            <div className="rounded bg-warning-bg p-2">
              <p className="flex items-center gap-1 text-xs font-semibold text-warning">
                <FileText className="h-3.5 w-3.5" /> Driver note
              </p>
              <p className="mt-0.5 text-xs text-navy/80">{stop.driverNote}</p>
            </div>
          )}
          {!stop.orders?.length && !stop.driverNote && (
            <p className="text-xs text-navy/70 italic">No orders or notes for this stop.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RouteRunDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { user } = useAuth();
  const { toast } = useToast();
  const { data: run, isLoading, isError } = useRouteRun(params.id);
  const { mutate: optimizeRoute, isPending: isOptimizing } = useOptimizeRoute();
  const { mutate: reorderRunStops } = useReorderRunStops();
  const { mutate: deleteRun, isPending: isDeleting } = useDeleteRouteRun();
  const { mutate: updateStatus, isPending: isCancelling } = useUpdateRouteRunStatus();

  const isOperator = user?.role === "OPERATOR";
  const queryClient = useQueryClient();
  const [showEditModal, setShowEditModal] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [atDoorStop, setAtDoorStop] = React.useState<RouteRunStop | null>(null);

  // Local stops state for optimistic DnD reordering
  const [localStops, setLocalStops] = React.useState<RouteRunStop[]>([]);
  React.useEffect(() => {
    if (run?.stops) setLocalStops(run.stops);
  }, [run?.stops]);

  // ── Route planning (start/end/tolls/objective) + variants + Google Maps export ──
  const { data: route } = useRoute(run?.routeId ?? "");
  const { data: routeSettings } = useRouteSettings();
  // The ROUTE's driver, not the run's: a "start from driver's home" origin is a
  // property of the template and must not follow a per-run driver swap.
  const { data: routeDriver } = useDriver(route?.driverId ?? "");
  const { data: activeDriversData } = useDrivers({ status: "ACTIVE", limit: 100 });
  const updatePlanning = useUpdateRoutePlanning();
  const routeVariants = useRouteVariants();
  const applyVariant = useApplyRouteVariant();

  const [planningCardOpen, setPlanningCardOpen] = React.useState(false);
  const [showPlanningModal, setShowPlanningModal] = React.useState(false);
  const [planningValue, setPlanningValue] = React.useState<RoutePlanningValue | null>(null);
  // What the modal was seeded with. `origin`/`end` are re-resolved server-side
  // (geocode / driver lookup) on every PATCH that carries them, so sending an
  // untouched one can hard-400 an unrelated toll toggle — or silently move the
  // depot. Diffing against this snapshot keeps the PATCH to what changed.
  const [planningSnapshot, setPlanningSnapshot] = React.useState<RoutePlanningValue | null>(null);
  const [showVariants, setShowVariants] = React.useState(false);
  const [selectedVariantKey, setSelectedVariantKey] = React.useState<RouteVariant["key"] | null>(
    null,
  );

  const gmapsPoints: GmapsPoint[] = React.useMemo(() => {
    const points: GmapsPoint[] = [];
    if (route?.depotLat != null && route?.depotLng != null) {
      points.push({ lat: route.depotLat, lng: route.depotLng });
    }
    const orderedStops = localStops.length ? localStops : (run?.stops ?? []);
    [...orderedStops]
      .sort((a, b) => a.stopNumber - b.stopNumber)
      .forEach((s) => {
        if (s.customerAddress?.lat != null && s.customerAddress?.lng != null) {
          points.push({ lat: s.customerAddress.lat, lng: s.customerAddress.lng });
        }
      });
    if (
      route?.endKind &&
      route.endKind !== "NONE" &&
      route.endLat != null &&
      route.endLng != null
    ) {
      points.push({ lat: route.endLat, lng: route.endLng });
    }
    return points;
  }, [route, localStops, run?.stops]);

  const mapVariantOverlays: VariantOverlay[] = React.useMemo(() => {
    if (!showVariants) return [];
    return (routeVariants.data?.variants ?? [])
      .filter((v): v is RouteVariant & { encodedPolyline: string } => !!v.encodedPolyline)
      .map((v) => ({
        encodedPolyline: v.encodedPolyline,
        color: "#3b82f6",
        selected: v.key === selectedVariantKey,
      }));
  }, [showVariants, routeVariants.data, selectedVariantKey]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = localStops.findIndex((s) => s.id === active.id);
    const newIndex = localStops.findIndex((s) => s.id === over.id);
    const reordered = arrayMove(localStops, oldIndex, newIndex).map((s, i) => ({
      ...s,
      stopNumber: i + 1,
    }));
    setLocalStops(reordered);

    reorderRunStops(
      { runId: params.id, order: reordered.map((s) => ({ id: s.id, stopNumber: s.stopNumber })) },
      {
        onError: (err) => {
          queryClient.invalidateQueries({ queryKey: ["route-runs", params.id] });
          toast({ title: "Reorder failed", description: err.message, variant: "error" });
        },
      },
    );
  };

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
            "Route intelligence is not configured. Set ORS_API_KEY in the API environment to enable true optimization.",
          ORS_RATE_LIMITED: "Route intelligence rate limit hit — try again in a minute.",
          ORS_HTTP_ERROR:
            "Couldn't reach route intelligence (server error). Used estimated distance instead.",
          ORS_NETWORK_ERROR:
            "Couldn't reach route intelligence (network error). Used estimated distance instead.",
          GOOGLE_MATRIX_FALLBACK:
            "Live road distances were unavailable — used estimated distances instead. Check the Google Maps key / Routes API.",
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

  const handleDelete = () => {
    deleteRun(params.id, {
      onSuccess: () => {
        toast({ title: "Route run deleted", variant: "success" });
        router.push("/routes");
      },
      onError: (err) =>
        toast({ title: "Delete failed", description: err.message, variant: "error" }),
    });
  };

  const handleCancel = () => {
    if (isCancelling) return;
    updateStatus(
      { id: params.id, status: "CANCELLED" },
      {
        onSuccess: () => {
          toast({ title: "Route run cancelled", variant: "success" });
          setConfirmCancel(false);
          router.push("/routes");
        },
        onError: (err) =>
          toast({ title: "Cancel failed", description: err.message, variant: "error" }),
      },
    );
  };

  const planningDriverOptions: RoutePlanningDriverOption[] = (activeDriversData?.data ?? []).map(
    (d) => ({
      id: d.id,
      name: d.contactName,
      hasHome: d.homeLat != null && d.homeLng != null,
    }),
  );

  const buildPlanningValue = (): RoutePlanningValue => {
    const originKind = (route?.originKind ?? "TENANT") as RoutePlanningValue["originKind"];
    const endKind = route?.endKind ?? "NONE";
    return {
      originKind,
      originAddress:
        originKind === "ADDRESS"
          ? { ...EMPTY_PLANNING_ADDRESS, line1: route?.depotAddress ?? "" }
          : EMPTY_PLANNING_ADDRESS,
      originSummary: {
        depotAddress: routeSettings?.depotAddress ?? null,
        hasDepot: routeSettings?.depotLat != null && routeSettings?.depotLng != null,
        driverName: routeDriver?.contactName ?? null,
        hasDriver: !!route?.driverId,
        hasDriverHome: routeDriver?.homeLat != null && routeDriver?.homeLng != null,
        driverHref: route?.driverId ? `/drivers/${route.driverId}` : null,
      },
      end: {
        type: endKind,
        driverId: undefined,
        address:
          endKind === "ADDRESS"
            ? { ...EMPTY_PLANNING_ADDRESS, line1: route?.endAddress ?? "" }
            : EMPTY_PLANNING_ADDRESS,
      },
      avoidTolls: route?.avoidTolls ?? false,
      optimizeBy: route?.optimizeBy ?? "TIME",
    };
  };

  const handleOpenPlanningModal = () => {
    const seeded = buildPlanningValue();
    setPlanningValue(seeded);
    setPlanningSnapshot(seeded);
    setShowPlanningModal(true);
  };

  const handleSavePlanning = () => {
    if (!planningValue || !run?.routeId) return;
    const originChanged =
      !planningSnapshot ||
      planningValue.originKind !== planningSnapshot.originKind ||
      JSON.stringify(planningValue.originAddress) !==
        JSON.stringify(planningSnapshot.originAddress);
    const endChanged =
      !planningSnapshot ||
      planningValue.end.type !== planningSnapshot.end.type ||
      planningValue.end.driverId !== planningSnapshot.end.driverId ||
      JSON.stringify(planningValue.end.address) !== JSON.stringify(planningSnapshot.end.address);

    // The DRIVER origin means "the route template's driver's home" — reading it
    // off the RUN would silently retarget the depot to a substitute driver's
    // house after a Change Driver.
    const origin: TripOrigin | undefined = !originChanged
      ? undefined
      : planningValue.originKind === "TENANT"
        ? { type: "TENANT" }
        : planningValue.originKind === "DRIVER"
          ? { type: "DRIVER", driverId: route?.driverId ?? "" }
          : { type: "ADDRESS", ...planningValue.originAddress };
    const end: RoutePlanningEndDto | undefined = !endChanged
      ? undefined
      : planningValue.end.type === "DRIVER_HOME"
        ? { type: "DRIVER_HOME", driverId: planningValue.end.driverId }
        : planningValue.end.type === "ADDRESS"
          ? { type: "ADDRESS", ...planningValue.end.address }
          : { type: planningValue.end.type };
    // Same snapshot-diff for the scalar settings — a no-op save must not claim
    // "re-optimize recommended" or null the stored polyline server-side.
    const avoidTolls =
      !planningSnapshot || planningValue.avoidTolls !== planningSnapshot.avoidTolls
        ? planningValue.avoidTolls
        : undefined;
    const optimizeBy =
      !planningSnapshot || planningValue.optimizeBy !== planningSnapshot.optimizeBy
        ? planningValue.optimizeBy
        : undefined;

    updatePlanning.mutate(
      {
        routeId: run.routeId,
        origin,
        end,
        avoidTolls,
        optimizeBy,
      },
      {
        onSuccess: (result) => {
          setShowPlanningModal(false);
          setShowVariants(false);
          setSelectedVariantKey(null);
          toast({
            title: "Route planning updated",
            description: result.reoptimizeRecommended
              ? "Re-optimize to apply the new settings to stop order."
              : undefined,
            variant: "success",
            action: result.reoptimizeRecommended
              ? { label: "Re-optimize now", onClick: handleOptimize }
              : undefined,
          });
        },
        onError: (err: any) =>
          toast({
            title: "Couldn't update route planning",
            description: err?.response?.data?.message ?? err.message,
            variant: "error",
          }),
      },
    );
  };

  const handleCompareRoutes = () => {
    if (!run?.routeId) return;
    setShowVariants(true);
    setSelectedVariantKey(null);
    routeVariants.mutate(run.routeId, {
      onSuccess: (result) => {
        // Default to Fastest; fall back to whatever came back first (the
        // solver-only fallback returns a single variant of a different key).
        const preferred = result.variants.find((v) => v.key === "FASTEST") ?? result.variants[0];
        if (preferred) setSelectedVariantKey(preferred.key);
      },
      onError: (err: any) => {
        toast({
          title: "Couldn't compare routes",
          description: err?.response?.data?.message ?? err.message,
          variant: "error",
        });
        setShowVariants(false);
      },
    });
  };

  const handleApplyVariant = (variant: RouteVariant) => {
    if (!run?.routeId) return;
    const settings = variantSettings(variant.key, route?.avoidTolls ?? false);
    // The variant is solved against the route TEMPLATE, but this page shows the
    // RUN's stop list. Naming the run makes the server re-number both in ONE
    // transaction — no follow-up optimize (which would null the polyline the
    // apply just stored) and no window where list and map disagree.
    const reorderRun = run.status === "SCHEDULED";
    applyVariant.mutate(
      {
        routeId: run.routeId,
        key: variant.key,
        stopIds: variant.stopIds,
        optimizeBy: settings.optimizeBy,
        avoidTolls: settings.avoidTolls,
        encodedPolyline: variant.encodedPolyline,
        ...(reorderRun ? { runId: params.id } : {}),
      },
      {
        onSuccess: () => {
          setShowVariants(false);
          setSelectedVariantKey(null);
          queryClient.invalidateQueries({ queryKey: ["route-runs", params.id] });
          toast({
            title: "Route updated",
            description: reorderRun
              ? "The chosen route is now saved and this run's stops were reordered to match."
              : "The chosen route is saved for this route's future runs.",
            variant: "success",
          });
        },
        onError: (err: any) =>
          toast({
            title: "Couldn't apply route",
            description: err?.response?.data?.message ?? err.message,
            variant: "error",
          }),
      },
    );
  };

  const name = run?.route?.name ?? "Route";
  React.useEffect(() => {
    setTitle(name);
  }, [setTitle, name]);

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  if (isError || !run) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Route run not found.</p>
        <Button variant="secondary" href="/routes">
          Back to Routes
        </Button>
      </div>
    );
  }

  const stops = localStops.length ? localStops : (run.stops ?? []);
  const stopsDone = stops.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED").length;
  const total = stops.length;
  const driverName = run.driver?.contactName ?? "Unassigned";
  const startTime = run.startedAt
    ? new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const canReorder = isOperator && run.status === "SCHEDULED";
  const canEdit = isOperator && run.status !== "COMPLETED" && run.status !== "CANCELLED";
  const canDelete = isOperator && run.status === "SCHEDULED";
  const canCancel = isOperator && (run.status === "IN_PROGRESS" || run.status === "SCHEDULED");

  const selectedVariant =
    routeVariants.data?.variants.find((v) => v.key === selectedVariantKey) ?? null;

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      {showEditModal && <EditRunModal run={run} onClose={() => setShowEditModal(false)} />}
      <ArrivedStopSheet
        open={!!atDoorStop}
        onClose={() => setAtDoorStop(null)}
        customerName={atDoorStop?.customer?.businessName ?? atDoorStop?.customerId ?? "Customer"}
        orders={atDoorStop?.orders}
      />

      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this run?"
        description={`Cancel the run for ${run.route?.name ?? "this route"}? The run will be marked CANCELLED and the route can be dispatched again.`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirmCancel(false)}
              disabled={isCancelling}
            >
              Keep run
            </Button>
            <Button variant="danger" onClick={handleCancel} loading={isCancelling}>
              Cancel run
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          Any in-progress stops will stop counting toward this run. This cannot be undone.
        </p>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete Route Run?"
        description={`Delete this route run for ${run.route?.name ?? "this route"}? This cannot be undone.`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirmDelete(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={isDeleting}>
              Delete Route Run
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          This will permanently remove this scheduled run. Stops and delivery records will be lost.
        </p>
      </Modal>

      <Modal
        open={showPlanningModal}
        onClose={() => setShowPlanningModal(false)}
        title="Route planning"
        description="Choose where this route starts and ends, tolls, and the optimization objective."
        className="max-h-[85vh] overflow-y-auto"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setShowPlanningModal(false)}
              disabled={updatePlanning.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSavePlanning}
              loading={updatePlanning.isPending}
              disabled={!planningValue}
            >
              Save
            </Button>
          </>
        }
      >
        {planningValue && (
          <RoutePlanningControls
            value={planningValue}
            onChange={setPlanningValue}
            drivers={planningDriverOptions}
            disabled={updatePlanning.isPending}
          />
        )}
      </Modal>

      {/* Top bar */}
      <div className="shrink-0 border-b border-surface-border bg-white px-6 py-4">
        <div className="flex items-center gap-4">
          <Link
            href="/routes"
            className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Routes
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
            <span className="text-sm text-navy/70">{driverName}</span>
            {startTime && (
              <>
                <span className="text-sm text-navy/70">·</span>
                <span className="text-sm text-navy/70">Started {startTime}</span>
              </>
            )}
            <span className="text-sm text-navy/70">·</span>
            <span className="text-sm text-navy/70">
              {stopsDone}/{total} stops
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* Edit — SCHEDULED only */}
            {canEdit && (
              <Button variant="secondary" size="sm" onClick={() => setShowEditModal(true)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            )}

            {/* Cancel — SCHEDULED or IN_PROGRESS */}
            {canCancel && run.status !== "CANCELLED" && !canDelete && (
              <Button variant="secondary" size="sm" onClick={() => setConfirmCancel(true)}>
                Cancel Run
              </Button>
            )}

            {/* Delete — SCHEDULED only, with confirm modal */}
            {canDelete && (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 rounded border border-surface-border px-2.5 py-1.5 text-xs font-medium text-danger hover:border-danger/40 hover:bg-danger/5 transition-colors"
                title="Delete run"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            )}

            {/* Optimize */}
            {isOperator && run.status !== "CANCELLED" && run.status !== "COMPLETED" && (
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
            )}

            {/* Open in Google Maps */}
            <GmapsExportButton points={gmapsPoints} />

            {/* Dispatch Panel */}
            <Button variant="primary" size="sm" href={`/routes/${run.id}/dispatch`}>
              Dispatch Panel
            </Button>
          </div>
        </div>
      </div>

      {/* Main split layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: Stop list (40%) ── */}
        <div className="flex w-[40%] shrink-0 flex-col overflow-hidden border-r border-surface-border">
          <div className="shrink-0 border-b border-surface-border bg-surface-raised px-4 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
              Stops ({total})
              {canReorder && (
                <span className="ml-1 font-normal normal-case">· drag to reorder</span>
              )}
            </p>
          </div>
          {canReorder ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={stops.map((s) => s.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="flex-1 space-y-2 overflow-y-auto p-4">
                  {stops.map((stop) => (
                    <SortableStopItem key={stop.id} stop={stop} draggable={true} />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          ) : (
            <ul className="flex-1 space-y-2 overflow-y-auto p-4">
              {stops.map((stop) => (
                <li key={stop.id}>
                  <StopItem stop={stop} onAtDoorActions={setAtDoorStop} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Right: Route planning + Map (60%) ── */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-surface-border bg-white">
            <button
              type="button"
              onClick={() => setPlanningCardOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left"
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-navy/70">
                <Settings2 className="h-3.5 w-3.5" />
                Route planning
              </span>
              {planningCardOpen ? (
                <ChevronDown className="h-4 w-4 text-navy/40" />
              ) : (
                <ChevronRight className="h-4 w-4 text-navy/40" />
              )}
            </button>
            {planningCardOpen && (
              <div className="space-y-3 px-4 pb-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-navy/80">
                  <div>
                    <span className="font-medium text-navy">Start:</span>{" "}
                    {planningOriginLabel(route)}
                  </div>
                  <div>
                    <span className="font-medium text-navy">End:</span> {planningEndLabel(route)}
                  </div>
                  <div>
                    <span className="font-medium text-navy">Tolls:</span>{" "}
                    {route?.avoidTolls ? "Avoided" : "Allowed"}
                  </div>
                  <div>
                    <span className="font-medium text-navy">Optimize by:</span>{" "}
                    {route?.optimizeBy === "DISTANCE" ? "Shortest distance" : "Fastest time"}
                  </div>
                </div>

                {canEdit && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleOpenPlanningModal}
                      disabled={!route}
                    >
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleCompareRoutes}
                      disabled={!route || routeVariants.isPending}
                    >
                      <GitCompare className="mr-1.5 h-3.5 w-3.5" />
                      {routeVariants.isPending ? "Comparing…" : "Compare routes"}
                    </Button>
                  </div>
                )}

                {showVariants && (
                  <div className="space-y-2 rounded-lg border border-surface-border bg-surface-raised p-3">
                    <RouteVariantsPanel
                      variants={routeVariants.data?.variants ?? []}
                      selectedKey={selectedVariantKey}
                      onSelect={(v) => setSelectedVariantKey(v.key)}
                      loading={routeVariants.isPending}
                    />
                    {!routeVariants.isPending &&
                      (routeVariants.data?.variants.length ?? 0) === 0 && (
                        <p className="text-xs text-navy/70">
                          No route comparison available for this route.
                        </p>
                      )}
                    {!routeVariants.isPending && selectedVariant && (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setShowVariants(false)}
                        >
                          Close
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleApplyVariant(selectedVariant)}
                          disabled={applyVariant.isPending}
                        >
                          {applyVariant.isPending ? "Applying…" : "Use this route"}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <RouteMap
            stops={stops}
            plannedPolyline={route?.plannedPolyline}
            variantOverlays={mapVariantOverlays}
          />
        </div>
      </div>
    </div>
  );
}
