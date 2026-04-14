"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  GripVertical,
  X,
  Plus,
  Printer,
  Play,
  Loader2,
  Package,
  ShoppingCart,
  MapPin,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Sparkles,
  Clock,
  Home,
  AlertTriangle,
  CheckCircle,
  XCircle,
} from "lucide-react";
import * as Tabs from "@radix-ui/react-tabs";
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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Badge, Button, Modal, useToast, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useDrivers } from "@/lib/api/drivers";
import { useCustomers } from "@/lib/api/customers";
import {
  useRoute,
  useUpdateRoute,
  useRemoveStop,
  useReorderStops,
  useAddStopToRoute,
  useCreateRouteRun,
  useRoutePackingList,
  useDeleteRoute,
  useOptimizeTemplate,
  useAnalyzeRoute,
  useRouteSettings,
  type RouteTemplateStop,
  type RouteAnalysisResult,
} from "@/lib/api/routes";
import { TemplateRouteMap } from "./TemplateRouteMap";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function TabTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        "px-4 py-2 text-sm font-medium text-navy/60 border-b-2 border-transparent transition-colors",
        "hover:text-navy data-[state=active]:text-brand-500 data-[state=active]:border-brand-500",
      )}
    >
      {children}
    </Tabs.Trigger>
  );
}

// ─── Sortable Stop Row ─────────────────────────────────────────────────────────

