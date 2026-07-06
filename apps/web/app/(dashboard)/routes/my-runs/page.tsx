"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronRight,
  CheckCircle2,
  Loader2,
  Circle,
  XCircle,
  ScanLine,
  Truck,
} from "lucide-react";
import { PageHeader, Badge, Button, StatCard } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { useDriveMode } from "@/lib/drive-mode";
import { useRouteRuns, type RouteRun, type RouteRunStop } from "@/lib/api/routes";

type RunStatus = "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "SCHEDULED";

function statusBadge(status: RunStatus) {
  if (status === "IN_PROGRESS") return <Badge status="IN_PROGRESS" />;
  if (status === "COMPLETED") return <Badge status="COMPLETED" />;
  if (status === "CANCELLED") return <Badge status="CANCELLED" />;
  return <Badge status="SCHEDULED" />;
}

function todayLocalISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function CardShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-surface-border bg-white shadow-card">
      <header className="border-b border-surface-border px-5 py-3.5">
        <h2 className="text-sm font-semibold text-navy">{title}</h2>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function RunRow({ run, driveMode }: { run: RouteRun; driveMode: boolean }) {
  const routeName = run.route?.name ?? "Route";
  const total = run._count?.stops ?? run.stops?.length ?? 0;
  const dateLabel = run.scheduledDate
    ? new Date(run.scheduledDate).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : "—";
  return (
    <li
      className={
        driveMode
          ? "flex items-center justify-between gap-3 py-4"
          : "flex items-center justify-between gap-3 py-3"
      }
    >
      <div className="min-w-0 flex-1">
        <p
          className={
            driveMode
              ? "truncate text-base font-semibold text-navy"
              : "truncate text-sm font-medium text-navy"
          }
        >
          {routeName}
        </p>
        <p className="mt-0.5 text-xs text-navy/70">
          {dateLabel} · {total} stop{total === 1 ? "" : "s"}
        </p>
      </div>
      {statusBadge(run.status)}
      <Link
        href={`/routes/${run.id}`}
        className={
          driveMode
            ? "inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-4 py-2.5 text-sm font-semibold text-navy transition-colors hover:bg-surface-raised"
            : "inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-navy transition-colors hover:bg-surface-raised"
        }
      >
        Open
        <ChevronRight className={driveMode ? "h-4 w-4" : "h-3.5 w-3.5"} />
      </Link>
    </li>
  );
}

function RunsList({
  runs,
  isLoading,
  isError,
  emptyText,
  driveMode,
}: {
  runs: RouteRun[];
  isLoading: boolean;
  isError: boolean;
  emptyText: string;
  driveMode?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
          />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
        <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
      </div>
    );
  }
  if (runs.length === 0) {
    return <p className="text-sm text-navy/70">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-surface-border">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} driveMode={!!driveMode} />
      ))}
    </ul>
  );
}

// ─── Drive-mode field layout helpers ───────────────────────────────────────────

function StopStatusIcon({ status }: { status: RouteRunStop["status"] }) {
  if (status === "COMPLETED") return <CheckCircle2 className="h-6 w-6 shrink-0 text-success" />;
  if (status === "IN_PROGRESS")
    return <Loader2 className="h-6 w-6 shrink-0 animate-spin text-brand-500" />;
  if (status === "SKIPPED") return <XCircle className="h-6 w-6 shrink-0 text-danger" />;
  return <Circle className="h-6 w-6 shrink-0 text-navy/25" />;
}

/** One big-touch-target stop row for the drive-mode hero run card. Reuses the
 *  same stop data the run detail page consumes — no new fetch, no new handler:
 *  just a bigger presentation for the field. Line-item totals aren't part of
 *  the typed `RouteRunStop.orders` shape here (see api/routes.ts), so this
 *  shows order count rather than re-deriving money math outside pricing.ts. */
