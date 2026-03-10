"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Clock } from "lucide-react";
import { PageHeader, Table, Badge, Button, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { AddDriverModal } from "./_components/AddDriverModal";
import { drivers, type Driver, type DriverStatus } from "@/mocks/drivers";

// ─── Status badge ─────────────────────────────────────────────────────────────

function DriverStatusBadge({ driver }: { driver: Driver }) {
  if (driver.status === "IN_PROGRESS") {
    return (
      <Badge
        variant="info"
        label={driver.currentRouteName ? `On Route · ${driver.currentRouteName}` : "On Route"}
      />
    );
  }
  if (driver.status === "ACTIVE") return <Badge status="ACTIVE" />;
  return <Badge status="INACTIVE" />;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DriversPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const [isAddOpen, setIsAddOpen] = React.useState(false);

  React.useEffect(() => { setTitle("Drivers"); }, [setTitle]);

  const columns = React.useMemo<ColumnDef<Driver, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="font-medium text-navy">{row.original.name}</span>
        ),
      },
      {
        accessorKey: "phone",
        header: "Phone",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-navy/70">{row.original.phone}</span>
        ),
      },
      {
        accessorKey: "vehicle",
        header: "Vehicle",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-sm text-navy/70">{row.original.vehicle}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <DriverStatusBadge driver={row.original} />,
      },
      {
        accessorKey: "lastSeen",
        header: "Last Seen",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5 text-sm text-navy/60">
            <Clock className="h-3.5 w-3.5" />
            {row.original.lastSeen}
          </span>
        ),
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

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Drivers"
        action={
          <Button onClick={() => setIsAddOpen(true)}>Add Driver</Button>
        }
      />

      <Table
        data={drivers}
        columns={columns}
        onRowClick={(row) => router.push(`/drivers/${row.original.id}`)}
        emptyState="No drivers found."
      />

      <AddDriverModal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} />
    </div>
  );
}
