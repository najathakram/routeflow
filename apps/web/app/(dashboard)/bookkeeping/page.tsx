"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import {
  DollarSign,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Download,
  Eye,
} from "lucide-react";
import { PageHeader, StatCard, Table, Badge, Button, Select, cn } from "@routeflow/ui/web";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useBookkeepingSummary, useTransactions, type Transaction } from "@/lib/api/bookkeeping";

// ─── Payment status badge ─────────────────────────────────────────────────────

type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID";

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  if (status === "PAID") return <Badge variant="success" label="Paid" />;
  if (status === "PARTIAL") return <Badge variant="warning" label="Partial" />;
  return <Badge variant="neutral" label="Unpaid" />;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookkeepingPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  React.useEffect(() => { setTitle("Bookkeeping"); }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [customerSearch, setCustomerSearch] = React.useState("");

  const { data: summaryData } = useBookkeepingSummary();
  const { data: txnData, isLoading: txnLoading } = useTransactions({
    status: statusFilter || undefined,
  });

  const transactions = txnData?.data ?? [];

  const filtered = React.useMemo(() => {
    const q = customerSearch.toLowerCase();
    return transactions.filter((t) => {
      if (q && !t.customer?.businessName?.toLowerCase().includes(q) && !t.order?.orderNumber?.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [transactions, customerSearch]);

  const columns = React.useMemo<ColumnDef<Transaction, unknown>[]>(
    () => [
      {
        accessorKey: "order",
        header: "Invoice #",
        cell: ({ row }) => (
          <span className="font-mono text-xs font-semibold text-navy">
            {row.original.order?.orderNumber ?? row.original.id}
          </span>
        ),
      },
      {
        id: "customer",
        header: "Customer",
        cell: ({ row }) => (
          <span className="font-medium text-navy">{row.original.customer?.businessName ?? "—"}</span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Date",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-navy/60">
            {new Date(row.original.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </span>
        ),
      },
      {
        id: "total",
        header: "Total",
        cell: ({ row }) => (
          <span className="font-medium text-navy">
            ${Number(row.original.totalOwed).toFixed(2)}
          </span>
        ),
      },
      {
        id: "paid",
        header: "Paid",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-success font-medium">
            ${Number(row.original.totalPaid).toFixed(2)}
          </span>
        ),
      },
      {
        id: "balance",
        header: "Balance",
        enableSorting: false,
        cell: ({ row }) => {
          const bal = Number(row.original.totalOwed) - Number(row.original.totalPaid);
          return (
            <span className={cn("font-medium", bal > 0 ? "text-danger" : "text-navy/40")}>
              ${bal.toFixed(2)}
            </span>
          );
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => <PaymentStatusBadge status={row.original.status} />,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
            <button
              title="View invoice"
              onClick={() => router.push(`/bookkeeping/${row.original.id}`)}
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

  const handleExport = () => {
    toast({
      title: "Export started",
      description: "Your CSV will be ready shortly.",
      variant: "info",
    });
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Bookkeeping"
        action={
          <Button
            variant="secondary"
            leftIcon={<Download className="h-4 w-4" />}
            onClick={handleExport}
          >
            Export CSV
          </Button>
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Revenue (Month)"
          value={summaryData ? `$${summaryData.totalRevenue.toFixed(0)}` : "—"}
          icon={<DollarSign className="h-5 w-5" />}
        />
        <StatCard
          label="Outstanding"
          value={summaryData ? `$${summaryData.outstandingReceivables.toFixed(0)}` : "—"}
          icon={<Clock className={cn("h-5 w-5", summaryData && summaryData.outstandingReceivables > 0 && "text-warning")} />}
          className={summaryData && summaryData.outstandingReceivables > 0 ? "ring-1 ring-inset ring-warning/20" : ""}
        />
        <StatCard
          label="Received (Week)"
          value={summaryData ? `$${summaryData.paymentsThisWeek.toFixed(0)}` : "—"}
          icon={<CheckCircle2 className="h-5 w-5 text-success" />}
        />
        <StatCard
          label="Overdue Accounts"
          value={summaryData ? summaryData.overdueCount : "—"}
          icon={<AlertTriangle className={cn("h-5 w-5", summaryData && summaryData.overdueCount > 0 && "text-danger")} />}
          className={summaryData && summaryData.overdueCount > 0 ? "ring-1 ring-inset ring-danger/20" : ""}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by customer or invoice #…"
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-40">
          <Select
            options={[
              { value: "", label: "All Statuses" },
              { value: "UNPAID", label: "Unpaid" },
              { value: "PARTIAL", label: "Partial" },
              { value: "PAID", label: "Paid" },
            ]}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
      </div>

      {/* Transactions table */}
      <Table
        data={filtered}
        columns={columns}
        isLoading={txnLoading}
        onRowClick={(row) => router.push(`/bookkeeping/${row.original.id}`)}
        emptyState="No transactions match your filters."
      />
    </div>
  );
}
