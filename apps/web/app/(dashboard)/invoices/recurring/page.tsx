"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Loader2, Play, Pause, Zap } from "lucide-react";
import { Button, Card, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useRecurringInvoices,
  useDeactivateRecurringInvoice,
  useUpdateRecurringInvoice,
  useRunRecurringInvoice,
  type RecurringInvoice,
} from "@/lib/api/invoices";
import { useRouter } from "next/navigation";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d?: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function freqLabel(freq: string, dayOfWeek?: number | null, dayOfMonth?: number | null) {
  if (freq === "WEEKLY") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `Weekly — ${dayOfWeek != null ? days[dayOfWeek] : ""}`;
  }
  if (freq === "BIWEEKLY") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `Every 2 weeks — ${dayOfWeek != null ? days[dayOfWeek] : ""}`;
  }
  if (freq === "MONTHLY") {
    return `Monthly — day ${dayOfMonth ?? "?"}`;
  }
  return freq;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecurringInvoicesPage() {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const router = useRouter();

  React.useEffect(() => { setTitle("Recurring Invoices"); }, [setTitle]);

  const { data: recurringList, isLoading } = useRecurringInvoices();
  const deactivate = useDeactivateRecurringInvoice();
  const update = useUpdateRecurringInvoice();
  const runNow = useRunRecurringInvoice();

  const items: RecurringInvoice[] = recurringList ?? [];

  const handleToggleActive = (ri: RecurringInvoice) => {
    if (ri.isActive) {
      deactivate.mutate(ri.id, {
        onSuccess: () => toast({ title: "Template deactivated", variant: "info" }),
        onError: () => toast({ title: "Failed to deactivate template", variant: "error" }),
      });
    } else {
      update.mutate({ id: ri.id, isActive: true } as any, {
        onSuccess: () => toast({ title: "Template activated", variant: "success" }),
        onError: () => toast({ title: "Failed to activate template", variant: "error" }),
      });
    }
  };

  const handleRunNow = (ri: RecurringInvoice) => {
    runNow.mutate(ri.id, {
      onSuccess: (inv) => {
        toast({ title: "Invoice generated", description: `${(inv as any).invoiceNumber} created.`, variant: "success" });
        router.push(`/invoices/${(inv as any).id}`);
      },
      onError: () => toast({ title: "Failed to generate invoice", variant: "error" }),
    });
  };

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">Recurring Invoices</h1>
          <p className="mt-1 text-sm text-navy/60">Automatically generate invoices on a schedule.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" href="/invoices">All Invoices</Button>
          <Button leftIcon={<Plus className="h-4 w-4" />} href="/invoices/recurring/new">
            New Template
          </Button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-navy/40" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-4 py-12 text-center">
            <p className="text-base font-medium text-navy">No recurring invoice templates yet.</p>
            <p className="text-sm text-navy/50">Create a template to automatically generate invoices on a schedule.</p>
            <Button leftIcon={<Plus className="h-4 w-4" />} href="/invoices/recurring/new">
              Create First Template
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((ri) => (
            <Card key={ri.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-navy">
                      {ri.customer?.businessName ?? ri.customerId}
                    </p>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                        ri.isActive ? "bg-success-bg text-success" : "bg-surface-raised text-navy/40",
                      )}
                    >
                      {ri.isActive ? "Active" : "Paused"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-navy/60">
                    {freqLabel(ri.frequency, ri.dayOfWeek, ri.dayOfMonth)}
                  </p>
                  <p className="text-xs text-navy/50">
                    {ri.items.length} item{ri.items.length !== 1 ? "s" : ""}
                    {ri.autoSend ? " · Auto-send" : ""}
                  </p>
                </div>
              </div>

              <div className="mt-3 space-y-1 text-xs text-navy/50">
                <div className="flex justify-between">
                  <span>Next run</span>
                  <span className="font-medium text-navy">{fmtDate(ri.nextRunAt)}</span>
                </div>
                {ri.lastRunAt && (
                  <div className="flex justify-between">
                    <span>Last run</span>
                    <span>{fmtDate(ri.lastRunAt)}</span>
                  </div>
                )}
              </div>

              <div className="mt-4 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Zap className="h-3.5 w-3.5" />}
                  onClick={() => handleRunNow(ri)}
                  loading={runNow.isPending}
                  className="flex-1"
                >
                  Run Now
                </Button>
                <button
                  onClick={() => handleToggleActive(ri)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border text-navy/50 hover:bg-surface-raised hover:text-navy transition-colors"
                  title={ri.isActive ? "Pause" : "Activate"}
                >
                  {ri.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