function SortableStop({
  stop,
  isSelected,
  onSelect,
  onRemove,
}: {
  stop: RouteTemplateStop;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: stop.id });

  const [confirming, setConfirming] = React.useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const addr = stop.customerAddress
    ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}`
    : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 cursor-pointer transition-colors",
        isSelected
          ? "border-brand-500 bg-brand-50"
          : "border-surface-border bg-white hover:border-brand-300",
      )}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="mt-0.5 cursor-grab text-navy/25 hover:text-navy/50 active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* Stop number */}
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-600">
        {stop.stopNumber}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-navy text-sm">
          {stop.customer?.businessName ?? stop.customerId}
        </p>
        {addr && <p className="mt-0.5 truncate text-xs text-navy/50">{addr}</p>}
      </div>

      {/* Remove */}
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        {confirming ? (
          <>
            <span className="text-xs text-danger font-medium">Remove?</span>
            <button
              onClick={() => { onRemove(); setConfirming(false); }}
              className="rounded px-1.5 py-0.5 text-xs font-medium text-white bg-danger hover:bg-danger/80 transition-colors"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded px-1.5 py-0.5 text-xs font-medium text-navy/60 hover:text-navy transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="rounded p-1 text-navy/30 hover:bg-danger-bg hover:text-danger transition-colors"
            aria-label="Remove stop"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Add Stop Search ───────────────────────────────────────────────────────────

function AddStopSearch({
  routeId,
  existingCustomerIds,
}: {
  routeId: string;
  existingCustomerIds: string[];
}) {
  const { toast } = useToast();
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const addStop = useAddStopToRoute();

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: result } = useCustomers({ search: debounced || undefined, status: "ACTIVE" });
  const allCustomers = result?.data ?? [];

  const suggestions = React.useMemo(() => {
    if (!debounced) return [];
    return allCustomers
      .filter((c: any) => !existingCustomerIds.includes(c.id))
      .slice(0, 8);
  }, [allCustomers, debounced, existingCustomerIds]);

  React.useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const handleAdd = (customer: any) => {
    const defaultAddr = customer.addresses?.[0];
    addStop.mutate(
      {
        routeId,
        customerId: customer.id,
        customerAddressId: defaultAddr?.id,
      },
      {
        onSuccess: () => {
          toast({ title: `${customer.businessName} added`, variant: "success" });
          setSearch("");
          setOpen(false);
        },
        onError: (err) =>
          toast({ title: "Failed to add stop", description: err.message, variant: "error" }),
      },
    );
  };

  return (
    <div ref={ref} className="relative mt-3 border-t border-surface-border pt-3">
      <div className="relative">
        <Plus className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/40" />
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          onFocus={() => { if (search) setOpen(true); }}
          placeholder="Add customer to route…"
          className="h-9 w-full rounded border border-surface-border bg-white pl-8 pr-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-lg">
          {suggestions.map((c: any) => (
            <li key={c.id}>
              <button
                className="flex w-full flex-col px-3 py-2 text-left hover:bg-surface-raised transition-colors"
                onMouseDown={(e) => { e.preventDefault(); handleAdd(c); }}
              >
                <span className="text-sm font-medium text-navy">{c.businessName}</span>
                <span className="text-xs text-navy/50">{c.contactName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Dispatch Modal ────────────────────────────────────────────────────────────

function DispatchModal({
  routeId,
  open,
  onClose,
}: {
  routeId: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { data: driversResult } = useDrivers({ status: "ACTIVE", limit: 100 });
  const drivers = driversResult?.data ?? [];
  const createRun = useCreateRouteRun();
  const { data: routeSettings } = useRouteSettings();

  const today = new Date().toISOString().split("T")[0];
  const [date, setDate] = React.useState(today);
  const [driverId, setDriverId] = React.useState("");
  const [startTime, setStartTime] = React.useState("");

  React.useEffect(() => {
    if (routeSettings?.defaultStartTime && !startTime) {
      setStartTime(routeSettings.defaultStartTime);
    }
  }, [routeSettings?.defaultStartTime]);

  const handleDispatch = () => {
    createRun.mutate(
      { routeId, scheduledDate: date, driverId: driverId || undefined, startTime: startTime || undefined },
      {
        onSuccess: (run) => {
          toast({ title: "Route run dispatched", variant: "success" });
          onClose();
          router.push(`/routes/${run.id}`);
        },
        onError: (err) =>
          toast({ title: "Dispatch failed", description: err.message, variant: "error" }),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Dispatch Route Run"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createRun.isPending}>
            Cancel
          </Button>
          <Button onClick={handleDispatch} loading={createRun.isPending}>
            Dispatch
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-navy">Scheduled Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-navy">Departure Time</label>
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-xs text-navy/50">When the driver leaves the depot</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-navy">Driver (optional)</label>
          <select
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">Unassigned</option>
            {drivers.map((d: any) => (
              <option key={d.id} value={d.id}>{d.contactName}</option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RouteTemplateDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: route, isLoading, isError } = useRoute(params.id);
  const { data: packingData } = useRoutePackingList(params.id);
  const { data: driversResult } = useDrivers({ status: "ACTIVE", limit: 100 });
  const drivers = driversResult?.data ?? [];

  const updateRoute = useUpdateRoute();
  const removeStop = useRemoveStop();
  const reorderStops = useReorderStops();
  const deleteRoute = useDeleteRoute();
  const optimizeTemplate = useOptimizeTemplate();
  const analyzeRoute = useAnalyzeRoute();
  const { data: routeSettings } = useRouteSettings();

  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [analysisResult, setAnalysisResult] = React.useState<RouteAnalysisResult | null>(null);
  const [analysisStartTime, setAnalysisStartTime] = React.useState("");

  const [selectedStopId, setSelectedStopId] = React.useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = React.useState(false);

  // Inline name edit state
  const [editingName, setEditingName] = React.useState(false);
  const [nameValue, setNameValue] = React.useState("");
  const nameInputRef = React.useRef<HTMLInputElement>(null);

  // Local optimistic stop order
  const [localStops, setLocalStops] = React.useState<RouteTemplateStop[]>([]);

  React.useEffect(() => {
    if (route?.stops) {
      setLocalStops([...route.stops].sort((a, b) => a.stopNumber - b.stopNumber));
    }
  }, [route?.stops]);

  const name = route?.name ?? "Route Template";
  React.useEffect(() => { setTitle(name); }, [setTitle, name]);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleStartEdit = () => {
    setNameValue(route?.name ?? "");
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 10);
  };

  const handleSaveName = () => {
    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === route?.name) { setEditingName(false); return; }
    updateRoute.mutate(
      { id: params.id, name: trimmed },
      {
        onSuccess: () => { setEditingName(false); toast({ title: "Route name saved", variant: "success" }); },
        onError: (err) => toast({ title: "Save failed", description: err.message, variant: "error" }),
      },
    );
  };

  const handleDriverChange = (driverId: string) => {
    updateRoute.mutate(
      { id: params.id, driverId: driverId || undefined },
      {
        onError: (err) => toast({ title: "Save failed", description: err.message, variant: "error" }),
      },
    );
  };

  const handleToggleActive = () => {
    updateRoute.mutate(
      { id: params.id, isActive: !route?.isActive },
      {
        onSuccess: () => toast({ title: route?.isActive ? "Route deactivated" : "Route activated", variant: "success" }),
        onError: (err) => toast({ title: "Save failed", description: err.message, variant: "error" }),
      },
    );
  };

  const handleDelete = () => {
    deleteRoute.mutate(params.id, {
      onSuccess: () => {
        toast({ title: "Route deleted", variant: "success" });
        router.push("/routes");
      },
      onError: (err) => toast({ title: "Delete failed", description: err.message, variant: "error" }),
    });
  };

  const handleOptimize = () => {
    optimizeTemplate.mutate(params.id, {
      onSuccess: (result) => {
        // Build stopId → new stopNumber lookup from the optimization result
        const newNumberByStopId = new Map(
          result.stopOrder.map(({ stopId, stopNumber }) => [stopId, stopNumber]),
        );
        // Immediately remap and re-sort localStops so the list updates
        // without waiting for the React Query re-fetch triggered by the hook's onSuccess
        setLocalStops((prev) => {
          const remapped = prev.map((s) => ({
            ...s,
            stopNumber: newNumberByStopId.get(s.id) ?? s.stopNumber,
          }));
          return [...remapped].sort((a, b) => a.stopNumber - b.stopNumber);
        });
        toast({
          title: result.usedFallback ? "Route optimized (local fallback)" : "Route optimized",
          description: result.reorderedCount > 0
            ? `${result.reorderedCount} stop${result.reorderedCount === 1 ? "" : "s"} reordered`
            : "Stops are already in optimal order",
          variant: "success",
        });
      },
      onError: (err) => toast({ title: "Optimization failed", description: err.message, variant: "error" }),
    });
  };

  const handleRemoveStop = (stopId: string) => {
    setLocalStops((prev) => {
      const filtered = prev.filter((s) => s.id !== stopId);
      return filtered.map((s, i) => ({ ...s, stopNumber: i + 1 }));
    });
    removeStop.mutate(
      { routeId: params.id, stopId },
      {
        onError: (err) => {
          toast({ title: "Remove failed", description: err.message, variant: "error" });
          if (route?.stops) setLocalStops([...route.stops].sort((a, b) => a.stopNumber - b.stopNumber));
        },
      },
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setLocalStops((prev) => {
      const oldIdx = prev.findIndex((s) => s.id === active.id);
      const newIdx = prev.findIndex((s) => s.id === over.id);
      const reordered = arrayMove(prev, oldIdx, newIdx).map((s, i) => ({
        ...s,
        stopNumber: i + 1,
      }));

      reorderStops.mutate(
        {
          routeId: params.id,
          order: reordered.map((s) => ({ id: s.id, stopNumber: s.stopNumber })),
        },
        {
          onError: (err) => {
            toast({ title: "Reorder failed", description: err.message, variant: "error" });
            if (route?.stops) setLocalStops([...route.stops].sort((a, b) => a.stopNumber - b.stopNumber));
          },
        },
      );

      return reordered;
    });
  };

  const packingList = packingData?.packingList ?? [];
  const orders = packingData?.orders ?? [];

  // Group orders by customer — must be before early returns (Rules of Hooks)
  const ordersByCustomer = React.useMemo(() => {
    const map: Record<string, { name: string; orders: typeof orders }> = {};
    for (const order of orders) {
      const cid = order.customer?.id ?? "unknown";
      if (!map[cid]) map[cid] = { name: order.customer?.businessName ?? "Unknown", orders: [] };
      map[cid].orders.push(order);
    }
    return Object.values(map);
  }, [orders]);

  // ── Render states ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  if (isError || !route) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Route template not found.</p>
        <Button variant="secondary" href="/routes">Back to Routes</Button>
      </div>
    );
  }

  const existingCustomerIds = localStops.map((s) => s.customerId).filter(Boolean) as string[];

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-surface-border bg-white px-6 py-3">
        <Link
          href="/routes"
          className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Routes
        </Link>
        <div className="h-4 w-px bg-surface-border" />

        {/* Inline route name */}
        {editingName ? (
          <input
            ref={nameInputRef}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={handleSaveName}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") setEditingName(false); }}
            className="rounded border border-brand-500 bg-white px-2 py-0.5 text-base font-bold text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            autoFocus
          />
        ) : (
          <button
            onClick={handleStartEdit}
            title="Click to rename"
            className="rounded px-1 py-0.5 text-base font-bold text-navy hover:bg-surface-raised transition-colors"
          >
            {route.name}
          </button>
        )}
        {updateRoute.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-navy/40" />}

        <Badge variant={route.isActive ? "success" : "neutral"} label={route.isActive ? "Active" : "Inactive"} />

        {/* Depot badge */}
        {(route.depotAddress || routeSettings?.depotAddress) && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">
            <Home className="h-3 w-3" />
            {route.depotAddress ? `Depot: ${route.depotAddress}` : "Default depot"}
          </span>
        )}

        {/* Driver selector + actions */}
        <div className="ml-auto flex items-center gap-2">
          <select
            defaultValue=""
            onChange={(e) => handleDriverChange(e.target.value)}
            className="h-8 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">No default driver</option>
            {drivers.map((d: any) => (
              <option key={d.id} value={d.id}>{d.contactName}</option>
            ))}
          </select>

          {/* Activate / Deactivate */}
          <button
            onClick={handleToggleActive}
            title={route.isActive ? "Deactivate route" : "Activate route"}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded border px-2.5 text-sm font-medium transition-colors",
              route.isActive
                ? "border-surface-border bg-white text-navy/60 hover:border-warning hover:text-warning"
                : "border-surface-border bg-white text-navy/60 hover:border-success hover:text-success",
            )}
          >
            {route.isActive
              ? <><ToggleRight className="h-4 w-4" />Deactivate</>
              : <><ToggleLeft className="h-4 w-4" />Activate</>}
          </button>

          {/* Delete */}
          {confirmDelete ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-danger">Delete route?</span>
              <button
                onClick={handleDelete}
                disabled={deleteRoute.isPending}
                className="rounded px-2 py-1 text-xs font-semibold text-white bg-danger hover:bg-danger/80 transition-colors"
              >
                {deleteRoute.isPending ? "Deleting…" : "Yes, delete"}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded px-2 py-1 text-xs font-medium text-navy/60 hover:text-navy transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              title="Delete route"
              className="flex h-8 items-center gap-1.5 rounded border border-surface-border bg-white px-2.5 text-sm font-medium text-navy/50 hover:border-danger hover:text-danger transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}

          <Button
            variant="secondary"
            leftIcon={optimizeTemplate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            onClick={handleOptimize}
            disabled={optimizeTemplate.isPending || localStops.length < 2}
            title={localStops.length < 2 ? "Need at least 2 stops to optimize" : "Optimize stop order"}
          >
            {optimizeTemplate.isPending ? "Optimizing…" : "Optimize"}
          </Button>

          <Button
            leftIcon={<Play className="h-4 w-4" />}
            onClick={() => setDispatchOpen(true)}
          >
            Dispatch Run
          </Button>
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* Left panel */}
        <div className="flex w-2/5 min-w-[340px] flex-col overflow-hidden border-r border-surface-border">
          <Tabs.Root defaultValue="stops" className="flex flex-1 flex-col overflow-hidden">
            <Tabs.List className="flex shrink-0 border-b border-surface-border bg-white px-4">
              <TabTrigger value="stops">
                <span className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" />
                  Stops ({localStops.length})
                </span>
              </TabTrigger>
              <TabTrigger value="orders">
                <span className="flex items-center gap-1.5">
                  <ShoppingCart className="h-3.5 w-3.5" />
                  Orders ({orders.length})
                </span>
              </TabTrigger>
              <TabTrigger value="packing">
                <span className="flex items-center gap-1.5">
                  <Package className="h-3.5 w-3.5" />
                  Packing List
                </span>
              </TabTrigger>
              <TabTrigger value="analysis">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" />
                  Analysis
                </span>
              </TabTrigger>
            </Tabs.List>

            {/* ── Stops Tab ── */}
            <Tabs.Content value="stops" className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4">
                {localStops.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-12 text-navy/40">
                    <MapPin className="h-8 w-8" />
                    <p className="text-sm">No stops yet. Add customers below.</p>
                  </div>
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={localStops.map((s) => s.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-2">
                        {localStops.map((stop) => (
                          <SortableStop
                            key={stop.id}
                            stop={stop}
                            isSelected={selectedStopId === stop.id}
                            onSelect={() => setSelectedStopId(stop.id === selectedStopId ? null : stop.id)}
                            onRemove={() => handleRemoveStop(stop.id)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}

                <AddStopSearch routeId={params.id} existingCustomerIds={existingCustomerIds} />
              </div>
            </Tabs.Content>

            {/* ── Orders Tab ── */}
            <Tabs.Content value="orders" className="flex-1 overflow-y-auto p-4">
              {ordersByCustomer.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-12 text-navy/40">
                  <ShoppingCart className="h-8 w-8" />
                  <p className="text-sm text-center">No pending orders for customers in this route.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {ordersByCustomer.map((group) => (
                    <div key={group.name}>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-navy/50">
                        {group.name}
                      </h3>
                      <div className="space-y-2">
                        {group.orders.map((order) => (
                          <div
                            key={order.id}
                            className="rounded-lg border border-surface-border bg-white p-3"
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium text-navy">#{order.orderNumber}</span>
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-xs font-medium",
                                  order.status === "CONFIRMED"
                                    ? "bg-success-bg text-success"
                                    : "bg-warning-bg text-warning",
                                )}
                              >
                                {order.status}
                              </span>
                            </div>
                            <div className="mt-1 space-y-0.5">
                              {order.lineItems.map((li) => (
                                <p key={li.id} className="text-xs text-navy/60">
                                  {li.product?.name ?? "Item"} × {li.qty}
                                </p>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Tabs.Content>

            {/* ── Packing List Tab ── */}
            <Tabs.Content value="packing" className="flex-1 overflow-y-auto p-4">
              {packingList.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-12 text-navy/40">
                  <Package className="h-8 w-8" />
                  <p className="text-sm text-center">No pending orders to pack.</p>
                </div>
              ) : (
                <div>
                  <div className="mb-4 flex items-center justify-between">
                    <p className="text-sm font-semibold text-navy">
                      Pack these items before loading the vehicle:
                    </p>
                    <button
                      onClick={() => window.print()}
                      className="flex items-center gap-1.5 rounded border border-surface-border bg-white px-2.5 py-1.5 text-xs font-medium text-navy/70 hover:bg-surface-raised transition-colors print:hidden"
                    >
                      <Printer className="h-3.5 w-3.5" />
                      Print
                    </button>
                  </div>
                  <div className="overflow-hidden rounded-lg border border-surface-border">
                    <table className="w-full text-sm">
                      <thead className="bg-surface-raised text-xs text-navy/50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Product</th>
                          <th className="px-3 py-2 text-left font-medium">SKU</th>
                          <th className="px-3 py-2 text-right font-medium">Total Qty</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-border bg-white">
                        {packingList.map((item) => (
                          <tr key={item.productId}>
                            <td className="px-3 py-2">
                              <p className="font-medium text-navy">{item.productName}</p>
                              <p className="mt-0.5 text-xs text-navy/50">
                                {item.customers.map((c) => `${c.name} (${c.qty})`).join(", ")}
                              </p>
                            </td>
                            <td className="px-3 py-2 text-navy/60">{item.sku ?? "—"}</td>
                            <td className="px-3 py-2 text-right font-bold text-navy">
                              {item.totalQty}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Tabs.Content>

            {/* ── Analysis Tab ── */}
            <Tabs.Content value="analysis" className="flex-1 overflow-y-auto p-4">
              <div className="space-y-4">
                {/* Controls */}
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs font-medium text-navy/60">Departure Time</label>
                    <input
                      type="time"
                      value={analysisStartTime || routeSettings?.defaultStartTime || "08:00"}
                      onChange={(e) => setAnalysisStartTime(e.target.value)}
                      className="h-9 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                  </div>
                  <Button
                    leftIcon={analyzeRoute.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    onClick={() => {
                      analyzeRoute.mutate(
                        { routeId: params.id, startTime: analysisStartTime || undefined },
                        { onSuccess: (result) => setAnalysisResult(result) },
                      );
                    }}
                    disabled={analyzeRoute.isPending || localStops.length < 1}
                  >
                    {analyzeRoute.isPending ? "Analyzing..." : "Analyze Route"}
                  </Button>
                </div>

                {/* Results */}
                {analysisResult && (
                  <div className="space-y-3">
                    {/* Summary */}
                    {analysisResult.summary && (
                      <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
                        <p className="text-sm font-medium text-brand-700">{analysisResult.summary}</p>
                      </div>
                    )}

                    {!analysisResult.configured && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <p className="text-xs text-amber-700">
                          Configure an Anthropic API key in Settings for AI-powered route insights.
                        </p>
                      </div>
                    )}

                    {/* ETA rows */}
                    <div className="overflow-hidden rounded-lg border border-surface-border">
                      <table className="w-full text-sm">
                        <thead className="bg-surface-raised text-xs text-navy/50">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">#</th>
                            <th className="px-3 py-2 text-left font-medium">Customer</th>
                            <th className="px-3 py-2 text-left font-medium">ETA</th>
                            <th className="px-3 py-2 text-left font-medium">Window</th>
                            <th className="px-3 py-2 text-center font-medium">Status</th>
                            {analysisResult.stops && <th className="px-3 py-2 text-left font-medium">AI Note</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-surface-border bg-white">
                          {analysisResult.etas.map((eta) => {
                            const aiStop = analysisResult.stops?.find((s) => s.stopNumber === eta.stopNumber);
                            return (
                              <tr key={eta.stopId}>
                                <td className="px-3 py-2 font-bold text-navy">{eta.stopNumber}</td>
                                <td className="px-3 py-2 text-navy">{eta.customerName}</td>
                                <td className="px-3 py-2">
                                  <span className="font-mono text-navy">{eta.arrivalTime}</span>
                                  <span className="ml-1 text-xs text-navy/40">({eta.travelTimeMinutes}m)</span>
                                </td>
                                <td className="px-3 py-2 text-navy/60">
                                  {eta.deliveryWindowStart && eta.deliveryWindowEnd
                                    ? `${eta.deliveryWindowStart}–${eta.deliveryWindowEnd}`
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-center">
                                  {aiStop ? (
                                    <span className={cn(
                                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                                      aiStop.status === "ok" && "bg-emerald-50 text-emerald-700",
                                      aiStop.status === "warning" && "bg-amber-50 text-amber-700",
                                      aiStop.status === "critical" && "bg-red-50 text-red-700",
                                    )}>
                                      {aiStop.status === "ok" && <CheckCircle className="h-3 w-3" />}
                                      {aiStop.status === "warning" && <AlertTriangle className="h-3 w-3" />}
                                      {aiStop.status === "critical" && <XCircle className="h-3 w-3" />}
                                      {aiStop.status}
                                    </span>
                                  ) : eta.withinWindow === true ? (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                      <CheckCircle className="h-3 w-3" /> on time
                                    </span>
                                  ) : eta.withinWindow === false ? (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                                      <XCircle className="h-3 w-3" /> late
                                    </span>
                                  ) : (
                                    <span className="text-xs text-navy/30">—</span>
                                  )}
                                </td>
                                {analysisResult.stops && (
                                  <td className="px-3 py-2 text-xs text-navy/60">{aiStop?.message ?? ""}</td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Suggestions */}
                    {analysisResult.suggestions && analysisResult.suggestions.length > 0 && (
                      <div className="rounded-lg border border-surface-border bg-white p-3">
                        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-navy/50">Suggestions</h4>
                        <ul className="space-y-1">
                          {analysisResult.suggestions.map((s, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm text-navy/70">
                              <span className="mt-0.5 text-brand-500">•</span>
                              {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {!analysisResult && !analyzeRoute.isPending && (
                  <div className="flex flex-col items-center gap-3 py-12 text-navy/40">
                    <Clock className="h-8 w-8" />
                    <p className="text-sm text-center">Click "Analyze Route" to calculate ETAs and get AI-powered delivery window insights.</p>
                  </div>
                )}
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </div>

        {/* Right panel — Map */}
        <div className="flex-1 overflow-hidden">
          <TemplateRouteMap
            stops={localStops}
            selectedStopId={selectedStopId}
            onSelectStop={(id) => setSelectedStopId(selectedStopId === id ? null : id)}
            onRemoveStop={handleRemoveStop}
            depotLat={route.depotLat ?? routeSettings?.depotLat ?? undefined}
            depotLng={route.depotLng ?? routeSettings?.depotLng ?? undefined}
            depotAddress={route.depotAddress ?? routeSettings?.depotAddress ?? undefined}
          />
        </div>
      </div>

      {/* Dispatch modal */}
      <DispatchModal
        routeId={params.id}
        open={dispatchOpen}
        onClose={() => setDispatchOpen(false)}
      />
    </div>
  );
}
