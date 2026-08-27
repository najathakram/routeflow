"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, ChevronRight } from "lucide-react";
import { PageHeader, Badge, Button } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useRouteRuns, type RouteRun } from "@/lib/api/routes";
import { useDrivers, type Driver } from "@/lib/api/drivers";
import { useDeveloperMode, useRoutesAccess, useDeliveryAccess } from "@/lib/api/addons";

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

function elapsedSince(iso: string): string {
  const start = new Date(iso).getTime();
  const diffMs = Date.now() - start;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins ? `${hrs}h ${remMins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

function stopProgress(run: RouteRun): { done: number; total: number } {
  const total = run._count?.stops ?? run.stops?.length ?? 0;
  const done =
    run.stops?.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED").length ?? 0;
  return { done, total };
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

function ActiveNowCard({ bothFeatures }: { bothFeatures: boolean }) {
  const { data, isLoading, isError } = useRouteRuns(
    { activeOnly: true, limit: 100 },
    { refetchInterval: 30_000 },
  );
  const runs = data?.data ?? [];

  return (
    <CardShell title="Active Now">
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-36 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
        </div>
      ) : runs.length === 0 ? (
        <p className="text-sm text-navy/70">No active runs right now.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {runs.map((run) => {
            const { done, total } = stopProgress(run);
            const driverName = run.driver?.contactName ?? "Unassigned";
            const routeName = run.route?.name ?? "Route";
            const elapsed = run.startedAt ? elapsedSince(run.startedAt) : null;
            return (
              <div
                key={run.id}
                className="flex flex-col gap-3 rounded-lg border border-surface-border bg-white p-4 shadow-card"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center font-semibold text-navy">
                      <span className="min-w-0 truncate">{routeName}</span>
                      {bothFeatures && run.route?.kind === "ADHOC" ? (
                        <span className="ml-2 shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-600 ring-1 ring-brand-200">
                          Delivery
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-navy/70">{driverName}</p>
                  </div>
                  {statusBadge(run.status)}
                </div>
                <div className="flex items-center justify-between text-xs text-navy/70">
                  <span>
                    {done} / {total} completed
                  </span>
                  {elapsed && (
                    <span className="flex items-center gap-1 text-navy/70">
                      <Clock className="h-3.5 w-3.5" />
                      {elapsed}
                    </span>
                  )}
                </div>
                <Link
                  href={`/routes/${run.id}/dispatch`}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-navy transition-colors hover:bg-surface-raised"
                >
                  Open dispatch
                  <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}

function TodaysScheduleCard({
  runs,
  isLoading,
  isError,
  bothFeatures,
  emptyCopy,
}: {
  runs: RouteRun[];
  isLoading: boolean;
  isError: boolean;
  bothFeatures: boolean;
  emptyCopy: string;
}) {
  const router = useRouter();

  return (
    <CardShell title="Today's Schedule">
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
        </div>
      ) : runs.length === 0 ? (
        <p className="text-sm text-navy/70">{emptyCopy}</p>
      ) : (
        <ul className="divide-y divide-surface-border">
          {runs.map((run) => {
            const routeName = run.route?.name ?? "Route";
            const driverName = run.driver?.contactName;
            const startTime = run.startTime
              ? run.startTime
              : run.startedAt
                ? new Date(run.startedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : null;
            return (
              <li
                key={run.id}
                onClick={() => router.push(`/routes/${run.id}`)}
                className="flex cursor-pointer items-center justify-between gap-3 py-3 transition-colors hover:bg-surface-raised/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center text-sm font-medium text-navy">
                    <span className="min-w-0 truncate">{routeName}</span>
                    {bothFeatures && run.route?.kind === "ADHOC" ? (
                      <span className="ml-2 shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-600 ring-1 ring-brand-200">
                        Delivery
                      </span>
                    ) : null}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-navy/70">
                    {driverName ? (
                      <span className="truncate">{driverName}</span>
                    ) : (
                      <Badge variant="warning" label="Unassigned" />
                    )}
                    {startTime && (
                      <span className="flex items-center gap-1 text-navy/70">
                        <Clock className="h-3 w-3" />
                        {startTime}
                      </span>
                    )}
                  </div>
                </div>
                {statusBadge(run.status)}
              </li>
            );
          })}
        </ul>
      )}
    </CardShell>
  );
}

function DriversCard({ todaysRuns }: { todaysRuns: RouteRun[] }) {
  const router = useRouter();
  const { data, isLoading, isError } = useDrivers({ limit: 100 });
  const drivers = data?.data ?? [];

  const runsByDriver = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of todaysRuns) {
      if (run.driverId) {
        counts.set(run.driverId, (counts.get(run.driverId) ?? 0) + 1);
      }
    }
    return counts;
  }, [todaysRuns]);

  return (
    <CardShell title="Drivers">
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
        </div>
      ) : drivers.length === 0 ? (
        <p className="text-sm text-navy/70">No drivers yet.</p>
      ) : (
        <ul className="divide-y divide-surface-border">
          {drivers.map((d: Driver) => {
            const count = runsByDriver.get(d.id) ?? 0;
            return (
              <li
                key={d.id}
                onClick={() => router.push(`/drivers/${d.id}`)}
                className="flex cursor-pointer items-center justify-between gap-3 py-3 transition-colors hover:bg-surface-raised/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-navy">{d.contactName}</p>
                  <p className="mt-0.5 text-xs text-navy/70">
                    {count === 0 ? "No runs today" : `${count} run${count === 1 ? "" : "s"} today`}
                  </p>
                </div>
                <Badge status={d.status} />
              </li>
            );
          })}
        </ul>
      )}
    </CardShell>
  );
}

export default function DispatchPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Dispatch");
  }, [setTitle]);

  const router = useRouter();
  const { enabled: devMode } = useDeveloperMode();
  const { enabled: routesAccess } = useRoutesAccess();
  const { enabled: deliveryAccess } = useDeliveryAccess();
  const showRoutes = devMode || routesAccess;
  const showDelivery = devMode || deliveryAccess;
  const bothFeatures = showRoutes && showDelivery;

  const subtitle = bothFeatures
    ? "Today's routes, deliveries, and driver status."
    : showDelivery
      ? "Today's deliveries and driver status."
      : "Today's runs and driver status across the operation.";
  const scheduleEmptyCopy =
    showDelivery && !showRoutes ? "No deliveries scheduled today." : "Nothing scheduled today.";

  const today = todayLocalISO();
  const {
    data: todaysData,
    isLoading: todaysLoading,
    isError: todaysError,
  } = useRouteRuns({ date: today, limit: 100 });
  const todaysRuns = todaysData?.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Dispatch"
        subtitle={subtitle}
        action={
          showDelivery ? (
            <Button onClick={() => router.push("/deliveries/new")}>Plan delivery</Button>
          ) : undefined
        }
      />

      <ActiveNowCard bothFeatures={bothFeatures} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TodaysScheduleCard
          runs={todaysRuns}
          isLoading={todaysLoading}
          isError={todaysError}
          bothFeatures={bothFeatures}
          emptyCopy={scheduleEmptyCopy}
        />
        <DriversCard todaysRuns={todaysRuns} />
      </div>
    </div>
  );
}
