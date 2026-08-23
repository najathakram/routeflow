"use client";

import * as React from "react";
import Link from "next/link";
import * as Tabs from "@radix-ui/react-tabs";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Download, FileText, Loader2, RefreshCcw, ShieldAlert } from "lucide-react";
import { Badge, Button, Card, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { fmt, fmtDate } from "@/lib/formatting";
import { unitsLabel } from "@/lib/stock-label";
import {
  useTenantAddons,
  useTobaccoOverview,
  useTobaccoInventory,
  useTobaccoPurchases,
  useTobaccoSales,
  useTobaccoMonthly,
  useTobaccoReports,
  useTobaccoSettings,
  useUpdateTobaccoSettings,
  useGenerateTobaccoReport,
  fetchTobaccoReportUrl,
  TOBACCO_ADDON,
  type TobaccoReport,
} from "@/lib/api/tobacco";

function monthLabel(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Last fully-completed month as {year, month}. */
function previousMonth(): { year: number; month: number } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based → previous month 1-based
  return m === 0 ? { year: y - 1, month: 12 } : { year: y, month: m };
}

export default function TobaccoPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => setTitle("Tobacco"), [setTitle]);

  const { data: addons, isLoading: addonsLoading } = useTenantAddons();
  const enabled = addons?.addons?.includes(TOBACCO_ADDON) ?? false;

  if (addonsLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="flex flex-col items-center gap-3 p-16 text-center">
        <ShieldAlert className="h-10 w-10 text-navy/30" />
        <p className="text-base font-semibold text-navy">Tobacco compliance is not enabled</p>
        <p className="max-w-md text-sm text-navy/70">
          The Tobacco Dealer Compliance add-on tracks tobacco purchases, sales, and inventory
          separately and generates monthly tax reports. Contact your platform administrator to
          enable it.
        </p>
      </div>
    );
  }

  return <TobaccoDashboard />;
}

