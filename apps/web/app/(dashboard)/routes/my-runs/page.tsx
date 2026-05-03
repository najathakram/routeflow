"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { PageHeader, Badge } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { useRouteRuns, type RouteRun } from "@/lib/api/routes";

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

function CardShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-surface-border bg-white shadow-card">
      <header className="border-b border-surface-border px-5 py-3.5">
        <h2 className="text-sm font-semibold text-navy">{title}</h2>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function RunRow({ run }: { run: RouteRun }) {
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
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-navy">{routeName}</p>
        <p className="mt-0.5 text-xs text-navy/60">
          {dateLabel} · {total} stop{total === 1 ? "" : "s"}
        </p>
      </div>
      {statusBadge(run.status)}
      <Link
        href={`/routes/${run.id}`}
        className="inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-navy transition-colors hover:bg-surface-raised"
      >
        Open
        <ChevronRight className="h-3.5 w-3.5" />
      </Link>
    </li>
  );
}

function RunsList({
  runs,
  isLoading,
  isError,
  emptyText,
}: {
  runs: RouteRun[];
  isLoading: boolean;
  isError: boolean;
  emptyText: string;
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
    return <p className="text-sm text-navy/50">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-surface-border">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </ul>
  );
}

export default function MyRunsPage() {
  const { setTitle } = usePageTitle();
  const { user } = useAuth();

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

  if (!canActAsDriver) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="My Routes" subtitle="Runs assigned to you." />
        <section className="rounded-lg border border-surface-border bg-white p-6 shadow-card">
          <p className="text-sm text-navy/70">
            This view is only available to operators who can also act as drivers. Ask your admin
            to enable driver mode on your account.
          </p>
        </section>
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
