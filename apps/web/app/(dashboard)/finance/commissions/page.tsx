"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2 } from "lucide-react";
import { PageHeader, Button, Card, Badge, EmptyState } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useTenantAddons } from "@/lib/api/tobacco";
import { SALES_AGENTS_ADDON } from "@/lib/api/addons";
import { LockedPage } from "@/app/(dashboard)/_components/gates/PlanGates";
import { useSalesAgents, useCommissionStatements } from "@/lib/api/sales-agents";
import { fmt, fmtCalendarDate, fmtDate } from "@/lib/formatting";
import { GenerateStatementModal } from "./_components/GenerateStatementModal";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "PAID", label: "Paid" },
  { value: "VOID", label: "Void" },
];

/**
 * PR-D WP6 — commission statements list. Locked-state pattern copied verbatim
 * from WP4 (agents pages): the addon gate is checked BEFORE any other page
 * query fires, so an unflagged tenant never issues a /commission-statements
 * request, and the loading state is keyed off `useTenantAddons().isLoading`
 * to avoid a lock-flash.
 */
export default function CommissionStatementsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Commissions");
  }, [setTitle]);

  const router = useRouter();
  const { data: addonsData, isLoading: addonsLoading } = useTenantAddons();
  const hasSalesAgents = addonsData?.addons?.includes(SALES_AGENTS_ADDON) ?? false;

  const [agentId, setAgentId] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [isGenerateOpen, setIsGenerateOpen] = React.useState(false);

  const { data: agents } = useSalesAgents(undefined, { enabled: hasSalesAgents });
  const {
    data: statements,
    isLoading,
    isError,
    refetch,
  } = useCommissionStatements(
    { agentId: agentId || undefined, status: status || undefined },
    { enabled: hasSalesAgents },
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
        title="Commissions"
      >
        <Card className="h-64" />
      </LockedPage>
    );
  }

  const rows = statements ?? [];

  return (
    <div className="space-y-5 p-6">
      <GenerateStatementModal open={isGenerateOpen} onClose={() => setIsGenerateOpen(false)} />

      <PageHeader
        title="Commissions"
        subtitle="Generate, review, and pay out agent commission statements."
        action={
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setIsGenerateOpen(true)}>
            Generate statement
          </Button>
        }
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-surface-border bg-white p-4">
        <label className="text-sm text-navy/70" htmlFor="commissions-agent-filter">
          Agent
        </label>
        <select
          id="commissions-agent-filter"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="h-9 rounded-lg border border-surface-border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All agents</option>
          {(agents ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <label className="text-sm text-navy/70" htmlFor="commissions-status-filter">
          Status
        </label>
        <select
          id="commissions-status-filter"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-lg border border-surface-border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Number</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Agent</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Period</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Total</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Paid</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border bg-white">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/70" />
                  </td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <p className="text-sm text-danger">Couldn&apos;t load commission statements.</p>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2"
                      onClick={() => void refetch()}
                    >
                      Try again
                    </Button>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-0">
                    <EmptyState
                      variant="data"
                      title="No commission statements"
                      description="Generate a statement to claim an agent's accrued commission for payout."
                      action={
                        <Button size="sm" onClick={() => setIsGenerateOpen(true)}>
                          Generate statement
                        </Button>
                      }
                    />
                  </td>
                </tr>
              ) : (
                rows.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => router.push(`/finance/commissions/${s.id}`)}
                    className="cursor-pointer transition-colors hover:bg-surface-raised"
                  >
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                      {s.statementNumber}
                    </td>
                    <td className="px-4 py-3 font-medium text-navy">{s.agent.name}</td>
                    <td className="px-4 py-3">
                      <Badge status={s.status} />
                    </td>
                    <td className="px-4 py-3 text-navy/70">
                      {s.periodFrom || s.periodTo
                        ? `${fmtCalendarDate(s.periodFrom)} – ${fmtCalendarDate(s.periodTo)}`
                        : "Open period"}
                    </td>
                    <td className="px-4 py-3 text-right text-navy">{fmt(Number(s.totalAmount))}</td>
                    <td className="px-4 py-3 text-right text-navy">{fmt(Number(s.paidAmount))}</td>
                    <td className="px-4 py-3 text-navy/70">{fmtDate(s.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
