"use client";

import * as React from "react";
import Link from "next/link";
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
import { Badge, Button, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import {
  useRouteRun,
  useOptimizeRoute,
  useReorderRunStops,
  type RouteRunStop,
} from "@/lib/api/routes";
import { RouteMap } from "./RouteMap";

// ─── Stop status icon ─────────────────────────────────────────────────────────

type StopStatus = RouteRunStop["status"];

function StopIcon({ status }: { status: StopStatus }) {
  if (status === "COMPLETED")
    return <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />;
  if (status === "IN_PROGRESS")
    return <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-500" />;
  if (status === "SKIPPED")
    return <XCircle className="h-5 w-5 shrink-0 text-danger" />;
  return <Circle className="h-5 w-5 shrink-0 text-navy/25" />;
}

// ─── Sortable stop list item ───────────────────────────────────────────────────

function SortableStopItem({
  stop,
  draggable,
}: {
  stop: RouteRunStop;
  draggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: stop.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <li ref={setNodeRef} style={style}>
      <StopItem stop={stop} dragHandleProps={draggable ? { ...attributes, ...listeners } : undefined} />
    </li>
  );
}

// ─── Stop list item ───────────────────────────────────────────────────────────

function StopItem({
  stop,
  dragHandleProps,
}: {
  stop: RouteRunStop;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
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
      {/* Header row */}
      <div className="flex items-start gap-2 p-3">
        {dragHandleProps && (
          <button
            {...dragHandleProps}
            className="mt-0.5 cursor-grab touch-none text-navy/25 hover:text-navy/50 active:cursor-grabbing"
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
              <span className="text-xs font-bold text-navy/40">#{stop.stopNumber}</span>
              <span className="font-medium text-navy truncate">
                {stop.customer?.businessName ?? stop.customerId}
              </span>
              {stop.status === "IN_PROGRESS" && (
                <span className="ml-auto shrink-0 rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold text-white">
                  CURRENT
                </span>
              )}
            </div>
            {addressLine && (
              <p className="mt-0.5 truncate text-xs text-navy/50">{addressLine}</p>
            )}
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

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-surface-border px-3 pb-3 pt-2 space-y-2">
          {/* Orders */}
          {stop.orders && stop.orders.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-navy/50">
                <Package className="h-3.5 w-3.5" /> Orders
              </p>
              <ul className="space-y-0.5">
                {stop.orders.map((order) => (
                  <li key={order.id} className="flex items-center justify-between text-xs text-navy">
                    <span>#{order.orderNumber}</span>
                    <span className="text-navy/50">{order.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Driver note */}
          {stop.driverNote && (
            <div className="rounded bg-warning-bg p-2">
              <p className="flex items-center gap-1 text-xs font-semibold text-warning">
                <FileText className="h-3.5 w-3.5" /> Driver note
              </p>
              <p className="mt-0.5 text-xs text-navy/80">{stop.driverNote}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RouteRunDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { user } = useAuth();
  const { toast } = useToast();
  const { data: run, isLoading, isError } = useRouteRun(params.id);
  const { mutate: optimizeRoute, isPending: isOptimizing } = useOptimizeRoute();
  const { mutate: reorderRunStops } = useReorderRunStops();

  const isOperator = user?.role === "OPERATOR";

  // Local stops state for optimistic DnD reordering
  const [localStops, setLocalStops] = React.useState<RouteRunStop[]>([]);
  React.useEffect(() => {
    if (run?.stops) setLocalStops(run.stops);
  }, [run?.stops]);

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
          setLocalStops(run?.stops ?? []);
          toast({ title: "Reorder failed", description: err.message, variant: "error" });
        },
      },
    );
  };

  const handleOptimize = () => {
    optimizeRoute(params.id, {
      onSuccess: (result) => {
        if (result.usedFallback) {
          toast({
            title: "Route optimized (local fallback)",
            description: `${result.reorderedCount} stops reordered using nearest-neighbor heuristic. Set ORS_API_KEY for full optimization.`,
          });
        } else {
          toast({
            title: "Route optimized",
            description: `${result.reorderedCount} stops reordered for the most efficient sequence.`,
          });
        }
      },
      onError: (err) => {
        toast({
          title: "Optimization failed",
          description: err.message,
          variant: "error",
        });
      },
    });
  };

  const name = run?.route?.name ?? "Route";

  React.useEffect(() => { setTitle(name); }, [setTitle, name]);

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
        <Button variant="secondary" href="/routes">Back to Routes</Button>
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

  // Only allow reordering when the run is still SCHEDULED
  const canReorder = isOperator && run.status === "SCHEDULED";

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      {/* Top bar */}
      <div className="shrink-0 border-b border-surface-border bg-white px-6 py-4">
        <div className="flex items-center gap-4">
          <Link href="/routes" className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors">
            <ArrowLeft className="h-4 w-4" />Routes
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
            <span className="text-sm text-navy/60">{driverName}</span>
            {startTime && (
              <>
                <span className="text-sm text-navy/40">·</span>
                <span className="text-sm text-navy/60">Started {startTime}</span>
              </>
            )}
            <span className="text-sm text-navy/40">·</span>
            <span className="text-sm text-navy/60">{stopsDone}/{total} stops</span>
          </div>
          {isOperator && (
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
              {isOptimizing ? "Optimizing…" : "Optimize Route"}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            href={`/routes/${run.id}/dispatch`}
          >
            Dispatch Panel
          </Button>
        </div>
      </div>

      {/* Main split layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: Stop list (40%) ── */}
        <div className="flex w-[40%] shrink-0 flex-col overflow-hidden border-r border-surface-border">
          <div className="shrink-0 border-b border-surface-border bg-surface-raised px-4 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/50">
              Stops ({total}){canReorder && <span className="ml-1 font-normal normal-case">· drag to reorder</span>}
            </p>
          </div>
          {canReorder ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={stops.map((s) => s.id)} strategy={verticalListSortingStrategy}>
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
                  <StopItem stop={stop} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Right: Map (60%) ── */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <RouteMap stops={stops} />
        </div>
      </div>
    </div>
  );
}