function TobaccoDashboard() {
  const { user } = useAuth();
  const { data: overview } = useTobaccoOverview();
  const { data: monthly = [] } = useTobaccoMonthly();

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Tobacco Compliance</h1>
          <p className="text-sm text-navy/70">
            Separate tracking of tobacco purchases, sales, and inventory · monthly tax reports
          </p>
        </div>
      </div>

      {/* KPI cards — current month */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <p className="text-xs text-navy/70">Flagged Products</p>
          <p className="mt-1 text-2xl font-bold text-navy">
            {overview?.flaggedProductCount ?? "—"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-navy/70">Tobacco Inventory Value</p>
          <p className="mt-1 text-2xl font-bold text-navy">
            {overview ? fmt(overview.inventory.totalValue) : "—"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-navy/70">Purchases (this month)</p>
          <p className="mt-1 text-2xl font-bold text-navy">
            {overview ? fmt(overview.purchases.totalValue) : "—"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-navy/70">Sales / Tax (this month)</p>
          <p className="mt-1 text-2xl font-bold text-navy">
            {overview ? fmt(overview.sales.totalValue) : "—"}
            {overview && (
              <span className="ml-2 text-sm font-medium text-navy/70">
                +{fmt(overview.sales.totalTax)} tax
              </span>
            )}
          </p>
        </Card>
      </div>

      {/* Monthly trend */}
      <Card title={`Monthly Purchases vs Sales (${new Date().getUTCFullYear()})`}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={monthly} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 10, fill: "#1B3A5C99" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(m: string) => m.slice(5)}
            />
            <YAxis tick={{ fontSize: 10, fill: "#1B3A5C99" }} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
              formatter={
                ((v: number, name: string) => [
                  fmt(v),
                  name === "purchaseValue" ? "Purchases" : name === "salesValue" ? "Sales" : "Tax",
                ]) as any
              }
            />
            <Legend
              formatter={(v: string) =>
                v === "purchaseValue" ? "Purchases" : v === "salesValue" ? "Sales" : "Tax collected"
              }
              wrapperStyle={{ fontSize: 11 }}
            />
            <Bar dataKey="purchaseValue" fill="#f59e0b" radius={[3, 3, 0, 0]} />
            <Bar dataKey="salesValue" fill="#3b82f6" radius={[3, 3, 0, 0]} />
            <Bar dataKey="taxCollected" fill="#10b981" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Tabs.Root defaultValue="reports">
        <Tabs.List className="flex gap-1 border-b border-surface-border">
          {[
            { value: "reports", label: "Monthly Reports" },
            { value: "inventory", label: "Inventory" },
            { value: "purchases", label: "Purchases" },
            { value: "sales", label: "Sales" },
          ].map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                "px-4 py-2 text-sm font-medium transition-colors",
                "text-navy/70 hover:text-navy",
                "data-[state=active]:border-b-2 data-[state=active]:border-brand-500 data-[state=active]:text-brand-600",
              )}
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="reports" className="pt-4">
          <ReportsTab />
        </Tabs.Content>
        <Tabs.Content value="inventory" className="pt-4">
          <InventoryTab />
        </Tabs.Content>
        <Tabs.Content value="purchases" className="pt-4">
          <PurchasesTab />
        </Tabs.Content>
        <Tabs.Content value="sales" className="pt-4">
          <SalesTab />
        </Tabs.Content>
      </Tabs.Root>

      {user?.role === "TENANT_ADMIN" && <SettingsCard />}
    </div>
  );
}

// ─── Reports tab ──────────────────────────────────────────────────────────────

function ReportsTab() {
  const { toast } = useToast();
  const { data: reports = [], isLoading } = useTobaccoReports();
  const generate = useGenerateTobaccoReport();
  const prev = previousMonth();
  const [period, setPeriod] = React.useState(monthLabel(prev.year, prev.month));

  const handleGenerate = () => {
    const [year, month] = period.split("-").map(Number);
    generate.mutate(
      { year, month },
      {
        onSuccess: () => toast({ title: `Report ${period} generated`, variant: "success" }),
        onError: (err: any) =>
          toast({
            title: "Failed to generate report",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          }),
      },
    );
  };

  const download = async (report: TobaccoReport, format: "csv" | "pdf") => {
    try {
      const url = await fetchTobaccoReportUrl(report.id, format);
      window.open(url, "_blank", "noopener");
    } catch {
      toast({ title: `No ${format.toUpperCase()} available`, variant: "error" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-navy">Month</label>
          <input
            type="month"
            value={period}
            max={monthLabel(prev.year, prev.month)}
            onChange={(e) => setPeriod(e.target.value)}
            className="h-9 rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <Button
          size="sm"
          leftIcon={<RefreshCcw className="h-4 w-4" />}
          onClick={handleGenerate}
          loading={generate.isPending}
        >
          Generate / Regenerate
        </Button>
        <p className="text-xs text-navy/70">
          Reports auto-generate on the 1st of each month for the month just ended.
        </p>
      </div>

      {isLoading ? (
        <div className="h-24 animate-pulse rounded-lg bg-surface-raised" />
      ) : reports.length === 0 ? (
        <div className="rounded-xl border border-surface-border bg-white py-10 text-center text-navy/70">
          No reports yet — generate one for a completed month above.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-surface-border">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Period</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Purchases</th>
                <th className="px-4 py-3 text-right font-medium">Sales</th>
                <th className="px-4 py-3 text-right font-medium">Tax</th>
                <th className="px-4 py-3 text-right font-medium">Ending Stock Value</th>
                <th className="px-4 py-3 text-left font-medium">Generated</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {reports.map((r) => (
                <tr key={r.id} className="transition-colors hover:bg-surface-raised/50">
                  <td className="px-4 py-3 font-mono font-semibold text-navy">
                    {monthLabel(r.periodYear, r.periodMonth)}
                  </td>
                  <td className="px-4 py-3">
                    {r.status === "GENERATED" ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Badge variant="success" label="Generated" />
                        {r.generationCount > 1 && (
                          <span
                            title={`Regenerated — generation #${r.generationCount}`}
                            className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-semibold text-navy/70"
                          >
                            ×{r.generationCount}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span title={r.errorMessage ?? undefined}>
                        <Badge variant="danger" label="Failed" />
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-navy">
                    {fmt(Number(r.totalPurchaseValue))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-navy">
                    {fmt(Number(r.totalSalesValue))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-navy">
                    {fmt(Number(r.totalTaxCollected))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-navy/70">
                    {fmt(Number(r.endingStockValue))}
                  </td>
                  <td className="px-4 py-3 text-navy/70">{fmtDate(r.generatedAt)}</td>
                  <td className="px-4 py-3">
                    {r.status === "GENERATED" && (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void download(r, "csv")}
                          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
                        >
                          <Download className="h-3.5 w-3.5" /> CSV
                        </button>
                        <button
                          type="button"
                          onClick={() => void download(r, "pdf")}
                          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
                        >
                          <FileText className="h-3.5 w-3.5" /> PDF
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Inventory tab ────────────────────────────────────────────────────────────

function InventoryTab() {
  const { data: items = [], isLoading } = useTobaccoInventory();
  if (isLoading) return <div className="h-24 animate-pulse rounded-lg bg-surface-raised" />;
  if (items.length === 0)
    return (
      <div className="rounded-xl border border-surface-border bg-white py-10 text-center text-navy/70">
        No products flagged as tobacco yet — flag them from the product form.
      </div>
    );
  return (
    <div className="overflow-x-auto rounded-xl border border-surface-border">
      <table className="w-full text-sm">
        <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Product</th>
            <th className="px-4 py-3 text-left font-medium">SKU</th>
            <th className="px-4 py-3 text-right font-medium">Stock</th>
            <th className="px-4 py-3 text-right font-medium">Avg Cost</th>
            <th className="px-4 py-3 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">
          {items.map((p) => (
            <tr key={p.id} className="transition-colors hover:bg-surface-raised/50">
              <td className="px-4 py-3 font-medium text-navy">
                <Link href={`/products/${p.id}`} className="hover:underline">
                  {p.name}
                </Link>
                {!p.isActive && <span className="ml-2 text-xs text-navy/50">(inactive)</span>}
              </td>
              <td className="px-4 py-3 font-mono text-navy/70">{p.sku ?? "—"}</td>
              {/* Stock is a PIECE count — `p.unit` is the selling-unit noun, so it must
                  not be printed next to it. */}
              <td className="px-4 py-3 text-right tabular-nums text-navy">
                {unitsLabel(p.currentStock, p.unitsPerBox, p.unit)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-navy/70">
                {p.averageCost != null ? fmt(p.averageCost) : "—"}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-navy">
                {p.totalValue != null ? fmt(p.totalValue) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Purchases / Sales tabs ───────────────────────────────────────────────────

function useRangeState() {
  const year = new Date().getUTCFullYear();
  const [from, setFrom] = React.useState(`${year}-01-01`);
  const [to, setTo] = React.useState(new Date().toISOString().slice(0, 10));
  return { from, to, setFrom, setTo };
}

function RangePicker(props: ReturnType<typeof useRangeState>) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <input
        type="date"
        value={props.from}
        onChange={(e) => props.setFrom(e.target.value)}
        className="h-9 rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      <span className="text-sm text-navy/70">to</span>
      <input
        type="date"
        value={props.to}
        onChange={(e) => props.setTo(e.target.value)}
        className="h-9 rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    </div>
  );
}

function PurchasesTab() {
  const range = useRangeState();
  const { data: purchases = [], isLoading } = useTobaccoPurchases({
    from: range.from,
    to: range.to,
  });
  return (
    <div>
      <RangePicker {...range} />
      {isLoading ? (
        <div className="h-24 animate-pulse rounded-lg bg-surface-raised" />
      ) : purchases.length === 0 ? (
        <div className="rounded-xl border border-surface-border bg-white py-10 text-center text-navy/70">
          No tobacco purchases in this range.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-surface-border">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Product</th>
                <th className="px-4 py-3 text-left font-medium">Supplier</th>
                <th className="px-4 py-3 text-left font-medium">License #</th>
                <th className="px-4 py-3 text-left font-medium">Reference</th>
                <th className="px-4 py-3 text-right font-medium">Qty</th>
                <th className="px-4 py-3 text-right font-medium">Unit Cost</th>
                <th className="px-4 py-3 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {purchases.map((p) => (
                <tr key={p.id} className="transition-colors hover:bg-surface-raised/50">
                  <td className="px-4 py-3 text-navy/70">{fmtDate(p.date)}</td>
                  <td className="px-4 py-3 font-medium text-navy">{p.product?.name}</td>
                  <td className="px-4 py-3 text-navy">{p.supplier?.name ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-navy/70">
                    {p.supplier?.tobaccoLicenseNo ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-navy/70">{p.reference ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-navy">{p.quantity}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-navy/70">
                    {p.unitCost != null ? fmt(p.unitCost) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-navy">
                    {fmt(p.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SalesTab() {
  const range = useRangeState();
  const { data: sales = [], isLoading } = useTobaccoSales({ from: range.from, to: range.to });
  return (
    <div>
      <RangePicker {...range} />
      {isLoading ? (
        <div className="h-24 animate-pulse rounded-lg bg-surface-raised" />
      ) : sales.length === 0 ? (
        <div className="rounded-xl border border-surface-border bg-white py-10 text-center text-navy/70">
          No tobacco sales in this range.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-surface-border">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Invoice</th>
                <th className="px-4 py-3 text-left font-medium">Customer</th>
                <th className="px-4 py-3 text-left font-medium">License #</th>
                <th className="px-4 py-3 text-left font-medium">Product</th>
                <th className="px-4 py-3 text-right font-medium">Qty</th>
                <th className="px-4 py-3 text-right font-medium">Subtotal</th>
                <th className="px-4 py-3 text-right font-medium">Tax</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {sales.map((s) => {
                const licenseExpired =
                  s.customer?.tobaccoLicenseExpiry != null &&
                  new Date(s.customer.tobaccoLicenseExpiry) < new Date();
                const noLicense = !s.customer?.tobaccoLicenseNo;
                return (
                  <tr key={s.id} className="transition-colors hover:bg-surface-raised/50">
                    <td className="px-4 py-3 text-navy/70">{fmtDate(s.date)}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/invoices/${s.invoiceId}`}
                        className="font-mono text-xs font-semibold text-brand-600 hover:underline"
                      >
                        {s.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-navy">{s.customer?.businessName}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {noLicense || licenseExpired ? (
                        <span
                          title={
                            noLicense
                              ? "Customer has no tobacco license on file"
                              : "Customer's tobacco license is expired"
                          }
                          className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
                        >
                          {noLicense ? "No license" : "Expired"}
                        </span>
                      ) : (
                        <span className="text-navy/70">{s.customer.tobaccoLicenseNo}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-navy">{s.product?.name}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-navy">{s.qty}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-navy">
                      {fmt(s.subtotal)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-navy/70">{fmt(s.tax)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Settings (TENANT_ADMIN) ──────────────────────────────────────────────────

function SettingsCard() {
  const { toast } = useToast();
  const { data: settings } = useTobaccoSettings();
  const update = useUpdateTobaccoSettings();

  return (
    <Card title="Tobacco Settings">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={settings?.excludeFromMainAnalytics ?? false}
          disabled={update.isPending || !settings}
          onChange={(e) =>
            update.mutate(e.target.checked, {
              onSuccess: (s) =>
                toast({
                  title: s.excludeFromMainAnalytics
                    ? "Tobacco excluded from main analytics"
                    : "Tobacco included in main analytics",
                  variant: "success",
                }),
              onError: () => toast({ title: "Failed to update setting", variant: "error" }),
            })
          }
          className="mt-0.5 h-4 w-4 rounded border-surface-border accent-brand-500"
        />
        <span>
          <span className="block text-sm font-medium text-navy">
            Exclude tobacco from main analytics
          </span>
          <span className="block text-xs text-navy/70">
            Presentation only: revenue, top products/customers, margins, AOV, and inventory
            analytics stop counting tobacco items (they always remain here and in bookkeeping / P&L,
            which reflect real financials).
          </span>
        </span>
      </label>
    </Card>
  );
}
