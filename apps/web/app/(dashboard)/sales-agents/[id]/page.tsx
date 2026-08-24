"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Select,
  StatCard,
  Textarea,
  cn,
  useToast,
  type BadgeVariant,
} from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { useTenantAddons } from "@/lib/api/tobacco";
import { SALES_AGENTS_ADDON } from "@/lib/api/addons";
import { LockedPage } from "@/app/(dashboard)/_components/gates/PlanGates";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DecimalInput } from "@/components/MoneyInput";
import { fmt, fmtCalendarDate, todayIso } from "@/lib/formatting";
import { useCustomers, type Customer } from "@/lib/api/customers";
import {
  useSalesAgent,
  useUpdateSalesAgent,
  useUpdateSalesAgentStatus,
  useDeleteSalesAgent,
  useAddAgentRate,
  useRemoveAgentRate,
  useAddCustomerRate,
  useCloseAssignment,
  useAgentAccruals,
  useRecomputeAgent,
  pctLabel,
  RATE_SOURCE_LABELS,
  type SalesAgentDetail,
  type SalesAgentStatus,
  type CommissionAccrualStatus,
} from "@/lib/api/sales-agents";
import { AssignCustomersModal } from "../_components/AssignCustomersModal";

// ─── Status display ─────────────────────────────────────────────────────────

const STATUS_VARIANT: Record<SalesAgentStatus, BadgeVariant> = {
  ACTIVE: "success",
  PAUSED: "neutral",
  STOPPED_FOR_NEW: "warning",
};

function statusLabel(s: SalesAgentStatus): string {
  return s === "STOPPED_FOR_NEW" ? "Stopped for new" : s.charAt(0) + s.slice(1).toLowerCase();
}

const AGENT_STATUSES: SalesAgentStatus[] = ["ACTIVE", "PAUSED", "STOPPED_FOR_NEW"];

function statusDotClass(s: SalesAgentStatus): string {
  if (s === "ACTIVE") return "bg-success";
  if (s === "PAUSED") return "bg-navy/30";
  return "bg-warning";
}

const ACCRUAL_STATUS_VARIANT: Record<CommissionAccrualStatus, BadgeVariant> = {
  PENDING: "warning",
  PARTIAL: "info",
  PAYABLE: "info",
  SETTLED: "success",
  VOID: "neutral",
};

function accrualStatusLabel(s: CommissionAccrualStatus): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

const ACCRUAL_STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "PARTIAL", label: "Partial" },
  { value: "PAYABLE", label: "Payable" },
  { value: "SETTLED", label: "Settled" },
  { value: "VOID", label: "Void" },
];

// ─── Page ────────────────────────────────────────────────────────────────────

/**
 * Sales agent detail — PR-D WP4. One `useSalesAgent` query drives every card
 * except the accrual ledger (its own paginated query). Gated behind the
 * `sales_agents` addon exactly like the list page; the server's
 * `PlanFlagGuard` is the real enforcement, this is UX only.
 */
export default function SalesAgentDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const router = useRouter();
  const { user } = useAuth();
  // TENANT_ADMIN satisfies OPERATOR server-side (ROLE_SATISFIES in roles.guard.ts) — gate
  // the UI on the same pair the API accepts, mirroring the customer page's agent box.
  const isOperator = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";

  const { data: addonsData, isLoading: addonsLoading } = useTenantAddons();
  const hasSalesAgents = addonsData?.addons?.includes(SALES_AGENTS_ADDON) ?? false;

  const { data: agent, isLoading } = useSalesAgent(params.id, { enabled: hasSalesAgents });

  React.useEffect(() => {
    setTitle(agent?.name ?? "Sales Agent");
  }, [setTitle, agent?.name]);

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Sales agent not found.</p>
        <Button variant="secondary" href="/sales-agents">
          Back to Sales Agents
        </Button>
      </div>
    );
  }

  return (
    <AgentDetailView
      agent={agent}
      isOperator={isOperator}
      onDeleted={() => router.push("/sales-agents")}
    />
  );
}

// ─── Main layout ─────────────────────────────────────────────────────────────