function FieldStopRow({ stop }: { stop: RouteRunStop }) {
  const orderCount = stop.orders?.length ?? 0;
  const addressLine = stop.customerAddress
    ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}`
    : undefined;
  const isNext = stop.status === "PENDING";
  return (
    <li
      className={
        isNext
          ? "flex items-center gap-3 rounded-lg bg-brand-50/60 px-3 py-4"
          : "flex items-center gap-3 px-3 py-4"
      }
    >
      <StopStatusIcon status={stop.status} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-navy">
          {stop.customer?.businessName ?? "Stop"}
        </p>
        <p className="truncate text-xs text-navy/70">
          {addressLine ?? (stop.driverNote || `Stop #${stop.stopNumber}`)}
        </p>
      </div>
      {orderCount > 0 && (
        <span className="text-xs text-navy/70">
          {orderCount} order{orderCount === 1 ? "" : "s"}
        </span>
      )}
      {statusBadge(
        stop.status === "COMPLETED"
          ? "COMPLETED"
          : stop.status === "IN_PROGRESS"
            ? "IN_PROGRESS"
            : stop.status === "SKIPPED"
              ? "CANCELLED"
              : "SCHEDULED",
      )}
    </li>
  );
}

/** Field layout hero card for today's active/next run — today's run first, big
 *  targets, matches docs/design-package/project/unified/my-runs.html. Falls back
 *  to the same summary the compact list would show when stop detail isn't part
 *  of the (unchanged) `useRouteRuns` payload for this run. Money totals aren't
 *  re-derived here (pricing.ts owns that) — "Delivered" reflects completed stops
 *  and their order count instead of a re-summed dollar figure. */
