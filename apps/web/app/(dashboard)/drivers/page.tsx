"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye } from "lucide-react";
import { PageHeader, Table, Badge, Button } from "@routeflow/ui/web";
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DriversPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const [isAddOpen, setIsAddOpen] = React.useState(false);

  React.useEffect(() => { setTitle("Drivers"); }, [setTitle]);

  const { data, isLoading } = useDrivers();
  const createDriver = useCreateDriver();

  const drivers = data?.data ?? [];

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
          <span className="font-medium text-navy">{row.original.contactName}</span>
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
        emptyState={isLoading ? "Loading drivers…" : "No drivers found."}
      />

      <AddDriverModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onCreateDriver={handleCreateDriver}
      />
    </div>
  );
}