function AgentDetailView({
  agent,
  isOperator,
  onDeleted,
}: {
  agent: SalesAgentDetail;
  isOperator: boolean;
  onDeleted: () => void;
}) {
  return (
    <div className="space-y-5 p-6">
      <Link
        href="/sales-agents"
        className="flex w-fit items-center gap-1.5 text-sm text-navy/70 transition-colors hover:text-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Sales Agents
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-navy">{agent.name}</h1>
        <Badge variant={STATUS_VARIANT[agent.status]} label={statusLabel(agent.status)} />
        {agent.deletedAt && <Badge variant="danger" label="Deactivated" />}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Accrued" value={fmt(Number(agent.accrualTotals.accrued))} />
        <StatCard label="Payable" value={fmt(Number(agent.accrualTotals.payable))} />
        <StatCard label="Claimed" value={fmt(Number(agent.accrualTotals.claimed))} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <RatesCard agent={agent} isOperator={isOperator} />
          <CustomerRateCard agentId={agent.id} isOperator={isOperator} />
          <CustomersCard agent={agent} isOperator={isOperator} />
        </div>
        <div className="space-y-5">
          <ContactCard agent={agent} isOperator={isOperator} />
          <StatusCard agent={agent} isOperator={isOperator} onDeleted={onDeleted} />
        </div>
      </div>

      <LedgerCard agentId={agent.id} />
    </div>
  );
}

// ─── Contact card (inline edit) ──────────────────────────────────────────────

function ContactCard({ agent, isOperator }: { agent: SalesAgentDetail; isOperator: boolean }) {
  const { toast } = useToast();
  const updateAgent = useUpdateSalesAgent();

  const [name, setName] = React.useState(agent.name);
  const [email, setEmail] = React.useState(agent.email ?? "");
  const [phone, setPhone] = React.useState(agent.phone ?? "");
  const [notes, setNotes] = React.useState(agent.notes ?? "");

  // Re-sync local state whenever the server payload changes underneath (a
  // save, a refetch elsewhere) so a stale field never masks a saved value.
  React.useEffect(() => {
    setName(agent.name);
    setEmail(agent.email ?? "");
    setPhone(agent.phone ?? "");
    setNotes(agent.notes ?? "");
  }, [agent.id, agent.name, agent.email, agent.phone, agent.notes]);

  const dirty =
    name.trim() !== agent.name ||
    email.trim() !== (agent.email ?? "") ||
    phone.trim() !== (agent.phone ?? "") ||
    notes.trim() !== (agent.notes ?? "");

  const handleCancel = () => {
    setName(agent.name);
    setEmail(agent.email ?? "");
    setPhone(agent.phone ?? "");
    setNotes(agent.notes ?? "");
  };

  const handleSave = () => {
    // PATCH sends only the fields that actually changed.
    const patch: {
      id: string;
      name?: string;
      email?: string | null;
      phone?: string;
      notes?: string;
    } = {
      id: agent.id,
    };
    if (name.trim() !== agent.name) patch.name = name.trim();
    // Blank clears the email: `@IsOptional()` skips validation for null but an
    // empty string would be validated and rejected by `@IsEmail()`.
    if (email.trim() !== (agent.email ?? "")) patch.email = email.trim() || null;
    if (phone.trim() !== (agent.phone ?? "")) patch.phone = phone.trim();
    if (notes.trim() !== (agent.notes ?? "")) patch.notes = notes.trim();
    updateAgent.mutate(patch, {
      onSuccess: () => toast({ title: "Agent updated", variant: "success" }),
    });
  };

  return (
    <Card title="Contact">
      <div className="space-y-3">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!isOperator}
        />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={!isOperator}
        />
        <Input
          label="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={!isOperator}
        />
        <Textarea
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={!isOperator}
        />
        {isOperator && dirty && (
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              loading={updateAgent.isPending}
              disabled={!name.trim()}
            >
              Save
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Status card ─────────────────────────────────────────────────────────────

function StatusCard({
  agent,
  isOperator,
  onDeleted,
}: {
  agent: SalesAgentDetail;
  isOperator: boolean;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const updateStatus = useUpdateSalesAgentStatus();
  const deleteAgent = useDeleteSalesAgent();
  const [stopModalOpen, setStopModalOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const handleClick = (s: SalesAgentStatus) => {
    if (s === agent.status) return;
    if (s === "STOPPED_FOR_NEW") {
      setStopModalOpen(true);
      return;
    }
    updateStatus.mutate({ id: agent.id, status: s });
  };

  const handleDelete = () => {
    deleteAgent.mutate(agent.id, {
      onSuccess: () => {
        toast({ title: "Agent deactivated", variant: "success" });
        onDeleted();
      },
    });
  };

  return (
    <Card title="Status">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">Current status</p>
          <Badge variant={STATUS_VARIANT[agent.status]} label={statusLabel(agent.status)} />
        </div>
        {agent.status === "STOPPED_FOR_NEW" && agent.stopNewBusinessAt && (
          <p className="text-xs text-navy/70">
            Stopped from {fmtCalendarDate(agent.stopNewBusinessAt)}
          </p>
        )}
        {isOperator && (
          <div className="space-y-2">
            {AGENT_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => handleClick(s)}
                disabled={updateStatus.isPending}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                  agent.status === s
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-surface-border text-navy/70 hover:border-navy/30 hover:text-navy",
                )}
              >
                <span className={cn("h-2 w-2 rounded-full", statusDotClass(s))} />
                {statusLabel(s)}
              </button>
            ))}
          </div>
        )}
        {isOperator && (
          <div className="border-t border-surface-border pt-4">
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg border border-danger/30 px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/5"
            >
              <Trash2 className="h-4 w-4" />
              Deactivate agent
            </button>
          </div>
        )}
      </div>

      <StopForNewModal
        isOpen={stopModalOpen}
        onClose={() => setStopModalOpen(false)}
        agentId={agent.id}
      />
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title="Deactivate this agent?"
        description={`${agent.name} will be soft-deleted. If they have unconverged claimed commission or a non-paid statement outstanding, the server will block this and explain why.`}
        confirmLabel="Deactivate"
        variant="danger"
        loading={deleteAgent.isPending}
      />
    </Card>
  );
}

