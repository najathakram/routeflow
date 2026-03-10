"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Play, Calendar } from "lucide-react";
import { PageHeader, Badge, Table, Button, Card, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { CreateRouteModal } from "./_components/CreateRouteModal";
import { useRoutes, useRouteRuns, type Route, type RouteRun } from "@/lib/api/routes";

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
        <span>{done} of {total} stops</span>
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

// ─── Template table columns ───────────────────────────────────────────────────

function useTemplateColumns(router: ReturnType<typeof useRouter>) {
  return React.useMemo<ColumnDef<Route, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Route Name",
        cell: ({ row }) => (
          <span className="font-medium text-navy">{row.original.name}</span>
        ),
      },
      {
        accessorKey: "stopCount",
        header: "Stops",
        cell: ({ row }) => (
          <span className="text-navy/70">{row.original._count?.stops ?? 0}</span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5 text-navy/60">
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
            <button
              title="View template"
              onClick={() => router.push(`/routes/${row.original.id}`)}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
            >
              <Eye className="h-4 w-4" />
            </button>
            <button
              title="Dispatch run"
              onClick={() => router.push(`/routes/${row.original.id}/dispatch`)}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-success transition-colors"
            >
              <Play className="h-4 w-4" />
            </button>
          </div>
        ),
      },
    ],
    [router],
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RoutesPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const templateColumns = useTemplateColumns(router);

  React.useEffect(() => { setTitle("Routes"); }, [setTitle]);

  const today = new Date().toISOString().split("T")[0];
  const { data: runsData, isLoading: runsLoading } = useRouteRuns({ date: today });
  const { data: routesData, isLoading: routesLoading } = useRoutes();

  const todayRuns = runsData?.data ?? [];
  const routeTemplates = routesData?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Routes"
        action={
          <Button onClick={() => setIsCreateOpen(true)}>Create Route</Button>
        }
      />

      {/* ── Today's route runs ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-navy/50">
          Route Runs Today
        </h2>
        {runsLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
              />
            ))}
          </div>
        ) : todayRuns.length === 0 ? (
          <p className="text-sm text-navy/50">No runs scheduled for today.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {todayRuns.map((run) => {
              const total = run._count?.stops ?? run.stops?.length ?? 0;
              const done = run.stops?.filter(
                (s) => s.status === "COMPLETED" || s.status === "SKIPPED",
              ).length ?? 0;
              const driverName = run.driver?.contactName ?? "Unassigned";
              const routeName = run.route?.name ?? "Route";
              const startTime = run.startedAt
                ? new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : null;
              const endTime = run.completedAt
                ? new Date(run.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
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
                    {startTime && <span>Started {startTime}</span>}
                    {endTime && <span>Finished {endTime}</span>}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    onClick={() => router.push(`/routes/${run.id}`)}
                  >
                    View Run
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Route templates ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-navy/50">
          Route Templates
        </h2>
        {routesLoading ? (
          <div className="h-32 animate-pulse rounded-lg border border-surface-border bg-surface-raised" />
        ) : (
          <Table
            data={routeTemplates}
            columns={templateColumns}
            onRowClick={(row) => router.push(`/routes/${row.original.id}`)}
          />
        )}
      </section>

      <CreateRouteModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
    </div>
  );
}
