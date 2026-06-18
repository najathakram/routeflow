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
  type RouteRunStop,
} from "@/lib/api/routes";
import { EditRunModal } from "../_components/EditRunModal";
import { RouteMap } from "./RouteMap";

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

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      {showEditModal && <EditRunModal run={run} onClose={() => setShowEditModal(false)} />}

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
