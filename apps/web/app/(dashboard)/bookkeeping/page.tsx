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
import {
  transactions,
  grandTotal,
  amountPaid,
  balance,
  getBookkeepingKPIs,
  type Transaction,
  type PaymentStatus,
} from "@/mocks/bookkeeping";

// ─── Payment status badge ─────────────────────────────────────────────────────

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  if (status === "PAID") return <Badge variant="success" label="Paid" />;
  if (status === "PARTIAL") return <Badge variant="warning" label="Partial" />;
  if (status === "OVERDUE") return <Badge variant="danger" label="Overdue" />;
  return <Badge variant="neutral" label="Unpaid" />;
}

// ─── Date filter options ──────────────────────────────────────────────────────

const DATE_OPTIONS = [
  { value: "", label: "All Time" },
  { value: "mar", label: "March 2026" },
  { value: "feb", label: "February 2026" },
  { value: "jan", label: "January 2026" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookkeepingPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  React.useEffect(() => { setTitle("Bookkeeping"); }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [dateFilter, setDateFilter] = React.useState("");
  const [customerSearch, setCustomerSearch] = React.useState("");

  const kpis = React.useMemo(() => getBookkeepingKPIs(), []);

  const filtered = React.useMemo(() => {
    const q = customerSearch.toLowerCase();
    return transactions.filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (dateFilter && !t.date.toLowerCase().startsWith(dateFilter === "mar" ? "mar" : dateFilter === "feb" ? "feb" : "jan")) return false;
      if (q && !t.customerName.toLowerCase().includes(q) && !t.transactionNumber.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [statusFilter, dateFilter, customerSearch]);

  const columns = React.useMemo<ColumnDef<Transaction, unknown>[]>(
    () => [
      {
        accessorKey: "transactionNumber",
        header: "Invoice #",
        cell: ({ row }) => (
          <span className="font-mono text-xs font-semibold text-navy">
            {row.original.transactionNumber}
          </span>
        ),
      },
      {
        accessorKey: "customerName",
        header: "Customer",
        cell: ({ row }) => (
          <span className="font-medium text-navy">{row.original.customerName}</span>
        ),
      },
      {
        accessorKey: "date",
        header: "Date",
        enableSorting: false,
        cell: ({ row }) => <span className="text-navy/60">{row.original.date}</span>,
      },
      {
        id: "total",
        header: "Total",
        cell: ({ row }) => (
          <span className="font-medium text-navy">
            ${grandTotal(row.original).toFixed(2)}
          </span>
        ),
      },
      {
        id: "paid",
        header: "Paid",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-success font-medium">
            ${amountPaid(row.original).toFixed(2)}
          </span>
        ),
      },
      {
        id: "balance",
        header: "Balance",
        enableSorting: false,
        cell: ({ row }) => {
          const bal = balance(row.original);
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
          value={`$${kpis.monthRevenue.toFixed(0)}`}
          icon={<DollarSign className="h-5 w-5" />}
        />
        <StatCard
          label="Outstanding"
          value={`$${kpis.outstanding.toFixed(0)}`}
          icon={<Clock className={cn("h-5 w-5", kpis.outstanding > 0 && "text-warning")} />}
          className={kpis.outstanding > 0 ? "ring-1 ring-inset ring-warning/20" : ""}
        />
        <StatCard
          label="Received (Week)"
          value={`$${kpis.weekPayments.toFixed(0)}`}
          icon={<CheckCircle2 className="h-5 w-5 text-success" />}
        />
        <StatCard
          label="Overdue Accounts"
          value={kpis.overdueCount}
          icon={<AlertTriangle className={cn("h-5 w-5", kpis.overdueCount > 0 && "text-danger")} />}
          className={kpis.overdueCount > 0 ? "ring-1 ring-inset ring-danger/20" : ""}
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
              { value: "OVERDUE", label: "Overdue" },
            ]}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
        <div className="w-40">
          <Select
            options={DATE_OPTIONS}
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
          />
        </div>
      </div>

      {/* Transactions table */}
      <Table
        data={filtered}
        columns={columns}
        onRowClick={(row) => router.push(`/bookkeeping/${row.original.id}`)}
        emptyState="No transactions match your filters."
      />
    </div>
  );
}
