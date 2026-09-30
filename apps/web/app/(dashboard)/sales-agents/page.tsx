"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Loader2 } from "lucide-react";
import {
  PageHeader,
  Table,
  Badge,
  Button,
  Select,
  type BadgeVariant,
  Card,
} from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useTenantAddons } from "@/lib/api/tobacco";
import { SALES_AGENTS_ADDON } from "@/lib/api/addons";
import { LockedPage } from "@/app/(dashboard)/_components/gates/PlanGates";
import {
  useSalesAgents,
  pctLabel,
  type SalesAgent,
  type SalesAgentStatus,
} from "@/lib/api/sales-agents";
import { AgentFormModal } from "./_components/AgentFormModal";

// ─── Status display ─────────────────────────────────────────────────────────

const STATUS_VARIANT: Record<SalesAgentStatus, BadgeVariant> = {
  ACTIVE: "success",
  PAUSED: "neutral",
  STOPPED_FOR_NEW: "warning",
};

function statusLabel(s: SalesAgentStatus): string {
  return s === "STOPPED_FOR_NEW" ? "Stopped for new" : s.charAt(0) + s.slice(1).toLowerCase();
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "PAUSED", label: "Paused" },
  { value: "STOPPED_FOR_NEW", label: "Stopped for new" },
];

/**
 * Sales agents list — PR-D WP4. Gated behind the `sales_agents` addon: the
 * server independently 403s every /sales-agents* route via PlanFlagGuard, so
 * this page's gate is UX only (hide the surface + a friendly LockedPage on a
 * deep link), never the source of truth.
 */
export default function SalesAgentsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => setTitle("Sales Agents"), [setTitle]);

  const router = useRouter();

  const { data: addonsData, isLoading: addonsLoading } = useTenantAddons();
  const hasSalesAgents = addonsData?.addons?.includes(SALES_AGENTS_ADDON) ?? false;

  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [includeDeleted, setIncludeDeleted] = React.useState(false);
  const [isAddOpen, setIsAddOpen] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: agents, isLoading } = useSalesAgents(
    {
      search: debouncedSearch || undefined,
      status: status || undefined,
      includeDeleted,
    },
    { enabled: hasSalesAgents },
  );

  const columns = React.useMemo<ColumnDef<SalesAgent, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium text-navy">{row.original.name}</span>
            {row.original.deletedAt && <span className="text-xs text-navy/50">Deactivated</span>}
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) =>
          row.original.deletedAt ? (
            <Badge variant="danger" label="Deactivated" />
          ) : (
            <Badge
              variant={STATUS_VARIANT[row.original.status]}
              label={statusLabel(row.original.status)}
            />
          ),
      },
      {
        id: "currentRatePct",
        header: "Current rate",
        cell: ({ row }) =>
          row.original.currentRatePct != null ? pctLabel(row.original.currentRatePct) : "—",
      },
      {
        accessorKey: "openAssignmentCount",
        header: "Customers",
        cell: ({ row }) => row.original.openAssignmentCount ?? 0,
      },
      {
        id: "contact",
        header: "Email / Phone",
        cell: ({ row }) => (
          <div className="flex flex-col text-xs text-navy/70">
            {row.original.email && <span>{row.original.email}</span>}
            {row.original.phone && <span>{row.original.phone}</span>}
            {!row.original.email && !row.original.phone && "—"}
          </div>
        ),
      },
    ],
    [],
  );

  if (addonsLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (!hasSalesAgents) {
    return (
      <LockedPage
        gate={{
          code: "PLAN_GATE",
          message: "Sales agents & commissions isn't enabled for this workspace.",
        }}
        title="Sales agents & commissions"
      >
        <Card className="h-64" />
      </LockedPage>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Sales Agents"
        subtitle="Manage agents, commission rates, and customer attribution."
        action={<Button onClick={() => setIsAddOpen(true)}>Add agent</Button>}
      />

      <div className="rounded-lg border border-surface-border bg-white shadow-card">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-surface-border px-4 py-3">
          <div className="w-40">
            <Select
              options={STATUS_OPTIONS}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-navy/70">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-surface-border text-brand-500 focus:ring-brand-500"
            />
            Show deactivated
          </label>
          <input
            type="search"
            placeholder="Search by name, email, phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ml-auto h-8 w-64 rounded-lg border border-surface-border bg-white px-3 text-xs text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <Table
          className="border-0 rounded-none"
          data={agents ?? []}
          columns={columns}
          isLoading={isLoading}
          onRowClick={(row) => router.push(`/sales-agents/${row.original.id}`)}
          emptyState="No sales agents yet."
        />
      </div>

      <AgentFormModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onCreated={(id) => router.push(`/sales-agents/${id}`)}
      />
    </div>
  );
}
