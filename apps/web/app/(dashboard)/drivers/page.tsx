"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye } from "lucide-react";
import { PageHeader, Table, Badge, Button, Select, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { AddDriverModal } from "./_components/AddDriverModal";
import { useDrivers, useCreateDriver, type Driver } from "@/lib/api/drivers";

// ─── Status badge ─────────────────────────────────────────────────────────────

function DriverStatusBadge({ driver }: { driver: Driver }) {
  if (driver.status === "ACTIVE") return <Badge status="ACTIVE" />;
  return <Badge status="INACTIVE" />;
}

// ─── Vehicle display helper ───────────────────────────────────────────────────

function vehicleLabel(driver: Driver): string {
  const parts = [driver.vehicleMake, driver.vehicleModel, driver.vehicleColour, driver.vehiclePlate].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

// ─── Status filter options ────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DriversPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");

  React.useEffect(() => { setTitle("Drivers"); }, [setTitle]);

  const { data, isLoading } = useDrivers();
  const createDriver = useCreateDriver();

  const drivers = data?.data ?? [];

  // Client-side filtering
  const filtered = React.useMemo(() => {
    const q = search.toLowerCase();
    return drivers.filter((d) => {
      if (statusFilter && d.status !== statusFilter) return false;
      if (q) {
        const haystack = [d.contactName, d.phone, d.vehicleMake, d.vehicleModel, d.vehiclePlate, d.user?.username]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [drivers, search, statusFilter]);

  const handleCreateDriver = async (formData: {
    contactName: string;
    email: string;
    username: string;
    phone?: string;
    vehicleMake?: string;
    vehicleModel?: string;
    vehicleColour?: string;
    vehiclePlate?: string;
  }) => {
    const result = await createDriver.mutateAsync(formData);
    return result.tempPassword;
  };

  const columns = React.useMemo<ColumnDef<Driver, unknown>[]>(
    () => [
      {
        accessorKey: "contactName",
        header: "Name",
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-navy">{row.original.contactName}</p>
            <p className="text-xs text-navy/50">{row.original.user?.username}</p>
          </div>
        ),
      },
      {
        accessorKey: "phone",
        header: "Phone",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-navy/70">{row.original.phone ?? "—"}</span>
        ),
      },
      {
        id: "vehicle",
        header: "Vehicle",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-sm text-navy/70">{vehicleLabel(row.original)}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <DriverStatusBadge driver={row.original} />,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
            <button
              title="View driver"
              onClick={() => router.push(`/drivers/${row.original.id}`)}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
            >
              <Eye className="h-4 w-4" />
            </button>
          </div>
        ),
      },
    ],
    [router],
  );

  const activeCount = drivers.filter((d) => d.status === "ACTIVE").length;
  const inactiveCount = drivers.filter((d) => d.status === "INACTIVE").length;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Drivers"
        action={
          <Button onClick={() => setIsAddOpen(true)}>Add Driver</Button>
        }
      />

      {/* Summary chips */}
      <div className="flex items-center gap-2 text-sm">
        <span
          onClick={() => setStatusFilter("")}
          className={cn(
            "cursor-pointer rounded-full px-3 py-1 font-medium transition-colors",
            !statusFilter
              ? "bg-brand-100 text-brand-700"
              : "bg-surface-raised text-navy/60 hover:text-navy",
          )}
        >
          All ({drivers.length})
        </span>
        <span
          onClick={() => setStatusFilter(statusFilter === "ACTIVE" ? "" : "ACTIVE")}
          className={cn(
            "cursor-pointer rounded-full px-3 py-1 font-medium transition-colors",
            statusFilter === "ACTIVE"
              ? "bg-success-bg text-success"
              : "bg-surface-raised text-navy/60 hover:text-navy",
          )}
        >
          Active ({activeCount})
        </span>
        <span
          onClick={() => setStatusFilter(statusFilter === "INACTIVE" ? "" : "INACTIVE")}
          className={cn(
            "cursor-pointer rounded-full px-3 py-1 font-medium transition-colors",
            statusFilter === "INACTIVE"
              ? "bg-surface-border text-navy/60"
              : "bg-surface-raised text-navy/60 hover:text-navy",
          )}
        >
          Inactive ({inactiveCount})
        </span>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by name, phone, plate…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-40">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
        {(search || statusFilter) && (
          <button
            onClick={() => { setSearch(""); setStatusFilter(""); }}
            className="text-sm text-brand-500 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      <Table
        data={filtered}
        columns={columns}
        onRowClick={(row) => router.push(`/drivers/${row.original.id}`)}
        emptyState={
          isLoading ? "Loading drivers…" :
          (search || statusFilter) ? "No drivers match your filters." :
          "No drivers found."
        }
      />

      <AddDriverModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onCreateDriver={handleCreateDriver}
      />
    </div>
  );
}
