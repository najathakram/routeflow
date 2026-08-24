"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button, Badge, Card, StatCard, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useTenantAddons } from "@/lib/api/tobacco";
import { SALES_AGENTS_ADDON } from "@/lib/api/addons";
import { LockedPage } from "@/app/(dashboard)/_components/gates/PlanGates";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { apiClient } from "@/lib/api-client";
import {
  useCommissionStatement,
  useApproveStatement,
  useVoidStatement,
  type CommissionStatementDetail,
  type CommissionStatementLineKind,
} from "@/lib/api/sales-agents";
import { fmt, fmtCalendarDate, fmtDate } from "@/lib/formatting";
import { paymentMethodLabel } from "@/lib/payment-methods";
import { RecordPayoutModal } from "../_components/RecordPayoutModal";

const LINE_KIND_BADGE: Record<
  CommissionStatementLineKind,
  { variant: "success" | "warning" | "neutral"; label: string }
> = {
  CLAIM: { variant: "success", label: "Claim" },
  ADJUSTMENT: { variant: "warning", label: "Adjustment" },
  CARRYFORWARD: { variant: "neutral", label: "Carryforward" },
};

/**
 * PR-D WP6 — commission statement detail: the 409 contracts live here.
 * The addon gate + the `useCommissionStatement` loading/error states are
 * resolved in this outer component; the inner `StatementDetailBody` only
 * ever mounts once `statement` is guaranteed non-null, so its hooks
 * (notably the inline `regenerate` mutation, which closes over `statement`)
 * never need a non-null assertion.
 */
export default function CommissionStatementDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { data: addonsData, isLoading: addonsLoading } = useTenantAddons();
  const hasSalesAgents = addonsData?.addons?.includes(SALES_AGENTS_ADDON) ?? false;

  const {
    data: statement,
    isLoading,
    isError,
  } = useCommissionStatement(params.id, { enabled: hasSalesAgents });

  React.useEffect(() => {
    if (statement) setTitle(statement.statementNumber);
  }, [statement, setTitle]);

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (isError || !statement) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Statement not found.</p>
        <Button variant="secondary" href="/finance/commissions">
          Back to Commissions
        </Button>
      </div>
    );
  }

  return <StatementDetailBody statement={statement} />;
}

