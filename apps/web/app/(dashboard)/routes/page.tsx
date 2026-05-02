"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Play, Calendar, CheckSquare, X, Trash2, Pencil, Ban } from "lucide-react";
import { PageHeader, Badge, Table, Button, Modal, useToast, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useRoutes,
  useRouteRuns,
  useCreateRouteRun,
  useDeleteRoute,
  useUpdateRouteRunStatus,
  useDeleteRouteRun,
  type Route,
  type RouteRun,
} from "@/lib/api/routes";
import { useDrivers } from "@/lib/api/drivers";
import { EditRunModal } from "./_components/EditRunModal";

// ─── Status helpers ───────────────────────────────────────────────────────────

type RunStatus = "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "SCHEDULED";

function statusBadge(status: RunStatus) {
  if (status === "IN_PROGRESS") return <Badge status="IN_PROGRESS" />;
  if (status === "COMPLETED") return <Badge status="COMPLETED" />;
  if (status === "CANCELLED") return <Badge status="CANCELLED" />;
  return <Badge status="SCHEDULED" />;
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-navy/60">
        <span>
          {done} of {total} stops
        </span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-border">
        <div
          className="h-full rounded-full bg-brand-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Dispatch Modal ───────────────────────────────────────────────────────────

function DispatchModal({
  routeId,
  open,
  onClose,
}: {
  routeId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { data: driversResult } = useDrivers({ status: "ACTIVE", limit: 100 });
  const drivers = driversResult?.data ?? [];
  const createRun = useCreateRouteRun();

  const today = new Date().toISOString().split("T")[0];
  const [date, setDate] = React.useState(today);
  const [driverId, setDriverId] = React.useState("");

  // Reset form when modal opens
  React.useEffect(() => {
    if (open) {
      setDate(today);
      setDriverId("");
    }
  }, [open, today]);

  const handleDispatch = () => {
    if (!routeId) return;
    createRun.mutate(
      { routeId, scheduledDate: date, driverId: driverId || undefined },
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
          <label className="mb-1 block text-sm font-medium text-navy">Driver (optional)</label>
          <select
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">Unassigned</option>
            {drivers.map((d: any) => (
              <option key={d.id} value={d.id}>
                {d.contactName}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

// ─── Template table columns ───────────────────────────────────────────────────

function useTemplateColumns(
  router: ReturnType<typeof useRouter>,
  onDispatch: (id: string) => void,
  selectMode: boolean,
  selected: Set<string>,
  onToggle: (id: string) => void,
) {
  return React.useMemo<ColumnDef<Route, unknown>[]>(
    () => [
      ...(selectMode
        ? [
            {
              id: "select",
              header: () => null,
              cell: ({ row }: { row: { original: Route } }) => (
                <input
                  type="checkbox"
                  checked={selected.has(row.original.id)}
                  onChange={() => onToggle(row.original.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
                />
              ),
              enableSorting: false,
              size: 40,
            } as ColumnDef<Route, unknown>,
          ]
        : []),
      {
        accessorKey: "name",
        header: "Route Name",
        cell: ({ row }) => <span className="font-medium text-navy">{row.original.name}</span>,
      },
      {
        accessorKey: "stopCount",
        header: "Stops",
        cell: ({ row }) => <span className="text-navy/70">{row.original._count?.stops ?? 0}</span>,
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5 text-navy">
            <Calendar className="h-3.5 w-3.5" />
            {new Date(row.original.createdAt).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Link
              href={`/routes/templates/${row.original.id}`}
              title="View template"
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
            >
              <Eye className="h-4 w-4" />
            </Link>
            <button
              title="Dispatch run"
              onClick={() => onDispatch(row.original.id)}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-success transition-colors"
            >
              <Play className="h-4 w-4" />
            </button>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, onDispatch, selectMode, selected],
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RoutesPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const [dispatchRouteId, setDispatchRouteId] = React.useState<string | null>(null);
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = React.useState(false);
  // Inline-action state for active-run cards
  const [editingRun, setEditingRun] = React.useState<RouteRun | null>(null);
  const [cancellingRun, setCancellingRun] = React.useState<RouteRun | null>(null);
  const [deletingRun, setDeletingRun] = React.useState<RouteRun | null>(null);
  const deleteRoute = useDeleteRoute();
  const updateRunStatus = useUpdateRouteRunStatus();
  const deleteRun = useDeleteRouteRun();
  const { toast } = useToast();

  const handleConfirmCancelRun = () => {
    if (!cancellingRun) return;
    updateRunStatus.mutate(
      { id: cancellingRun.id, status: "CANCELLED" },
      {
        onSuccess: () => {
          toast({ title: "Run cancelled", variant: "success" });
          setCancellingRun(null);
        },
        onError: (err) =>
          toast({ title: "Cancel failed", description: err.message, variant: "error" }),
      },
    );
  };

  const handleConfirmDeleteRun = () => {
    if (!deletingRun) return;
    deleteRun.mutate(deletingRun.id, {
      onSuccess: () => {
        toast({ title: "Run deleted", variant: "success" });
        setDeletingRun(null);
      },
      onError: (err) =>
        toast({ title: "Delete failed", description: err.message, variant: "error" }),
    });
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const handleBulkDelete = async () => {
    if (isBulkDeleting) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(Array.from(selected).map((id) => deleteRoute.mutateAsync(id)));
      toast({
        title: `${selected.size} route${selected.size !== 1 ? "s" : ""} deleted`,
        variant: "success",
      });
      exitSelectMode();
    } catch {
      toast({ title: "Failed to delete some routes", variant: "error" });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const templateColumns = useTemplateColumns(
    router,
    setDispatchRouteId,
    selectMode,
    selected,
    toggleSelect,
  );

  React.useEffect(() => {
    setTitle("Routes");
  }, [setTitle]);

  // Show all currently-active runs (SCHEDULED + IN_PROGRESS) regardless of
  // their scheduledDate. Filtering by today's date hid orphan active runs from
  // previous days, which still block dispatch via the API's duplicate-active-run
  // check — operators saw "no runs scheduled for today" yet got "this route
  // already has an active run" when trying to dispatch, with no way to find or
  // cancel the blocking run.
  const {
    data: runsData,
    isLoading: runsLoading,
    isError: runsError,
  } = useRouteRuns({ activeOnly: true, limit: 100 });
  const { data: routesData, isLoading: routesLoading, isError: routesError } = useRoutes();

  const activeRuns = runsData?.data ?? [];
  // RF-206: deduplicate by route ID — routes with multiple historical runs could
  // appear more than once if the API JOIN returns one row per run.
  const routeTemplates = React.useMemo(() => {
    const seen = new Set<string>();
    return (routesData?.data ?? []).filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }, [routesData?.data]);

  return (
    <div className="space-y-6 p-6">
      {/* Inline action modals for active-run cards */}
      {editingRun && (
        <EditRunModal
          run={{
            id: editingRun.id,
            driverId: editingRun.driverId,
            scheduledDate: editingRun.scheduledDate,
            notes: editingRun.notes,
          }}
          onClose={() => setEditingRun(null)}
        />
      )}

      <Modal
        open={!!cancellingRun}
        onClose={() => setCancellingRun(null)}
        title="Cancel this run?"
        description={
          cancellingRun
            ? `Cancel the run for ${cancellingRun.route?.name ?? "this route"}? The run will be marked CANCELLED and the route can be dispatched again.`
            : ""
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setCancellingRun(null)}
              disabled={updateRunStatus.isPending}
            >
              Keep run
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmCancelRun}
              loading={updateRunStatus.isPending}
            >
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
        open={!!deletingRun}
        onClose={() => setDeletingRun(null)}
        title="Delete this run?"
        description={
          deletingRun
            ? `Delete the scheduled run for ${deletingRun.route?.name ?? "this route"}? This permanently removes it.`
            : ""
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDeletingRun(null)}
              disabled={deleteRun.isPending}
            >
              Keep run
            </Button>
            <Button variant="danger" onClick={handleConfirmDeleteRun} loading={deleteRun.isPending}>
              Delete run
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          Stops and any delivery records on this run will be lost. This cannot be undone.
        </p>
      </Modal>

      <PageHeader
        title="Routes"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={
                selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />
              }
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            >
              {selectMode ? "Cancel" : "Select"}
            </Button>
            <Button onClick={() => router.push("/routes/create")}>Create Route</Button>
          </div>
        }
      />

      {/* ── Active route runs (SCHEDULED + IN_PROGRESS, any date) ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-navy">Active Runs</h2>
        {runsLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
              />
            ))}
          </div>
        ) : runsError ? (
          <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
            <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
          </div>
        ) : activeRuns.length === 0 ? (
          <p className="text-sm text-navy/50">No active runs. Dispatch a template below to start one.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {activeRuns.map((run) => {
              const total = run._count?.stops ?? run.stops?.length ?? 0;
              const done =
                run.stops?.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED")
                  .length ?? 0;
              const driverName = run.driver?.contactName ?? "Unassigned";
              const routeName = run.route?.name ?? "Route";
              const scheduledLabel = (() => {
                if (!run.scheduledDate) return null;
                const d = new Date(run.scheduledDate);
                const todayStr = new Date().toISOString().slice(0, 10);
                const runStr = d.toISOString().slice(0, 10);
                if (runStr === todayStr) return "Today";
                return d.toLocaleDateString();
              })();
              const startTime = run.startedAt
                ? new Date(run.startedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : null;
              const endTime = run.completedAt
                ? new Date(run.completedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : null;
              return (
                <div
                  key={run.id}
                  className="flex flex-col gap-4 rounded-lg border border-surface-border bg-white p-4 shadow-card"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-navy">{routeName}</p>
                      <p className="mt-0.5 text-sm text-navy/60">{driverName}</p>
                    </div>
                    {statusBadge(run.status)}
                  </div>
                  <ProgressBar done={done} total={total} />
                  <div className="flex items-center justify-between text-xs text-navy/50">
                    {scheduledLabel && <span>Scheduled {scheduledLabel}</span>}
                    {startTime && <span>Started {startTime}</span>}
                    {endTime && <span>Finished {endTime}</span>}
                  </div>
                  {/* Inline actions: View · Edit / Reschedule (SCHEDULED) ·
                      Cancel (SCHEDULED + IN_PROGRESS) · Delete (SCHEDULED) */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link
                      href={`/routes/${run.id}`}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-navy hover:bg-surface-raised transition-colors"
                      title="Open run detail"
                    >
                      <Eye className="h-3.5 w-3.5" /> View
                    </Link>
                    {run.status === "SCHEDULED" && (
                      <button
                        onClick={() => setEditingRun(run)}
                        className="inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:bg-surface-raised transition-colors"
                        title="Change driver, date, or notes"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                    )}
                    {(run.status === "SCHEDULED" || run.status === "IN_PROGRESS") && (
                      <button
                        onClick={() => setCancellingRun(run)}
                        className="inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:bg-surface-raised transition-colors"
                        title="Cancel this run"
                      >
                        <Ban className="h-3.5 w-3.5" /> Cancel
                      </button>
                    )}
                    {run.status === "SCHEDULED" && (
                      <button
                        onClick={() => setDeletingRun(run)}
                        className="inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-xs font-medium text-danger hover:border-danger/40 hover:bg-danger/5 transition-colors"
                        title="Delete this run permanently"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Route templates ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-navy">Route Templates</h2>
          {selectMode && routeTemplates.length > 0 && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={routeTemplates.every((r) => selected.has(r.id))}
                ref={(el) => {
                  if (el)
                    el.indeterminate =
                      routeTemplates.some((r) => selected.has(r.id)) &&
                      !routeTemplates.every((r) => selected.has(r.id));
                }}
                onChange={() => {
                  if (routeTemplates.every((r) => selected.has(r.id))) setSelected(new Set());
                  else setSelected(new Set(routeTemplates.map((r) => r.id)));
                }}
                className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
              />
              <span className="text-sm text-navy/60">Select all</span>
            </label>
          )}
        </div>

        {/* Selection action bar */}
        {selectMode && selected.size > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
            <span className="text-sm font-medium text-navy">
              {selected.size} route{selected.size !== 1 ? "s" : ""} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelected(new Set())}
                className="text-sm text-navy/50 hover:text-navy transition-colors"
              >
                Deselect all
              </button>
              <Button
                variant="danger"
                leftIcon={<Trash2 className="h-4 w-4" />}
                loading={isBulkDeleting}
                onClick={handleBulkDelete}
              >
                Delete {selected.size}
              </Button>
            </div>
          </div>
        )}

        {routesLoading ? (
          <div className="h-32 animate-pulse rounded-lg border border-surface-border bg-surface-raised" />
        ) : routesError ? (
          <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
            <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
          </div>
        ) : (
          <Table
            data={routeTemplates}
            columns={templateColumns}
            onRowClick={(row) => {
              if (selectMode) toggleSelect(row.original.id);
              else router.push(`/routes/templates/${row.original.id}`);
            }}
          />
        )}
      </section>

      <DispatchModal
        routeId={dispatchRouteId}
        open={!!dispatchRouteId}
        onClose={() => setDispatchRouteId(null)}
      />
    </div>
  );
}