function StopForNewModal({
  isOpen,
  onClose,
  agentId,
}: {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
}) {
  const { toast } = useToast();
  const updateStatus = useUpdateSalesAgentStatus();
  const [stopDate, setStopDate] = React.useState("");

  React.useEffect(() => {
    if (isOpen) setStopDate("");
  }, [isOpen]);

  const handleConfirm = () => {
    updateStatus.mutate(
      { id: agentId, status: "STOPPED_FOR_NEW", stopNewBusinessAt: stopDate || undefined },
      {
        onSuccess: () => {
          toast({ title: "Agent stopped for new business", variant: "success" });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Stop new business"
      description="Stops NEW business from this date; pre-existing standing orders keep earning."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={updateStatus.isPending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} loading={updateStatus.isPending}>
            Confirm
          </Button>
        </>
      }
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-navy">
          Effective date (optional)
        </label>
        <input
          type="date"
          value={stopDate}
          onChange={(e) => setStopDate(e.target.value)}
          className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <p className="mt-1 text-xs text-navy/70">Leave blank to stop effective now.</p>
      </div>
    </Modal>
  );
}

// ─── Default rates card ──────────────────────────────────────────────────────

function RatesCard({ agent, isOperator }: { agent: SalesAgentDetail; isOperator: boolean }) {
  const { toast } = useToast();
  const addRate = useAddAgentRate();
  const removeRate = useRemoveAgentRate();
  const [showAdd, setShowAdd] = React.useState(false);
  const [ratePct, setRatePct] = React.useState<number | null>(null);
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayIso());

  const todayStr = todayIso();
  // rates[] arrives newest-first; the first row at or before today is "current"
  // even though future-dated rows may sort above it.
  const currentId = agent.rates.find((r) => r.effectiveFrom.slice(0, 10) <= todayStr)?.id;

  const handleAdd = () => {
    if (ratePct == null) return;
    addRate.mutate(
      { id: agent.id, ratePct, effectiveFrom },
      {
        onSuccess: (data) => {
          toast({
            title: data.recompute
              ? `Rate added — recomputed ${data.recompute.invoicesSynced} invoice(s)`
              : "Rate added",
            variant: "success",
          });
          setShowAdd(false);
          setRatePct(null);
          setEffectiveFrom(todayIso());
        },
      },
    );
  };

  const handleRemove = (rateId: string) => {
    if (!confirm("Remove this future-dated rate?")) return;
    removeRate.mutate({ id: agent.id, rateId });
  };

  return (
    <Card title="Default Rates">
      <div className="space-y-3">
        {agent.rates.length === 0 ? (
          <p className="text-sm text-navy/70">No rates set yet.</p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {agent.rates.map((r) => {
              const isFuture = r.effectiveFrom.slice(0, 10) > todayStr;
              return (
                <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-navy">{pctLabel(r.ratePct)}</span>
                    <span className="text-navy/70">from {fmtCalendarDate(r.effectiveFrom)}</span>
                    {r.id === currentId && <Badge variant="success" label="Current" />}
                  </div>
                  {isOperator &&
                    (isFuture ? (
                      <button
                        type="button"
                        onClick={() => handleRemove(r.id)}
                        className="text-navy/50 transition-colors hover:text-danger"
                        aria-label="Remove rate"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : (
                      <span
                        title="History — add a correcting row instead"
                        className="cursor-not-allowed text-navy/20"
                      >
                        <Trash2 className="h-4 w-4" />
                      </span>
                    ))}
                </li>
              );
            })}
          </ul>
        )}

        {isOperator && !showAdd && (
          <Button size="sm" variant="secondary" onClick={() => setShowAdd(true)}>
            Add rate
          </Button>
        )}

        {isOperator && showAdd && (
          <div className="space-y-2 rounded-lg border border-dashed border-surface-border p-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-navy/70">Rate %</label>
                <DecimalInput
                  value={ratePct}
                  onChange={setRatePct}
                  decimals={2}
                  min={0}
                  max={100}
                  className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-navy/70">
                  Effective from
                </label>
                <input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleAdd}
                loading={addRate.isPending}
                disabled={ratePct == null}
              >
                Add
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Customer rates card ──────────────────────────────────────────────────────

function CustomerRateCard({ agentId, isOperator }: { agentId: string; isOperator: boolean }) {
  const [showAdd, setShowAdd] = React.useState(false);

  return (
    <Card title="Customer Rates">
      <div className="space-y-3">
        <p className="text-xs text-navy/70">
          Per-customer overrides layer on top of the agent default. There is no list here — resolved
          rates show per-accrual in the ledger&apos;s Rate column below.
        </p>
        {isOperator && !showAdd && (
          <Button size="sm" variant="secondary" onClick={() => setShowAdd(true)}>
            Add customer rate
          </Button>
        )}
        {isOperator && showAdd && (
          <AddCustomerRateForm
            agentId={agentId}
            onDone={() => setShowAdd(false)}
            onCancel={() => setShowAdd(false)}
          />
        )}
      </div>
    </Card>
  );
}

function AddCustomerRateForm({
  agentId,
  onDone,
  onCancel,
}: {
  agentId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const addCustomerRate = useAddCustomerRate();
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [customerId, setCustomerId] = React.useState("");
  const [customerName, setCustomerName] = React.useState("");
  const [ratePct, setRatePct] = React.useState<number | null>(null);
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayIso());

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data } = useCustomers({ search: debouncedSearch || undefined, limit: 20 });
  const customers: Customer[] = data?.data ?? [];

  const handleSubmit = () => {
    if (!customerId || ratePct == null) return;
    addCustomerRate.mutate(
      { id: agentId, customerId, ratePct, effectiveFrom },
      {
        onSuccess: (result) => {
          toast({
            title: result.recompute
              ? `Rate added — recomputed ${result.recompute.invoicesSynced} invoice(s)`
              : "Rate added",
            variant: "success",
          });
          onDone();
        },
      },
    );
  };

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-surface-border p-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-navy/70">Customer</label>
        {customerId ? (
          <div className="flex items-center justify-between rounded border border-surface-border bg-surface-raised px-2 py-1.5 text-sm">
            <span className="text-navy">{customerName}</span>
            <button
              type="button"
              onClick={() => {
                setCustomerId("");
                setCustomerName("");
                setSearch("");
              }}
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customers…"
              className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {search && customers.length > 0 && (
              <ul className="mt-1 max-h-40 overflow-auto rounded border border-surface-border bg-white text-sm shadow-card">
                {customers.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomerId(c.id);
                        setCustomerName(c.businessName);
                      }}
                      className="block w-full px-2 py-1.5 text-left hover:bg-surface-raised"
                    >
                      {c.businessName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-navy/70">Rate %</label>
          <DecimalInput
            value={ratePct}
            onChange={setRatePct}
            decimals={2}
            min={0}
            max={100}
            className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-navy/70">Effective from</label>
          <input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSubmit}
          loading={addCustomerRate.isPending}
          disabled={!customerId || ratePct == null}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

// ─── Customers card ──────────────────────────────────────────────────────────

function CustomersCard({ agent, isOperator }: { agent: SalesAgentDetail; isOperator: boolean }) {
  const { toast } = useToast();
  const closeAssignment = useCloseAssignment();
  const [assignOpen, setAssignOpen] = React.useState(false);

  const handleEnd = (customerId: string, businessName: string) => {
    if (!confirm(`End ${businessName}'s assignment to this agent?`)) return;
    closeAssignment.mutate(
      { customerId },
      {
        onSuccess: (data) => {
          toast({
            title: "Assignment ended",
            description: data.recompute
              ? `Recomputed ${data.recompute.invoicesSynced} invoice(s)`
              : undefined,
            variant: "success",
          });
        },
      },
    );
  };

  return (
    <Card title="Customers">
      <div className="space-y-3">
        {agent.assignments.length === 0 ? (
          <p className="text-sm text-navy/70">No customers currently assigned.</p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {agent.assignments.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <Link
                    href={`/customers/${a.customer?.id}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {a.customer?.businessName ?? "—"}
                  </Link>
                  <p className="text-xs text-navy/70">Since {fmtCalendarDate(a.effectiveFrom)}</p>
                </div>
                {isOperator && a.customer && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={closeAssignment.isPending}
                    onClick={() => handleEnd(a.customer!.id, a.customer!.businessName)}
                  >
                    End
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {isOperator && (
          <Button size="sm" variant="secondary" onClick={() => setAssignOpen(true)}>
            Assign customers
          </Button>
        )}
      </div>

      <AssignCustomersModal
        agentId={agent.id}
        isOpen={assignOpen}
        onClose={() => setAssignOpen(false)}
      />
    </Card>
  );
}

// ─── Ledger card (full width) ────────────────────────────────────────────────

const LEDGER_LIMIT = 25;

function LedgerCard({ agentId }: { agentId: string }) {
  const { toast } = useToast();
  const [status, setStatus] = React.useState("");
  const [page, setPage] = React.useState(1);
  const { data, isLoading } = useAgentAccruals(agentId, {
    status: status || undefined,
    page,
    limit: LEDGER_LIMIT,
  });
  const recompute = useRecomputeAgent();
  const [recomputeFrom, setRecomputeFrom] = React.useState("");

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / LEDGER_LIMIT));

  const handleRecompute = () => {
    if (!recomputeFrom) return;
    recompute.mutate(
      { id: agentId, fromDate: recomputeFrom },
      {
        onSuccess: (result) =>
          toast({
            title: `Recomputed ${result.invoicesSynced} invoice(s)`,
            variant: "success",
          }),
      },
    );
  };

  return (
    <Card title="Commission Ledger">
      <div className="space-y-4">
        <div className="w-44">
          <Select
            options={ACCRUAL_STATUS_OPTIONS}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised text-left text-xs text-navy/70">
              <tr>
                <th className="px-3 py-2 font-medium">Invoice</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Basis date</th>
                <th className="px-3 py-2 text-right font-medium">Base</th>
                <th className="px-3 py-2 font-medium">Rate</th>
                <th className="px-3 py-2 text-right font-medium">Accrued</th>
                <th className="px-3 py-2 text-right font-medium">Payable</th>
                <th className="px-3 py-2 text-right font-medium">Claimed</th>
                <th className="px-3 py-2 text-right font-medium">Unclaimed</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border bg-white">
              {isLoading ? (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-navy/70">
                    Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-navy/70">
                    No accruals yet.
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2">
                      <Link
                        href={`/invoices/${row.invoice.id}`}
                        className="text-brand-700 hover:underline"
                      >
                        {row.invoice.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/customers/${row.customer.id}`} className="hover:underline">
                        {row.customer.businessName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-navy/70">{fmtCalendarDate(row.basisDate)}</td>
                    <td className="px-3 py-2 text-right">{fmt(Number(row.baseAmount))}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col">
                        <span>{pctLabel(row.ratePct)}</span>
                        <span className="text-[11px] text-navy/50">
                          {RATE_SOURCE_LABELS[row.rateSource]}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">{fmt(Number(row.accruedAmount))}</td>
                    <td className="px-3 py-2 text-right">{fmt(Number(row.payableAmount))}</td>
                    <td className="px-3 py-2 text-right">{fmt(Number(row.claimedAmount))}</td>
                    {/* `drift` is the API's own remainder — rendered verbatim, never
                        subtracted from the columns beside it. */}
                    <td className="px-3 py-2 text-right">{fmt(Number(row.drift))}</td>
                    <td className="px-3 py-2">
                      <Badge
                        variant={ACCRUAL_STATUS_VARIANT[row.status]}
                        label={accrualStatusLabel(row.status)}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {total > LEDGER_LIMIT && (
          <div className="flex items-center justify-between text-xs text-navy/70">
            <span>
              Page {page} of {totalPages} · {total} total
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Prev
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-surface-border pt-3">
          <label className="text-xs font-medium text-navy/70" htmlFor="recompute-from">
            Recompute from
          </label>
          <input
            id="recompute-from"
            type="date"
            value={recomputeFrom}
            onChange={(e) => setRecomputeFrom(e.target.value)}
            className="h-8 rounded border border-surface-border bg-white px-2 text-xs text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!recomputeFrom || recompute.isPending}
            onClick={handleRecompute}
          >
            {recompute.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "Recompute from date…"
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
}
