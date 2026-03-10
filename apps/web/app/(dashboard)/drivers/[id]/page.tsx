"use client";

import * as React from "react";
import Link from "next/link";
import * as Tabs from "@radix-ui/react-tabs";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeft,
  Phone,
  Truck,
  Calendar,
  CheckCircle2,
  MapPin,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { Badge, Button, Card, StatCard, Table, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  getDriver,
  getDriverRouteRuns,
  getDriverPerformance,
  type RouteRun,
} from "@/mocks/drivers";

// ─── Route run table columns ──────────────────────────────────────────────────

const runColumns: ColumnDef<RouteRun, unknown>[] = [
  {
    accessorKey: "date",
    header: "Date",
    cell: ({ row }) => <span className="text-navy/70">{row.original.date}</span>,
  },
  {
    accessorKey: "routeName",
    header: "Route",
    cell: ({ row }) => (
      <span className="font-medium text-navy">{row.original.routeName}</span>
    ),
  },
  {
    id: "stops",
    header: "Stops",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-navy/70">
        {row.original.stopsDone} / {row.original.stopsTotal}
      </span>
    ),
  },
  {
    accessorKey: "deliveriesCompleted",
    header: "Deliveries",
    cell: ({ row }) => <span className="text-navy/70">{row.original.deliveriesCompleted}</span>,
  },
  {
    accessorKey: "notesCount",
    header: "Notes",
    enableSorting: false,
    cell: ({ row }) => (
      <span className={cn("text-sm", row.original.notesCount > 0 ? "text-warning font-medium" : "text-navy/30")}>
        {row.original.notesCount > 0 ? row.original.notesCount : "—"}
      </span>
    ),
  },
];

// ─── Tab trigger ──────────────────────────────────────────────────────────────

function TabTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        "-mb-px border-b-2 px-4 py-3 text-sm font-medium transition-colors",
        "border-transparent text-navy/60 hover:text-navy",
        "data-[state=active]:border-brand-500 data-[state=active]:text-navy",
      )}
    >
      {children}
    </Tabs.Trigger>
  );
}

// ─── Info row ─────────────────────────────────────────────────────────────────

function InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-navy/40" />
      <div>
        <p className="text-xs text-navy/50">{label}</p>
        <p className="mt-0.5 text-sm font-medium text-navy">{value}</p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DriverDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const driver = getDriver(params.id);
  const runs = getDriverRouteRuns(params.id);
  const perf = getDriverPerformance(params.id);

  React.useEffect(() => {
    setTitle(driver?.name ?? "Driver");
  }, [setTitle, driver?.name]);

  if (!driver) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Driver not found.</p>
        <Button variant="secondary" href="/drivers">Back to Drivers</Button>
      </div>
    );
  }

  const statusBadge = () => {
    if (driver.status === "IN_PROGRESS") {
      return (
        <Badge
          variant="info"
          label={driver.currentRouteName ? `On Route · ${driver.currentRouteName}` : "On Route"}
        />
      );
    }
    return <Badge status={driver.status === "ACTIVE" ? "ACTIVE" : "INACTIVE"} />;
  };

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/drivers"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Drivers
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">{driver.name}</h1>
          <p className="mt-1 text-sm text-navy/60">@{driver.username}</p>
        </div>
        <div className="flex items-center gap-3">{statusBadge()}</div>
      </div>

      {/* Tabs */}
      <Tabs.Root defaultValue="profile" className="flex flex-col">
        <Tabs.List className="flex border-b border-surface-border">
          <TabTrigger value="profile">Profile</TabTrigger>
          <TabTrigger value="history">
            Delivery History{runs.length > 0 ? ` (${runs.length})` : ""}
          </TabTrigger>
          <TabTrigger value="performance">Performance</TabTrigger>
        </Tabs.List>

        {/* ── Profile ─────────────────────────────────────────────────── */}
        <Tabs.Content value="profile" className="mt-5 focus:outline-none">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="Driver Information">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <InfoRow icon={Phone} label="Phone" value={driver.phone} />
                <InfoRow icon={Truck} label="Vehicle" value={driver.vehicle} />
                <InfoRow
                  icon={Clock}
                  label="Last Seen"
                  value={driver.lastSeen}
                />
                <InfoRow
                  icon={Calendar}
                  label="Driver Since"
                  value={driver.createdAt}
                />
              </div>
            </Card>

            <Card title="Account Status">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-navy/60">Status</p>
                  {statusBadge()}
                </div>
                {driver.currentRouteName && (
                  <div className="flex items-center gap-2 rounded-lg bg-brand-50 border border-brand-100 px-3 py-2.5">
                    <MapPin className="h-4 w-4 text-brand-500" />
                    <div>
                      <p className="text-xs text-brand-700/70">Currently running</p>
                      <p className="text-sm font-medium text-brand-700">
                        {driver.currentRouteName}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </Tabs.Content>

        {/* ── Delivery History ─────────────────────────────────────────── */}
        <Tabs.Content value="history" className="mt-5 focus:outline-none">
          <Card title="Route Run History">
            <div className="-mx-6 -mb-6">
              <Table
                data={runs}
                columns={runColumns}
                emptyState="No route runs recorded yet."
              />
            </div>
          </Card>
        </Tabs.Content>

        {/* ── Performance ──────────────────────────────────────────────── */}
        <Tabs.Content value="performance" className="mt-5 focus:outline-none">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Routes Completed"
              value={perf.routesCompleted}
              icon={<CheckCircle2 className="h-5 w-5" />}
            />
            <StatCard
              label="Total Stops Done"
              value={perf.totalStops}
              icon={<MapPin className="h-5 w-5" />}
            />
            <StatCard
              label="On-Time Rate"
              value={`${perf.onTimePercent}%`}
              icon={<Clock className={cn("h-5 w-5", perf.onTimePercent >= 95 ? "text-success" : perf.onTimePercent >= 85 ? "text-warning" : "text-danger")} />}
            />
            <StatCard
              label="Stops Skipped"
              value={perf.stopsSkipped}
              icon={<AlertTriangle className={cn("h-5 w-5", perf.stopsSkipped === 0 ? "" : "text-warning")} />}
            />
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
