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
  Calendar,
  X,
  Plus,
  Pencil,
  Trash2,
  TrendingUp,
  TrendingDown,
  RefreshCw,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PageHeader,
  StatCard,
  Table,
  Badge,
  Button,
  Select,
  Modal,
  Input,
  Textarea,
  cn,
} from "@routeflow/ui/web";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useBookkeepingSummary,
  useTransactions,
  type Transaction,
} from "@/lib/api/bookkeeping";
import { apiClient } from "@/lib/api-client";

// ─── Money formatter ──────────────────────────────────────────────────────────

const usd = (x: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(x);

// ─── Types ────────────────────────────────────────────────────────────────────

type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID";
type PaymentMethod = "CASH" | "CHECK" | "ACH" | "CARD" | "OTHER";

interface ExpenseCategory {
  id: string;
  name: string;
  code: string;
}

interface Supplier {
  id: string;
  name: string;
}

interface Expense {
  id: string;
  categoryId: string;
  category?: { id: string; name: string; code: string };
  supplierId?: string;
  supplier?: { id: string; name: string };
  amount: number;
  date: string;
  description: string;
  paymentMethod: PaymentMethod;
  notes?: string;
  createdAt: string;
}

interface PLReport {
  revenue: number;
  cogs: number;
  grossProfit: number;
  operatingExpenses: number;
  netProfit: number;
  netMarginPct: number;
  expensesByCategory: Array<{ name: string; amount: number }>;
  period: { from: string; to: string };
}

interface AgingBucket {
  id?: string;
  customerId?: string;
  customerName?: string;
  customer?: { id: string; businessName: string };
  amount: number;
  dueDate?: string;
}

interface AgingReport {
  buckets: {
    current: AgingBucket[];
    days1_30: AgingBucket[];
    days31_60: AgingBucket[];
    days61_90: AgingBucket[];
    days90plus: AgingBucket[];
  };
  totals: {
    current: number;
    days1_30: number;
    days31_60: number;
    days61_90: number;
    days90plus: number;
    total: number;
    grand?: number;
  };
}

interface CashFlowReport {
  totalIn: number;
  totalOut: number;
  netCashFlow: number;
  period: { from: string; to: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function currentYearRange() {
  const now = new Date();
  return {
    from: `${now.getFullYear()}-01-01`,
    to: `${now.getFullYear()}-12-31`,
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Payment status badge ─────────────────────────────────────────────────────

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  if (status === "PAID") return <Badge variant="success" label="Paid" />;
  if (status === "PARTIAL") return <Badge variant="warning" label="Partial" />;
  return <Badge variant="neutral" label="Unpaid" />;
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded bg-surface-raised", className)} />
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = "transactions" | "expenses" | "reports";

// ─── API hooks ────────────────────────────────────────────────────────────────

function useExpenseCategories() {
  return useQuery<ExpenseCategory[]>({
    queryKey: ["bookkeeping", "expense-categories"],
    queryFn: () =>
      apiClient.get("/bookkeeping/expense-categories").then((r) => r.data),
  });
}

function useSuppliers() {
  return useQuery<Supplier[]>({
    queryKey: ["inventory", "suppliers"],
    queryFn: () =>
      apiClient.get("/inventory/suppliers").then((r) => r.data),
  });
}

function useExpenses(params: {
  categoryId?: string;
  supplierId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: Expense[]; meta: { total: number; page: number; limit: number; totalPages: number } }>({
    queryKey: ["bookkeeping", "expenses", params],
    queryFn: () =>
      apiClient.get("/bookkeeping/expenses", { params }).then((r) => r.data),
  });
}

function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation<Expense, Error, Omit<Expense, "id" | "category" | "supplier" | "createdAt">>({
    mutationFn: (data) =>
      apiClient.post("/bookkeeping/expenses", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookkeeping", "expenses"] });
    },
  });
}

function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation<Expense, Error, { id: string } & Partial<Omit<Expense, "id" | "category" | "supplier" | "createdAt">>>({
    mutationFn: ({ id, ...data }) =>
      apiClient.patch(`/bookkeeping/expenses/${id}`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookkeeping", "expenses"] });
    },
  });
}

function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      apiClient.post(`/bookkeeping/expenses/${id}/delete`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookkeeping", "expenses"] });
    },
  });
}

