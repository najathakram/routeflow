"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Tabs from "@radix-ui/react-tabs";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeft,
  Phone,
  Truck,
  Calendar,
  CheckCircle2,
  MapPin,
  AlertTriangle,
  Pencil,
  Trash2,
} from "lucide-react";
import { Badge, Button, Card, StatCard, Table, cn } from "@routeflow/ui/web";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useDriver, useDriverHistory, useDriverMetrics, useUpdateDriver, useDeleteDriver } from "@/lib/api/drivers";
import { EditDriverModal } from "../_components/EditDriverModal";

// ─── Route run table columns ──────────────────────────────────────────────────

interface RouteRunRow {
  id: string;
  createdAt: string;
  route: { id: string; name: string } | null;
  _count: { stops: number };
  status: string;
}

const runColumns: ColumnDef<RouteRunRow, unknown>[] = [
  {
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) => (
      <span className="text-navy/70">
        {new Date(row.original.createdAt).toLocaleDateString()}
      </span>
    ),
  },
  {
    id: "routeName",
    header: "Route",
    cell: ({ row }) => (
      <span className="font-medium text-navy">
        {row.original.route?.name ?? "—"}
      </span>
    ),
  },
  {
    id: "stops",
    header: "Stops",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-navy/70">{row.original._count.stops}</span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <span className="text-navy/70">{row.original.status}</span>
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
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: driver, isLoading: driverLoading } = useDriver(params.id);
  const { data: historyData } = useDriverHistory(params.id);
  const { data: metrics } = useDriverMetrics(params.id);
  const updateDriver = useUpdateDriver();
  const deleteDriver = useDeleteDriver();

  const [isEditOpen, setIsEditOpen] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

  const runs: RouteRunRow[] = historyData?.data ?? [];
  const completedRuns: number = metrics?.completedRuns ?? 0;
  const totalRuns: number = metrics?.totalRuns ?? 0;

  React.useEffect(() => {
    setTitle(driver?.contactName ?? "Driver");
  }, [setTitle, driver?.contactName]);

  if (driverLoading) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Loading driver…</p>
      </div>
    );
  }

  if (!driver) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Driver not found.</p>
        <Button variant="secondary" href="/drivers">Back to Drivers</Button>
      </div>
    );
  }

  const vehicleLabel = [
    driver.vehicleMake,
    driver.vehicleModel,
    driver.vehicleColour,
    driver.vehiclePlate,
  ]
    .filter(Boolean)
    .join(" · ") || "—";

  const statusBadge = () => {
    return <Badge status={driver.status === "ACTIVE" ? "ACTIVE" : "INACTIVE"} />;
  };

  const completionRate = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;

  const handleSaveDriver = async (data: Partial<typeof driver>) => {
    await updateDriver.mutateAsync({ id: params.id, data });
    toast({ title: "Driver updated", variant: "success" });
  };

  const handleDeleteDriver = async () => {
    try {
      await deleteDriver.mutateAsync(params.id);
      toast({ title: "Driver deleted", variant: "success" });
      router.push("/drivers");
    } catch (err: unknown) {
      const apiMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast({ title: apiMsg || "Failed to delete driver", variant: "error" });
      setShowDeleteConfirm(false);
    }
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
          <h1 className="text-2xl font-bold text-navy">{driver.contactName}</h1>
          <p className="mt-1 text-sm text-navy/60">@{driver.user.username}</p>
        </div>
        <div className="flex items-center gap-2">
          {statusBadge()}
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Pencil className="h-4 w-4" />}
            onClick={() => setIsEditOpen(true)}
          >
            Edit
          </Button>
          <Button
            variant="danger"
            size="sm"
            leftIcon={<Trash2 className="h-4 w-4" />}
            onClick={() => setShowDeleteConfirm(true)}
          >
            Delete
          </Button>
        </div>
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
                <InfoRow icon={Phone} label="Phone" value={driver.phone ?? "—"} />
                <InfoRow icon={Truck} label="Vehicle" value={vehicleLabel} />
                <InfoRow
                  icon={Calendar}
                  label="Driver Since"
                  value={new Date(driver.createdAt).toLocaleDateString()}
                />
              </div>
            </Card>

            <Card title="Account Status">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-navy/60">Status</p>
                  {statusBadge()}
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-navy/60">Email</p>
                  <p className="text-sm font-medium text-navy">{driver.user.email}</p>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-navy/60">Account</p>
                  <p className="text-sm font-medium text-navy">{driver.user.status}</p>
                </div>
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
              value={completedRuns}
              icon={<CheckCircle2 className="h-5 w-5" />}
            />
            <StatCard
              label="Total Runs"
              value={totalRuns}
              icon={<MapPin className="h-5 w-5" />}
            />
            <StatCard
              label="Completion Rate"
              value={`${completionRate}%`}
              icon={<AlertTriangle className={cn("h-5 w-5", completionRate >= 95 ? "text-success" : completionRate >= 85 ? "text-warning" : "text-danger")} />}
            />
          </div>
        </Tabs.Content>
      </Tabs.Root>

      {/* Edit modal */}
      {isEditOpen && (
        <EditDriverModal
          driver={driver}
          isOpen={isEditOpen}
          onClose={() => setIsEditOpen(false)}
          onSave={handleSaveDriver}
        />
      )}

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-base font-semibold text-navy">Delete Driver</h2>
            <p className="mt-2 text-sm text-navy/70">
              Are you sure you want to delete{" "}
              <span className="font-medium text-navy">{driver.contactName}</span>? This will
              permanently remove their account. Drivers with active route runs cannot be deleted.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={deleteDriver.isPending}
                onClick={handleDeleteDriver}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