function TodayRunHero({ run }: { run: RouteRun }) {
  const stops = run.stops ?? [];
  const total = run._count?.stops ?? stops.length;
  const doneCount = stops.filter((s) => s.status === "COMPLETED").length;
  const nextStop = stops.find((s) => s.status === "PENDING" || s.status === "IN_PROGRESS");
  const deliveredOrders = stops
    .filter((s) => s.status === "COMPLETED")
    .reduce((sum, s) => sum + (s.orders?.length ?? 0), 0);

  return (
    <section className="rounded-lg border border-surface-border bg-white shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-navy">{run.route?.name ?? "Today's Run"}</h2>
          <p className="mt-0.5 text-xs text-navy/70">
            {run.startedAt
              ? `Started ${new Date(run.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
              : "Not started yet"}
          </p>
        </div>
        {statusBadge(run.status)}
      </header>

      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-3">
        <StatCard
          label="Progress"
          value={total > 0 ? `${doneCount} / ${total}` : "—"}
          trendLabel={total > 0 ? "stops" : undefined}
        />
        <StatCard label="Next Stop" value={nextStop?.customer?.businessName ?? "—"} />
        <StatCard
          label="Delivered Today"
          value={String(doneCount)}
          trendLabel={deliveredOrders > 0 ? `${deliveredOrders} orders` : undefined}
        />
      </div>

      {/* Primary action row — big touch targets, scanner shortcut front and center */}
      <div className="flex flex-wrap gap-3 px-5 pb-5">
        <Link
          href="/orders?action=new"
          className="inline-flex h-14 flex-1 items-center justify-center gap-2 rounded-lg bg-accent-strong px-5 text-base font-semibold text-white transition-colors hover:bg-accent-deep sm:flex-none sm:min-w-[220px]"
        >
          <ScanLine className="h-5 w-5" />
          Scan to add order
        </Link>
        <Link
          href={`/routes/${run.id}`}
          className="inline-flex h-14 flex-1 items-center justify-center gap-2 rounded-lg border border-surface-border bg-white px-5 text-base font-semibold text-navy transition-colors hover:bg-surface-raised sm:flex-none sm:min-w-[180px]"
        >
          Open full run
          <ChevronRight className="h-5 w-5" />
        </Link>
      </div>

      {stops.length > 0 && (
        <div className="border-t border-surface-border px-2 pb-2">
          <ul className="divide-y divide-surface-border">
            {stops.map((stop) => (
              <FieldStopRow key={stop.id} stop={stop} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function MyRunsPage() {
  const { setTitle } = usePageTitle();
  const { user } = useAuth();
  const { driveMode, setDriveMode } = useDriveMode();

  React.useEffect(() => {
    setTitle("My Routes");
  }, [setTitle]);

  const canActAsDriver = (user as any)?.canActAsDriver === true;

  const { data, isLoading, isError } = useRouteRuns(
    { assignedToMe: true, limit: 100 },
    { refetchInterval: 60_000 },
  );

  const { todayRuns, upcomingRuns } = React.useMemo(() => {
    const all = data?.data ?? [];
    const today = todayLocalISO();
    const todayList: RouteRun[] = [];
    const upcomingList: RouteRun[] = [];
    for (const run of all) {
      if (!run.scheduledDate) continue;
      const runDate = run.scheduledDate.slice(0, 10);
      if (runDate === today) {
        todayList.push(run);
      } else if (runDate > today) {
        upcomingList.push(run);
      }
    }
    upcomingList.sort((a, b) =>
      a.scheduledDate.slice(0, 10).localeCompare(b.scheduledDate.slice(0, 10)),
    );
    return { todayRuns: todayList, upcomingRuns: upcomingList.slice(0, 20) };
  }, [data?.data]);

  // Today's active/next run gets promoted to the drive-mode hero card — the rest
  // of today's runs (if more than one) still render in the compact list below it.
  const heroRun =
    todayRuns.find((r) => r.status === "IN_PROGRESS") ??
    todayRuns.find((r) => r.status === "SCHEDULED") ??
    todayRuns[0];
  const restOfToday = todayRuns.filter((r) => r.id !== heroRun?.id);

  if (!canActAsDriver) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="My Routes" subtitle="Runs assigned to you." />
        <section className="rounded-lg border border-surface-border bg-white p-6 shadow-card">
          <p className="text-sm text-navy/70">
            This view is only available to operators who can also act as drivers. Ask your admin to
            enable driver mode on your account.
          </p>
        </section>
      </div>
    );
  }

  // ── Drive mode: field layout — today's run first, big targets, scanner shortcut ──
  if (driveMode) {
    return (
      <div className="space-y-5 p-4 sm:p-6">
        <PageHeader
          title="My Routes"
          subtitle="Today's run first — everything else is one tap away."
          action={
            <Button variant="secondary" size="md" onClick={() => setDriveMode(false)}>
              <Truck className="h-4 w-4" />
              Exit drive mode
            </Button>
          }
        />

        {isLoading ? (
          <div className="h-48 animate-pulse rounded-lg border border-surface-border bg-surface-raised" />
        ) : isError ? (
          <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
            <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
          </div>
        ) : heroRun ? (
          <TodayRunHero run={heroRun} />
        ) : (
          <section className="rounded-lg border border-surface-border bg-white p-6 shadow-card">
            <p className="text-sm text-navy/70">No runs scheduled for you today.</p>
          </section>
        )}

        {restOfToday.length > 0 && (
          <CardShell title="Also today">
            <RunsList
              runs={restOfToday}
              isLoading={false}
              isError={false}
              emptyText="No other runs today."
              driveMode
            />
          </CardShell>
        )}

        <CardShell title="Upcoming">
          <RunsList
            runs={upcomingRuns}
            isLoading={isLoading}
            isError={isError}
            emptyText="No upcoming runs assigned to you."
            driveMode
          />
        </CardShell>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="My Routes" subtitle="Runs assigned to you." />

      <CardShell title="Today">
        <RunsList
          runs={todayRuns}
          isLoading={isLoading}
          isError={isError}
          emptyText="No runs scheduled for you today."
        />
      </CardShell>

      <CardShell title="Upcoming">
        <RunsList
          runs={upcomingRuns}
          isLoading={isLoading}
          isError={isError}
          emptyText="No upcoming runs assigned to you."
        />
      </CardShell>
    </div>
  );
}