function usePLReport(params: { from: string; to: string }, enabled: boolean) {
  return useQuery<PLReport>({
    queryKey: ["bookkeeping", "reports", "pl", params],
    queryFn: () =>
      apiClient.get("/bookkeeping/reports/pl", { params }).then((r) => r.data),
    enabled,
  });
}

function useAgingReport(enabled: boolean) {
  return useQuery<AgingReport>({
    queryKey: ["bookkeeping", "reports", "aging"],
    queryFn: () =>
      apiClient.get("/bookkeeping/reports/aging").then((r) => r.data),
    enabled,
  });
}

function useCashFlowReport(params: { from: string; to: string }, enabled: boolean) {
  return useQuery<CashFlowReport>({
    queryKey: ["bookkeeping", "reports", "cashflow", params],
    queryFn: () =>
      apiClient.get("/bookkeeping/reports/cashflow", { params }).then((r) => r.data),
    enabled,
  });
}

// ─── Expense Form Modal ───────────────────────────────────────────────────────

interface ExpenseFormState {
  categoryId: string;
  supplierId: string;
  amount: string;
  date: string;
  description: string;
  paymentMethod: PaymentMethod;
  notes: string;
}

const EMPTY_EXPENSE_FORM: ExpenseFormState = {
  categoryId: "",
  supplierId: "",
  amount: "",
  date: today(),
  description: "",
  paymentMethod: "CASH",
  notes: "",
};

interface ExpenseModalProps {
  open: boolean;
  onClose: () => void;
  editing?: Expense | null;
  categories: ExpenseCategory[];
  suppliers: Supplier[];
}

function ExpenseModal({ open, onClose, editing, categories, suppliers }: ExpenseModalProps) {
  const { toast } = useToast();
  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense();

  const [form, setForm] = React.useState<ExpenseFormState>(EMPTY_EXPENSE_FORM);

  React.useEffect(() => {
    if (editing) {
      setForm({
        categoryId: editing.categoryId,
        supplierId: editing.supplierId ?? "",
        amount: String(editing.amount),
        date: editing.date.slice(0, 10),
        description: editing.description,
        paymentMethod: editing.paymentMethod,
        notes: editing.notes ?? "",
      });
    } else {
      setForm(EMPTY_EXPENSE_FORM);
    }
  }, [editing, open]);

  const field = (key: keyof ExpenseFormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const isLoading = createExpense.isPending || updateExpense.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.categoryId || !form.amount || !form.date || !form.description) {
      toast({ title: "Validation", description: "Category, amount, date and description are required.", variant: "warning" });
      return;
    }
    const payload = {
      categoryId: form.categoryId,
      supplierId: form.supplierId || undefined,
      amount: parseFloat(form.amount),
      date: form.date,
      description: form.description,
      paymentMethod: form.paymentMethod,
      notes: form.notes || undefined,
    };
    try {
      if (editing) {
        await updateExpense.mutateAsync({ id: editing.id, ...payload });
        toast({ title: "Expense updated", variant: "success" });
      } else {
        await createExpense.mutateAsync(payload as Omit<Expense, "id" | "category" | "supplier" | "createdAt">);
        toast({ title: "Expense recorded", variant: "success" });
      }
      onClose();
    } catch {
      toast({ title: "Error", description: "Failed to save expense.", variant: "error" });
    }
  };

  const categoryOptions = [
    { value: "", label: "Select category…" },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];
  const supplierOptions = [
    { value: "", label: "No supplier" },
    ...suppliers.map((s) => ({ value: s.id, label: s.name })),
  ];
  const methodOptions: Array<{ value: string; label: string }> = [
    { value: "CASH", label: "Cash" },
    { value: "CHECK", label: "Check" },
    { value: "ACH", label: "ACH" },
    { value: "CARD", label: "Card" },
    { value: "OTHER", label: "Other" },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit Expense" : "Record Expense"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={isLoading}>
            {editing ? "Save Changes" : "Record Expense"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select
          label="Category"
          options={categoryOptions}
          value={form.categoryId}
          onChange={field("categoryId")}
        />
        <Select
          label="Supplier"
          options={supplierOptions}
          value={form.supplierId}
          onChange={field("supplierId")}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Amount"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={form.amount}
            onChange={field("amount")}
          />
          <Input
            label="Date"
            type="date"
            value={form.date}
            onChange={field("date")}
          />
        </div>
        <Input
          label="Description"
          placeholder="e.g. Office supplies"
          value={form.description}
          onChange={field("description")}
        />
        <Select
          label="Payment Method"
          options={methodOptions}
          value={form.paymentMethod}
          onChange={field("paymentMethod")}
        />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-navy">Notes</label>
          <Textarea
            placeholder="Optional notes…"
            value={form.notes}
            onChange={field("notes")}
            rows={3}
          />
        </div>
      </form>
    </Modal>
  );
}