function StatementDetailBody({ statement }: { statement: CommissionStatementDetail }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();

  const approve = useApproveStatement();
  const voidStatement = useVoidStatement();

  const [isVoidOpen, setIsVoidOpen] = React.useState(false);
  const [isPayoutOpen, setIsPayoutOpen] = React.useState(false);
  const [staleGate, setStaleGate] = React.useState(false);

  const handleApprove = () => {
    setStaleGate(false);
    approve.mutate(statement.id, {
      onSuccess: () => toast({ title: "Statement approved", variant: "success" }),
      onError: (err) => {
        const res = (err as any)?.response;
        const msg: string = res?.data?.message ?? "";
        // Approve throws exactly two 409s: "Only a PENDING statement…" (state raced —
        // refetch covers it) and the stale contract. Match on "stale", not status alone.
        if (res?.status === 409 && msg.toLowerCase().includes("stale")) setStaleGate(true);
      },
    });
  };

  // One click: void the stale PENDING statement, regenerate with the same
  // period, navigate to the replacement. Both steps are the server's own
  // sanctioned path (void releases every claim/sweep atomically; generate
  // re-claims live drift), so a crash between them leaves a clean ledger —
  // the worst case is "voided but not regenerated", fixed by clicking
  // Generate on the list page.
  const regenerate = useMutation({
    mutationFn: async () => {
      await apiClient.post(`/commission-statements/${statement.id}/void`);
      const { data } = await apiClient.post("/commission-statements/generate", {
        agentId: statement.agentId,
        periodFrom: statement.periodFrom ?? undefined,
        periodTo: statement.periodTo ?? undefined,
      });
      return data;
    },
    onSuccess: (fresh) => {
      qc.invalidateQueries({ queryKey: ["commission-statements"] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
      toast({ title: `Regenerated as ${fresh.statementNumber}`, variant: "success" });
      router.replace(`/finance/commissions/${fresh.id}`);
    },
    onError: (err: any) => {
      // The regenerate's own 400 "Nothing to generate" — everything clawed
      // back to zero — surfaces via the global toast; the old statement is
      // now VOID either way, so land on the list rather than a void detail page.
      if (err?.response?.status === 400) router.replace("/finance/commissions");
    },
  });

  const total = Number(statement.totalAmount);
  const paid = Number(statement.paidAmount);
  const remaining = total - paid;

  return (
    <div className="space-y-5 p-6">
      <RecordPayoutModal
        open={isPayoutOpen}
        onClose={() => setIsPayoutOpen(false)}
        statement={statement}
      />

      <ConfirmDialog
        open={isVoidOpen}
        onClose={() => setIsVoidOpen(false)}
        onConfirm={() =>
          voidStatement.mutate(statement.id, {
            onSuccess: () => {
              setIsVoidOpen(false);
              toast({ title: "Statement voided", variant: "info" });
            },
          })
        }
        title="Void this statement?"
        description="Every claim on it is released back to the agent's payable ledger — nothing is paid."
        confirmLabel="Void"
        variant="danger"
        loading={voidStatement.isPending}
      />

      <Link
        href="/finance/commissions"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Commissions
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-bold text-navy">{statement.statementNumber}</h2>
          <Badge status={statement.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statement.status === "PENDING" && (
            <>
              <Button size="sm" loading={approve.isPending} onClick={handleApprove}>
                Approve
              </Button>
              <Button size="sm" variant="danger" onClick={() => setIsVoidOpen(true)}>
                Void
              </Button>
            </>
          )}
          {statement.status === "APPROVED" && total > 0 && remaining > 0 && (
            <Button size="sm" onClick={() => setIsPayoutOpen(true)}>
              Record payout
            </Button>
          )}
        </div>
      </div>

      {statement.status === "PENDING" && staleGate && (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          <p className="font-medium">This statement is stale.</p>
          <p className="mt-0.5">
            Commission moved after it was generated (a payment, clawback, or reassignment).
            Regenerating voids this statement and issues a fresh one with current amounts.
          </p>
          <Button
            size="sm"
            className="mt-2"
            onClick={() => regenerate.mutate()}
            disabled={regenerate.isPending}
          >
            {regenerate.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Void & regenerate"
            )}
          </Button>
        </div>
      )}

      {statement.status === "APPROVED" && total <= 0 && (
        <p className="text-sm italic text-navy/70">
          Negative statement — the balance carries into the next generation; payouts are blocked.
        </p>
      )}

      <p className="text-sm text-navy/70">
        Agent{" "}
        <Link
          href={`/sales-agents/${statement.agentId}`}
          className="font-medium text-brand-600 hover:underline"
        >
          {statement.agent.name}
        </Link>
        {" · "}
        {statement.periodFrom || statement.periodTo
          ? `${fmtCalendarDate(statement.periodFrom)} – ${fmtCalendarDate(statement.periodTo)}`
          : "Open period"}
        {statement.approvedAt && <> · Approved {fmtDate(statement.approvedAt)}</>}
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total" value={fmt(total)} />
        <StatCard label="Paid" value={fmt(paid)} />
        <StatCard label="Remaining" value={fmt(remaining)} />
      </div>

      {/* Lines */}
      <Card title="Lines">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-navy/70">Kind</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-navy/70">Reference</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-navy/70">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {statement.lines.map((line) => {
                const badge = LINE_KIND_BADGE[line.kind];
                const amount = Number(line.amount);
                return (
                  <tr key={line.id}>
                    <td className="px-3 py-2">
                      <Badge variant={badge.variant} label={badge.label} />
                    </td>
                    <td className="px-3 py-2 text-navy">
                      {line.kind === "CLAIM" && line.accrual ? (
                        <Link
                          href={`/invoices/${line.accrual.invoice.id}`}
                          className="font-mono text-xs text-brand-600 hover:underline"
                        >
                          {line.accrual.invoice.invoiceNumber}
                        </Link>
                      ) : line.kind === "ADJUSTMENT" && line.adjustment ? (
                        <span>
                          <span className="font-medium">{line.adjustment.kind}</span>
                          {(line.description || line.adjustment.reason) && (
                            <span className="text-navy/70">
                              {" "}
                              — {line.description || line.adjustment.reason}
                            </span>
                          )}
                        </span>
                      ) : line.kind === "CARRYFORWARD" && line.carriedFrom ? (
                        <Link
                          href={`/finance/commissions/${line.carriedFrom.id}`}
                          className="font-mono text-xs text-brand-600 hover:underline"
                        >
                          {line.carriedFrom.statementNumber}
                        </Link>
                      ) : (
                        <span className="text-navy/70">{line.description ?? "—"}</span>
                      )}
                    </td>
                    <td
                      className={`px-3 py-2 text-right ${amount < 0 ? "text-danger" : "text-navy"}`}
                    >
                      {fmt(amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Payouts */}
      <Card title="Payouts">
        {statement.payouts.length === 0 ? (
          <p className="text-sm text-navy/70">No payouts recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-surface-border">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-navy/70">Date</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-navy/70">Method</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-navy/70">
                    Reference
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-navy/70">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {statement.payouts.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2 text-navy/70">{fmtDate(p.paidAt)}</td>
                    <td className="px-3 py-2 text-navy">{paymentMethodLabel(p.method)}</td>
                    <td className="px-3 py-2 text-navy/70">{p.reference ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-navy">{fmt(Number(p.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
