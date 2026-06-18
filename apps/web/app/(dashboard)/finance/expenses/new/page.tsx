"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useCreateExpense,
  useExpenseCategories,
  useMileageRates,
  useBulkCreateExpenses,
  type CreateExpenseDto,
} from "@/lib/api/finance";
import { useSuppliers } from "@/lib/api/suppliers";
import { useCustomers } from "@/lib/api/customers";
import { useToast } from "@routeflow/ui/web";
import { SupplierSelect } from "@/components/SupplierSelect";

// ─── Shared field styles ───────────────────────────────────────────────────────

const fieldCls =
  "w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";
const labelCls = "mb-1.5 block text-sm font-medium text-navy";

// ─── Tab button ───────────────────────────────────────────────────────────────

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-brand-500 text-brand-600"
          : "border-transparent text-navy/70 hover:text-navy hover:border-surface-border"
      }`}
    >
      {label}
    </button>
  );
}

// ─── Record Expense tab ───────────────────────────────────────────────────────

interface LineItem {
  id: string;
  account: string;
  notes: string;
  amount: string;
}

function RecordExpenseTab({ onSaved }: { onSaved: () => void }) {
  const { toast } = useToast();
  const { data: categories } = useExpenseCategories();
  const { data: suppliersData } = useSuppliers();
  const { data: customersData } = useCustomers({ limit: 200 });
  const createExpense = useCreateExpense();

  const [isItemized, setIsItemized] = React.useState(false);
  const [form, setForm] = React.useState({
    categoryId: "",
    supplierId: "",
    customerId: "",
    amount: "",
    date: new Date().toISOString().split("T")[0],
    description: "",
    paymentMethod: "CASH",
    referenceNumber: "",
    notes: "",
    isBillable: false,
    employeeName: "",
  });
  const [lineItems, setLineItems] = React.useState<LineItem[]>([
    { id: crypto.randomUUID(), account: "", notes: "", amount: "" },
  ]);

  const suppliers = suppliersData?.data ?? [];
  const customers = customersData?.data ?? [];

  const lineTotal = lineItems.reduce((sum, li) => sum + (parseFloat(li.amount) || 0), 0);

  const addLineItem = () =>
    setLineItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), account: "", notes: "", amount: "" },
    ]);

  const cloneLineItem = (idx: number) =>
    setLineItems((prev) => {
      const clone = { ...prev[idx], id: crypto.randomUUID() };
      const next = [...prev];
      next.splice(idx + 1, 0, clone);
      return next;
    });

  const removeLineItem = (idx: number) => setLineItems((prev) => prev.filter((_, i) => i !== idx));

  const updateLineItem = (idx: number, key: keyof LineItem, value: string) =>
    setLineItems((prev) => prev.map((li, i) => (i === idx ? { ...li, [key]: value } : li)));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const dto: Partial<CreateExpenseDto> = {
      date: form.date,
      paymentMethod: form.paymentMethod || undefined,
      referenceNumber: form.referenceNumber || undefined,
      notes: form.notes || undefined,
      description: form.description || undefined,
      supplierId: form.supplierId || undefined,
      customerId: form.customerId || undefined,
      isBillable: form.isBillable || undefined,
      employeeName: form.employeeName || undefined,
    };

    if (isItemized) {
      const validLines = lineItems.filter((li) => li.account && li.amount);
      if (validLines.length === 0) {
        toast({ title: "Add at least one line item", variant: "error" });
        return;
      }
      dto.isItemized = true;
      dto.amount = lineTotal;
      dto.lineItems = validLines.map((li) => ({
        account: li.account,
        notes: li.notes || undefined,
        amount: parseFloat(li.amount),
      }));
    } else {
      if (!form.categoryId) {
        toast({ title: "Please select a category", variant: "error" });
        return;
      }
      if (!form.amount || isNaN(Number(form.amount))) {
        toast({ title: "Please enter a valid amount", variant: "error" });
        return;
      }
      dto.categoryId = form.categoryId;
      dto.amount = Number(form.amount);
    }

    try {
      await createExpense.mutateAsync(dto as CreateExpenseDto);
      toast({ title: "Expense recorded", variant: "success" });
      onSaved();
    } catch (err: unknown) {
      const apiMessage = (err as { response?: { data?: { message?: string } } })?.response?.data
        ?.message;
      toast({ title: apiMessage ?? "Failed to record expense", variant: "error" });
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl border border-surface-border bg-white p-6"
    >
      <div className="grid grid-cols-2 gap-4">
        {/* Date */}
        <div>
          <label className={labelCls}>Date *</label>
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            required
            className={fieldCls}
          />
        </div>

        {/* Category / Itemize */}
        <div>
          {isItemized ? (
            <div className="flex items-end justify-between h-full">
              <span className="text-sm text-navy/70 italic">Itemized expense</span>
              <button
                type="button"
                onClick={() => setIsItemized(false)}
                className="text-xs text-brand-500 hover:underline"
              >
                ← Back to single expense
              </button>
            </div>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-sm font-medium text-navy">Expense Category *</label>
                <button
                  type="button"
                  onClick={() => setIsItemized(true)}
                  className="text-xs text-brand-500 hover:underline"
                >
                  Itemize
                </button>
              </div>
              <select
                value={form.categoryId}
                onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}
                required={!isItemized}
                className={fieldCls}
              >
                <option value="">Select category...</option>
                {categories?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        {/* Amount (single mode) */}
        {!isItemized && (
          <div>
            <label className={labelCls}>Amount *</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              required
              placeholder="0.00"
              className={fieldCls}
            />
          </div>
        )}

        {/* Reference# */}
        <div>
          <label className={labelCls}>Reference #</label>
          <input
            type="text"
            value={form.referenceNumber}
            onChange={(e) => setForm((f) => ({ ...f, referenceNumber: e.target.value }))}
            placeholder="REF-001"
            className={fieldCls}
          />
        </div>

        {/* Supplier */}
        <div>
          <label className={labelCls}>Supplier / Vendor</label>
          <SupplierSelect
            value={form.supplierId}
            onChange={(id) => setForm((f) => ({ ...f, supplierId: id }))}
            suppliers={suppliers}
            placeholder="None"
          />
        </div>

        {/* Customer */}
        <div>
          <label className={labelCls}>Customer</label>
          <select
            value={form.customerId}
            onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}
            className={fieldCls}
          >
            <option value="">None</option>
            {customers.map((c: { id: string; businessName: string }) => (
              <option key={c.id} value={c.id}>
                {c.businessName}
              </option>
            ))}
          </select>
        </div>

        {/* Payment Method */}
        <div>
          <label className={labelCls}>Payment Method</label>
          <select
            value={form.paymentMethod}
            onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))}
            className={fieldCls}
          >
            <option value="CASH">Cash</option>
            <option value="CHECK">Check</option>
            <option value="ACH">ACH / Bank Transfer</option>
            <option value="CREDIT_CARD">Credit Card</option>
            <option value="OTHER">Other</option>
          </select>
        </div>

        {/* Employee */}
        <div>
          <label className={labelCls}>Employee</label>
          <input
            type="text"
            value={form.employeeName}
            onChange={(e) => setForm((f) => ({ ...f, employeeName: e.target.value }))}
            placeholder="Employee name"
            className={fieldCls}
          />
        </div>

        {/* Billable checkbox */}
        {form.customerId && (
          <div className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              id="billable"
              checked={form.isBillable}
              onChange={(e) => setForm((f) => ({ ...f, isBillable: e.target.checked }))}
              className="h-4 w-4 rounded border-surface-border text-brand-500"
            />
            <label htmlFor="billable" className="text-sm text-navy">
              Billable to customer
            </label>
          </div>
        )}

        {/* Description */}
        <div className="col-span-2">
          <label className={labelCls}>Description</label>
          <input
            type="text"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="What was this expense for?"
            className={fieldCls}
          />
        </div>

        {/* Notes */}
        <div className="col-span-2">
          <label className={labelCls}>Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            rows={2}
            maxLength={500}
            placeholder="Additional notes..."
            className={`${fieldCls} resize-none`}
          />
        </div>
      </div>

      {/* Line items (itemized mode) */}
      {isItemized && (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr_100px_40px] gap-2 text-xs font-medium text-navy/70 uppercase tracking-wide px-1">
            <span>Expense Account</span>
            <span>Notes</span>
            <span>Amount</span>
            <span></span>
          </div>
          {lineItems.map((li, idx) => (
            <div key={li.id} className="grid grid-cols-[1fr_1fr_100px_40px] gap-2 items-center">
              <select
                value={li.account}
                onChange={(e) => updateLineItem(idx, "account", e.target.value)}
                className={fieldCls}
              >
                <option value="">Select account...</option>
                {categories?.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={li.notes}
                onChange={(e) => updateLineItem(idx, "notes", e.target.value)}
                placeholder="Notes"
                className={fieldCls}
              />
              <input
                type="number"
                step="0.01"
                min="0"
                value={li.amount}
                onChange={(e) => updateLineItem(idx, "amount", e.target.value)}
                placeholder="0.00"
                className={fieldCls}
              />
              <div className="relative group">
                <button
                  type="button"
                  className="w-8 h-8 flex items-center justify-center rounded-lg border border-surface-border hover:bg-surface-raised text-navy/70 hover:text-navy transition-colors"
                >
                  ⋮
                </button>
                <div className="absolute right-0 top-9 z-10 hidden group-focus-within:block bg-white border border-surface-border rounded-lg shadow-md min-w-[140px] py-1">
                  <button
                    type="button"
                    onClick={() => cloneLineItem(idx)}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-raised"
                  >
                    Clone row
                  </button>
                  <button
                    type="button"
                    onClick={() => removeLineItem(idx)}
                    className="block w-full px-3 py-1.5 text-left text-sm text-red-500 hover:bg-red-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={addLineItem}
            className="mt-1 text-sm text-brand-500 hover:underline"
          >
            + Add New Row
          </button>
          <div className="flex justify-end border-t border-surface-border pt-2 mt-2">
            <span className="text-sm font-semibold text-navy">Total: ${lineTotal.toFixed(2)}</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-surface-border pt-4">
        <button
          type="button"
          onClick={onSaved}
          className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy/70 hover:bg-surface-raised transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={createExpense.isPending}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 transition-colors"
        >
          {createExpense.isPending ? "Saving..." : "Record Expense"}
        </button>
      </div>
    </form>
  );
}

// ─── Record Mileage tab ───────────────────────────────────────────────────────

function RecordMileageTab({ onSaved }: { onSaved: () => void }) {
  const { toast } = useToast();
  const { data: rates } = useMileageRates();
  const { data: customersData } = useCustomers({ limit: 200 });
  const createExpense = useCreateExpense();

  const [calcMode, setCalcMode] = React.useState<"distance" | "odometer">("distance");
  const [form, setForm] = React.useState({
    date: new Date().toISOString().split("T")[0],
    employeeName: "",
    distance: "",
    odometerStart: "",
    odometerEnd: "",
    referenceNumber: "",
    notes: "",
    customerId: "",
    unit: "MILE",
  });

  const customers = customersData?.data ?? [];

  // Find applicable rate
  const applicableRate = React.useMemo(() => {
    if (!rates || rates.length === 0) return null;
    const expenseDate = new Date(form.date);
    const sorted = [...rates].sort(
      (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime(),
    );
    return sorted.find((r) => new Date(r.startDate) <= expenseDate) ?? null;
  }, [rates, form.date]);

  const distance =
    calcMode === "odometer"
      ? Math.max(0, (parseFloat(form.odometerEnd) || 0) - (parseFloat(form.odometerStart) || 0))
      : parseFloat(form.distance) || 0;

  const amount = applicableRate ? distance * Number(applicableRate.ratePerUnit) : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (distance <= 0) {
      toast({ title: "Distance must be greater than 0", variant: "error" });
      return;
    }
    if (!applicableRate) {
      toast({
        title: "No mileage rate found for this date. Add a rate in Settings.",
        variant: "error",
      });
      return;
    }

    try {
      await createExpense.mutateAsync({
        date: form.date,
        isMileage: true,
        employeeName: form.employeeName || undefined,
        distance,
        mileageUnit: form.unit,
        mileageRateSnapshot: Number(applicableRate.ratePerUnit),
        amount,
        referenceNumber: form.referenceNumber || undefined,
        notes: form.notes || undefined,
        customerId: form.customerId || undefined,
      });
      toast({ title: "Mileage expense recorded", variant: "success" });
      onSaved();
    } catch (err: unknown) {
      const apiMessage = (err as { response?: { data?: { message?: string } } })?.response?.data
        ?.message;
      toast({ title: apiMessage ?? "Failed to record mileage", variant: "error" });
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl border border-surface-border bg-white p-6"
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Date *</label>
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            required
            className={fieldCls}
          />
        </div>
        <div>
          <label className={labelCls}>Employee</label>
          <input
            type="text"
            value={form.employeeName}
            onChange={(e) => setForm((f) => ({ ...f, employeeName: e.target.value }))}
            placeholder="Driver / employee name"
            className={fieldCls}
          />
        </div>

        <div className="col-span-2">
          <label className={labelCls}>Calculate mileage using</label>
          <div className="flex gap-6 mt-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                checked={calcMode === "distance"}
                onChange={() => setCalcMode("distance")}
                className="text-brand-500"
              />
              Distance travelled
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                checked={calcMode === "odometer"}
                onChange={() => setCalcMode("odometer")}
                className="text-brand-500"
              />
              Odometer reading
            </label>
          </div>
        </div>

        {calcMode === "distance" ? (
          <div>
            <label className={labelCls}>Distance *</label>
            <div className="flex gap-2">
              <input
                type="number"
                step="0.1"
                min="0"
                value={form.distance}
                onChange={(e) => setForm((f) => ({ ...f, distance: e.target.value }))}
                required
                placeholder="0"
                className={`${fieldCls} flex-1`}
              />
              <select
                value={form.unit}
                onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                className="rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="MILE">Mile(s)</option>
                <option value="KM">Km</option>
              </select>
            </div>
          </div>
        ) : (
          <div className="col-span-2 grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Odometer Start *</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={form.odometerStart}
                onChange={(e) => setForm((f) => ({ ...f, odometerStart: e.target.value }))}
                required
                placeholder="0"
                className={fieldCls}
              />
            </div>
            <div>
              <label className={labelCls}>Odometer End *</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={form.odometerEnd}
                onChange={(e) => setForm((f) => ({ ...f, odometerEnd: e.target.value }))}
                required
                placeholder="0"
                className={fieldCls}
              />
            </div>
          </div>
        )}

        <div>
          <label className={labelCls}>Amount (auto-calculated)</label>
          <div className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy/70">
            {applicableRate ? (
              `$${amount.toFixed(2)} (${distance} ${form.unit.toLowerCase()}s × $${Number(applicableRate.ratePerUnit).toFixed(4)}/${form.unit.toLowerCase()})`
            ) : (
              <span className="text-amber-600">No mileage rate set for this date</span>
            )}
          </div>
        </div>

        <div>
          <label className={labelCls}>Reference #</label>
          <input
            type="text"
            value={form.referenceNumber}
            onChange={(e) => setForm((f) => ({ ...f, referenceNumber: e.target.value }))}
            placeholder="REF-001"
            className={fieldCls}
          />
        </div>

        <div>
          <label className={labelCls}>Customer</label>
          <select
            value={form.customerId}
            onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}
            className={fieldCls}
          >
            <option value="">None</option>
            {customers.map((c: { id: string; businessName: string }) => (
              <option key={c.id} value={c.id}>
                {c.businessName}
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-2">
          <label className={labelCls}>Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            rows={2}
            maxLength={500}
            placeholder="Additional notes..."
            className={`${fieldCls} resize-none`}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-surface-border pt-4">
        <button
          type="button"
          onClick={onSaved}
          className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy/70 hover:bg-surface-raised transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={createExpense.isPending}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 transition-colors"
        >
          {createExpense.isPending ? "Saving..." : "Record Mileage"}
        </button>
      </div>
    </form>
  );
}

// ─── Bulk Add Expenses tab ────────────────────────────────────────────────────

interface BulkRow {
  id: string;
  date: string;
  categoryId: string;
  amount: string;
  customerId: string;
  isBillable: boolean;
}

function BulkAddTab({ onSaved }: { onSaved: () => void }) {
  const { toast } = useToast();
  const { data: categories } = useExpenseCategories();
  const { data: customersData } = useCustomers({ limit: 200 });
  const bulkCreate = useBulkCreateExpenses();

  const today = new Date().toISOString().split("T")[0];
  const emptyRow = (): BulkRow => ({
    id: crypto.randomUUID(),
    date: today,
    categoryId: "",
    amount: "",
    customerId: "",
    isBillable: false,
  });

  const [rows, setRows] = React.useState<BulkRow[]>(() => Array.from({ length: 5 }, emptyRow));

  const customers = customersData?.data ?? [];

  const updateRow = (idx: number, key: keyof BulkRow, value: string | boolean) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [key]: value } : r)));

  const removeRow = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx));

  const handleSave = async () => {
    const validRows = rows.filter(
      (r) => r.date && r.categoryId && r.amount && !isNaN(Number(r.amount)) && Number(r.amount) > 0,
    );
    if (validRows.length === 0) {
      toast({ title: "Add at least one complete expense row", variant: "error" });
      return;
    }

    const expenses: CreateExpenseDto[] = validRows.map((r) => ({
      date: r.date,
      categoryId: r.categoryId,
      amount: Number(r.amount),
      customerId: r.customerId || undefined,
      isBillable: r.isBillable || undefined,
    }));

    try {
      const result = await bulkCreate.mutateAsync(expenses);
      toast({ title: `${result.created} expense(s) saved`, variant: "success" });
      if (result.errors?.length) {
        toast({ title: `${result.errors.length} row(s) failed`, variant: "error" });
      } else {
        onSaved();
      }
    } catch (err: unknown) {
      const apiMessage = (err as { response?: { data?: { message?: string } } })?.response?.data
        ?.message;
      toast({ title: apiMessage ?? "Failed to save expenses", variant: "error" });
    }
  };

  return (
    <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-border bg-surface-raised">
              <th className="px-3 py-2.5 text-left font-medium text-navy/70 text-xs uppercase tracking-wide">
                Date *
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-navy/70 text-xs uppercase tracking-wide">
                Category *
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-navy/70 text-xs uppercase tracking-wide">
                Amount *
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-navy/70 text-xs uppercase tracking-wide">
                Customer
              </th>
              <th className="px-3 py-2.5 text-center font-medium text-navy/70 text-xs uppercase tracking-wide">
                Billable
              </th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {rows.map((row, idx) => (
              <tr key={row.id} className="hover:bg-surface-raised/40">
                <td className="px-2 py-1.5">
                  <input
                    type="date"
                    value={row.date}
                    onChange={(e) => updateRow(idx, "date", e.target.value)}
                    className="w-36 rounded border border-surface-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    value={row.categoryId}
                    onChange={(e) => updateRow(idx, "categoryId", e.target.value)}
                    className="w-48 rounded border border-surface-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    <option value="">Select...</option>
                    {categories?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.amount}
                    onChange={(e) => updateRow(idx, "amount", e.target.value)}
                    placeholder="0.00"
                    className="w-28 rounded border border-surface-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    value={row.customerId}
                    onChange={(e) => updateRow(idx, "customerId", e.target.value)}
                    className="w-40 rounded border border-surface-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    <option value="">None</option>
                    {customers.map((c: { id: string; businessName: string }) => (
                      <option key={c.id} value={c.id}>
                        {c.businessName}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={row.isBillable}
                    onChange={(e) => updateRow(idx, "isBillable", e.target.checked)}
                    disabled={!row.customerId}
                    className="h-4 w-4 rounded border-surface-border text-brand-500 disabled:opacity-30"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-50 text-navy/30 hover:text-red-500 transition-colors"
                    title="Remove row"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-surface-border px-4 py-3">
        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, emptyRow()])}
          className="text-sm text-brand-500 hover:underline"
        >
          + Add More Expenses
        </button>
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-surface-border px-4 py-3">
        <button
          type="button"
          onClick={onSaved}
          className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy/70 hover:bg-surface-raised transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={bulkCreate.isPending}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 transition-colors"
        >
          {bulkCreate.isPending ? "Saving..." : "Save All"}
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type TabKey = "single" | "mileage" | "bulk";

export default function NewExpensePage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("New Expense");
  }, [setTitle]);
  const router = useRouter();

  const [activeTab, setActiveTab] = React.useState<TabKey>("single");
  const handleSaved = () => router.push("/finance/expenses");

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-navy">New Expense</h1>
        <p className="text-sm text-navy/70">Record a business expense</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-surface-border flex gap-0">
        <Tab
          label="Record Expense"
          active={activeTab === "single"}
          onClick={() => setActiveTab("single")}
        />
        <Tab
          label="Record Mileage"
          active={activeTab === "mileage"}
          onClick={() => setActiveTab("mileage")}
        />
        <Tab
          label="Bulk Add Expenses"
          active={activeTab === "bulk"}
          onClick={() => setActiveTab("bulk")}
        />
      </div>

      {activeTab === "single" && <RecordExpenseTab onSaved={handleSaved} />}
      {activeTab === "mileage" && <RecordMileageTab onSaved={handleSaved} />}
      {activeTab === "bulk" && <BulkAddTab onSaved={handleSaved} />}
    </div>
  );
}