// ─── Expenses Tab ─────────────────────────────────────────────────────────────

function ExpensesTab() {
  const { toast } = useToast();
  const { data: categories = [] } = useExpenseCategories();
  const { data: suppliers = [] } = useSuppliers();

  const [filterCategory, setFilterCategory] = React.useState("");
  const [filterSupplier, setFilterSupplier] = React.useState("");
  const [filterFrom, setFilterFrom] = React.useState("");
  const [filterTo, setFilterTo] = React.useState("");

  const { data: expensesData, isLoading } = useExpenses({
    categoryId: filterCategory || undefined,
    supplierId: filterSupplier || undefined,
    from: filterFrom || undefined,
    to: filterTo || undefined,
    page: 1,
    limit: 50,
  });

  const deleteExpense = useDeleteExpense();

  const [modalOpen, setModalOpen] = React.useState(false);
  const [editingExpense, setEditingExpense] = React.useState<Expense | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState<string | null>(null);

  const expenses = expensesData?.data ?? [];

  const categoryTotals = React.useMemo(() => {
    const map = new Map<string, { name: string; total: number }>();
    for (const e of expenses) {
      const name = e.category?.name ?? "Uncategorized";
      const entry = map.get(e.categoryId) ?? { name, total: 0 };
      entry.total += Number(e.amount);
      map.set(e.categoryId, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [expenses]);

  const handleDelete = async (id: string) => {
    try {
      await deleteExpense.mutateAsync(id);
      toast({ title: "Expense deleted", variant: "success" });
    } catch {
      toast({ title: "Error", description: "Failed to delete expense.", variant: "error" });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const clearFilters = () => {
    setFilterCategory("");
    setFilterSupplier("");
    setFilterFrom("");
    setFilterTo("");
  };
  const hasFilters = filterCategory || filterSupplier || filterFrom || filterTo;

  const columns = React.useMemo<ColumnDef<Expense, unknown>[]>(
    () => [
      {
        accessorKey: "date",
        header: "Date",
        cell: ({ row }) => (
          <span className="text-navy/60 text-sm">
            {new Date(row.original.date).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        ),
      },
      {
        id: "category",
        header: "Category",
        cell: ({ row }) => (
          <span className="font-medium text-navy text-sm">
            {row.original.category?.name ?? row.original.categoryId}
          </span>
        ),
      },
      {
        id: "supplier",
        header: "Supplier",
        cell: ({ row }) => (
          <span className="text-navy/70 text-sm">
            {row.original.supplier?.name ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="text-navy text-sm">{row.original.description}</span>
        ),
      },
      {
        accessorKey: "amount",
        header: "Amount",
        cell: ({ row }) => (
          <span className="font-semibold text-navy text-sm">
            {usd(Number(row.original.amount))}
          </span>
        ),
      },
      {
        accessorKey: "paymentMethod",
        header: "Payment Method",
        cell: ({ row }) => (
          <span className="text-navy/60 text-sm capitalize">
            {row.original.paymentMethod.toLowerCase()}
          </span>
        ),
      },
      {
        accessorKey: "notes",
        header: "Notes",
        cell: ({ row }) => (
          <span className="text-navy/50 text-xs line-clamp-1">
            {row.original.notes ?? "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              title="Edit"
              onClick={() => {
                setEditingExpense(row.original);
                setModalOpen(true);
              }}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              title="Delete"
              onClick={() => setDeleteConfirm(row.original.id)}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-danger transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-navy">Expenses</h2>
        <Button
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => {
            setEditingExpense(null);
            setModalOpen(true);
          }}
        >
          Record Expense
        </Button>
      </div>

      {/* Category chips */}
      {categoryTotals.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {categoryTotals.map((ct) => (
            <div
              key={ct.name}
              className="inline-flex items-center gap-1.5 rounded-full border border-surface-border bg-white px-3 py-1 text-xs font-medium text-navy shadow-sm"
            >
              <span>{ct.name}</span>
              <span className="text-navy/50">{usd(ct.total)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-44">
          <Select
            options={[
              { value: "", label: "All Categories" },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ]}
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
          />
        </div>
        <div className="w-44">
          <Select
            options={[
              { value: "", label: "All Suppliers" },
              ...suppliers.map((s) => ({ value: s.id, label: s.name })),
            ]}
            value={filterSupplier}
            onChange={(e) => setFilterSupplier(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/40" />
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="From date"
          />
          <span className="text-navy/40">–</span>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            min={filterFrom || undefined}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="To date"
          />
        </div>
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-navy/50 hover:text-danger transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <Table
        data={expenses}
        columns={columns}
        isLoading={isLoading}
        emptyState="No expenses match your filters."
      />

      {/* Expense modal */}
      <ExpenseModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingExpense(null);
        }}
        editing={editingExpense}
        categories={categories}
        suppliers={suppliers}
      />

      {/* Delete confirmation modal */}
      <Modal
        open={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        title="Delete Expense"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
              loading={deleteExpense.isPending}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          Are you sure you want to delete this expense? This action cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

// ─── Reports Tab ──────────────────────────────────────────────────────────────

function ReportsTab() {
  const { toast } = useToast();

  // P&L state
  const [plRange, setPlRange] = React.useState(currentYearRange());
  const [plEnabled, setPlEnabled] = React.useState(false);
  const { data: plData, isFetching: plLoading, refetch: refetchPL } = usePLReport(plRange, plEnabled);

  // Aging state
  const [agingEnabled, setAgingEnabled] = React.useState(false);
  const { data: agingData, isFetching: agingLoading, refetch: refetchAging } = useAgingReport(agingEnabled);

  // Cash flow state
  const [cfRange, setCfRange] = React.useState(currentYearRange());
  const [cfEnabled, setCfEnabled] = React.useState(false);
  const { data: cfData, isFetching: cfLoading, refetch: refetchCF } = useCashFlowReport(cfRange, cfEnabled);

  const generatePL = () => {
    if (!plRange.from || !plRange.to) {
      toast({ title: "Select date range", variant: "warning" });
      return;
    }
    if (plEnabled) {
      refetchPL();
    } else {
      setPlEnabled(true);
    }
  };

  const generateCF = () => {
    if (!cfRange.from || !cfRange.to) {
      toast({ title: "Select date range", variant: "warning" });
      return;
    }
    if (cfEnabled) {
      refetchCF();
    } else {
      setCfEnabled(true);
    }
  };

  const refreshAging = () => {
    if (agingEnabled) {
      refetchAging();
    } else {
      setAgingEnabled(true);
    }
  };

  return (
    <div className="space-y-8">
      {/* ── 1. Profit & Loss ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-surface-border bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-navy">Profit &amp; Loss</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4 text-navy/40" />
              <input
                type="date"
                value={plRange.from}
                onChange={(e) => setPlRange((r) => ({ ...r, from: e.target.value }))}
                className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <span className="text-navy/40">–</span>
              <input
                type="date"
                value={plRange.to}
                onChange={(e) => setPlRange((r) => ({ ...r, to: e.target.value }))}
                min={plRange.from || undefined}
                className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <Button
              variant="secondary"
              onClick={generatePL}
              loading={plLoading}
              leftIcon={<TrendingUp className="h-4 w-4" />}
            >
              Generate
            </Button>
          </div>
        </div>

        {plLoading && (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        )}

        {!plLoading && plData && (
          <div className="space-y-3">
            <PLRow label="Revenue" value={plData.revenue} />
            <PLRow label="Cost of Goods Sold" value={-plData.cogs} negate />
            <div className="border-t border-surface-border pt-2">
              <PLRow label="Gross Profit" value={plData.grossProfit} bold />
            </div>
            {plData.expensesByCategory.length > 0 && (
              <div className="pl-4 space-y-1">
                <p className="text-xs font-medium text-navy/50 uppercase tracking-wide mb-1">
                  Operating Expenses
                </p>
                {plData.expensesByCategory.map((ec) => (
                  <PLRow key={ec.name} label={ec.name} value={-ec.amount} negate className="text-sm" />
                ))}
              </div>
            )}
            <PLRow label="Total Operating Expenses" value={-plData.operatingExpenses} negate />
            <div className="border-t border-surface-border pt-2">
              <PLRow label="Net Profit" value={plData.netProfit} bold big />
            </div>
            <div className="flex items-center justify-between rounded-lg px-3 py-2 bg-surface-raised">
              <span className="text-sm text-navy/60">Net Margin</span>
              <span
                className={cn(
                  "font-semibold text-sm",
                  plData.netMarginPct >= 0 ? "text-success" : "text-danger",
                )}
              >
                {plData.netMarginPct.toFixed(1)}%
              </span>
            </div>
          </div>
        )}

        {!plLoading && !plData && (
          <p className="text-sm text-navy/40 text-center py-8">
            Select a date range and click Generate.
          </p>
        )}
      </section>

      {/* ── 2. AR Aging ───────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-surface-border bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-navy">AR Aging Report</h2>
          <Button
            variant="secondary"
            onClick={refreshAging}
            loading={agingLoading}
            leftIcon={<RefreshCw className="h-4 w-4" />}
          >
            Refresh
          </Button>
        </div>

        {agingLoading && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {!agingLoading && agingData && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border">
                  {["Current", "1–30 Days", "31–60 Days", "61–90 Days", "90+ Days"].map((h) => (
                    <th key={h} className="pb-2 pr-4 text-left text-xs font-medium text-navy/50 uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Max rows across all buckets */}
                {Array.from({
                  length: Math.max(
                    agingData.buckets.current.length,
                    agingData.buckets.days1_30.length,
                    agingData.buckets.days31_60.length,
                    agingData.buckets.days61_90.length,
                    agingData.buckets.days90plus.length,
                  ),
                }).map((_, i) => (
                  <tr key={i} className="border-b border-surface-border/50">
                    {[
                      agingData.buckets.current[i],
                      agingData.buckets.days1_30[i],
                      agingData.buckets.days31_60[i],
                      agingData.buckets.days61_90[i],
                      agingData.buckets.days90plus[i],
                    ].map((bucket, bi) => (
                      <td key={bi} className="py-2 pr-4 text-navy/80">
                        {bucket ? (
                          <div>
                            <div className="font-medium text-xs">{bucket.customer?.businessName ?? bucket.customerName ?? "—"}</div>
                            <div className="text-navy/50">{usd(Number(bucket.amount))}</div>
                          </div>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
                {/* Bucket totals */}
                <tr className="border-t-2 border-surface-border font-semibold">
                  {[
                    agingData.totals.current,
                    agingData.totals.days1_30,
                    agingData.totals.days31_60,
                    agingData.totals.days61_90,
                    agingData.totals.days90plus,
                  ].map((total, i) => (
                    <td key={i} className="pt-2 pr-4 text-navy text-sm">
                      {usd(Number(total))}
                    </td>
                  ))}
                </tr>
                {/* Grand total */}
                <tr>
                  <td colSpan={5} className="pt-2 text-right">
                    <span className="text-xs text-navy/50 mr-2">Grand Total</span>
                    <span className="font-bold text-navy">{usd(Number(agingData.totals.total ?? agingData.totals.grand ?? 0))}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {!agingLoading && !agingData && (
          <p className="text-sm text-navy/40 text-center py-8">
            Click Refresh to load the aging report.
          </p>
        )}
      </section>

      {/* ── 3. Cash Flow ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-surface-border bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-navy">Cash Flow</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4 text-navy/40" />
              <input
                type="date"
                value={cfRange.from}
                onChange={(e) => setCfRange((r) => ({ ...r, from: e.target.value }))}
                className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <span className="text-navy/40">–</span>
              <input
                type="date"
                value={cfRange.to}
                onChange={(e) => setCfRange((r) => ({ ...r, to: e.target.value }))}
                min={cfRange.from || undefined}
                className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <Button
              variant="secondary"
              onClick={generateCF}
              loading={cfLoading}
              leftIcon={<TrendingUp className="h-4 w-4" />}
            >
              Generate
            </Button>
          </div>
        </div>

        {cfLoading && (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        )}

        {!cfLoading && cfData && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <CashFlowCard label="Cash In" value={cfData.totalIn} positive />
            <CashFlowCard label="Cash Out" value={cfData.totalOut} positive={false} />
            <CashFlowCard
              label="Net Cash Flow"
              value={cfData.netCashFlow}
              positive={cfData.netCashFlow >= 0}
              bold
            />
          </div>
        )}

        {!cfLoading && !cfData && (
          <p className="text-sm text-navy/40 text-center py-8">
            Select a date range and click Generate.
          </p>
        )}
      </section>
    </div>
  );
}

// ─── P&L Row ─────────────────────────────────────────────────────────────────

function PLRow({
  label,
  value,
  negate = false,
  bold = false,
  big = false,
  className,
}: {
  label: string;
  value: number;
  negate?: boolean;
  bold?: boolean;
  big?: boolean;
  className?: string;
}) {
  const display = negate ? -value : value;
  const color = display >= 0 ? "text-success" : "text-danger";
  return (
    <div className={cn("flex items-center justify-between py-1 px-2", className)}>
      <span className={cn("text-navy/70", bold && "font-semibold text-navy", big && "text-base")}>{label}</span>
      <span className={cn("font-medium tabular-nums", color, bold && "font-semibold", big && "text-base font-bold")}>
        {usd(Math.abs(value))}
        {value < 0 && !negate && <span className="ml-0.5 text-xs">(loss)</span>}
      </span>
    </div>
  );
}

// ─── Cash Flow Card ───────────────────────────────────────────────────────────

function CashFlowCard({
  label,
  value,
  positive,
  bold = false,
}: {
  label: string;
  value: number;
  positive: boolean;
  bold?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        positive
          ? "border-success/20 bg-success/5"
          : "border-danger/20 bg-danger/5",
        bold && "ring-1 ring-inset",
        bold && positive ? "ring-success/30" : bold ? "ring-danger/30" : "",
      )}
    >
      <p className="text-xs font-medium text-navy/50 uppercase tracking-wide mb-1">{label}</p>
      <div className="flex items-center gap-2">
        {positive ? (
          <TrendingUp className="h-4 w-4 text-success" />
        ) : (
          <TrendingDown className="h-4 w-4 text-danger" />
        )}
        <span
          className={cn(
            "tabular-nums",
            bold ? "text-xl font-bold" : "text-lg font-semibold",
            positive ? "text-success" : "text-danger",
          )}
        >
          {usd(Math.abs(value))}
        </span>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookkeepingPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  React.useEffect(() => {
    setTitle("Bookkeeping");
  }, [setTitle]);

  const [activeTab, setActiveTab] = React.useState<Tab>("transactions");

  // Transactions state
  const [statusFilter, setStatusFilter] = React.useState("");
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");

  const { data: summaryData } = useBookkeepingSummary();
  const { data: txnData, isLoading: txnLoading } = useTransactions({
    status: statusFilter || undefined,
  });

  const transactions = txnData?.data ?? [];

  const filtered = React.useMemo(() => {
    const q = customerSearch.toLowerCase();
    const fromMs = dateFrom ? new Date(dateFrom).setHours(0, 0, 0, 0) : null;
    const toMs = dateTo ? new Date(dateTo).setHours(23, 59, 59, 999) : null;
    return transactions.filter((t) => {
      if (
        q &&
        !t.customer?.businessName?.toLowerCase().includes(q) &&
        !t.order?.orderNumber?.toLowerCase().includes(q)
      )
        return false;
      if (fromMs !== null && new Date(t.createdAt).getTime() < fromMs) return false;
      if (toMs !== null && new Date(t.createdAt).getTime() > toMs) return false;
      return true;
    });
  }, [transactions, customerSearch, dateFrom, dateTo]);

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
          <span className="font-medium text-navy">
            {row.original.customer?.businessName ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Date",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-navy/60">
            {new Date(row.original.createdAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
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
          const bal =
            Number(row.original.totalOwed) - Number(row.original.totalPaid);
          return (
            <span
              className={cn(
                "font-medium",
                bal > 0 ? "text-danger" : "text-navy/40",
              )}
            >
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
          <div
            className="flex items-center"
            onClick={(e) => e.stopPropagation()}
          >
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

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "transactions", label: "Transactions" },
    { id: "expenses", label: "Expenses" },
    { id: "reports", label: "Reports" },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Bookkeeping"
        action={
          activeTab === "transactions" ? (
            <Button
              variant="secondary"
              leftIcon={<Download className="h-4 w-4" />}
              onClick={handleExport}
            >
              Export CSV
            </Button>
          ) : undefined
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
          value={
            summaryData
              ? `$${summaryData.outstandingReceivables.toFixed(0)}`
              : "—"
          }
          icon={
            <Clock
              className={cn(
                "h-5 w-5",
                summaryData &&
                  summaryData.outstandingReceivables > 0 &&
                  "text-warning",
              )}
            />
          }
          className={
            summaryData && summaryData.outstandingReceivables > 0
              ? "ring-1 ring-inset ring-warning/20"
              : ""
          }
        />
        <StatCard
          label="Received (Week)"
          value={
            summaryData ? `$${summaryData.paymentsThisWeek.toFixed(0)}` : "—"
          }
          icon={<CheckCircle2 className="h-5 w-5 text-success" />}
        />
        <StatCard
          label="Overdue Accounts"
          value={summaryData ? summaryData.overdueCount : "—"}
          icon={
            <AlertTriangle
              className={cn(
                "h-5 w-5",
                summaryData && summaryData.overdueCount > 0 && "text-danger",
              )}
            />
          }
          className={
            summaryData && summaryData.overdueCount > 0
              ? "ring-1 ring-inset ring-danger/20"
              : ""
          }
        />
      </div>

      {/* Tab bar */}
      <div className="border-b border-surface-border">
        <nav className="flex gap-0" aria-label="Bookkeeping tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "px-5 py-2.5 text-sm font-medium border-b-2 transition-colors",
                activeTab === tab.id
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-navy/50 hover:text-navy hover:border-surface-border",
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === "transactions" && (
        <div className="space-y-5">
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
            <div className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4 text-navy/40" />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                title="From date"
              />
              <span className="text-navy/40">–</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                min={dateFrom || undefined}
                className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                title="To date"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="rounded p-1.5 text-navy/40 hover:text-danger transition-colors"
                  title="Clear dates"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
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
      )}

      {activeTab === "expenses" && <ExpensesTab />}
      {activeTab === "reports" && <ReportsTab />}
    </div>
  );
}
