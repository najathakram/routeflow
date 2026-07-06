"use client";

import * as React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  DollarSign,
  TrendingUp,
  Clock,
  Percent,
  Calendar,
  Package,
  Users,
  Truck,
  AlertTriangle,
} from "lucide-react";
import { PageHeader, StatCard, Card, Button, Select, cn } from "@routeflow/ui/web";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { apiClient } from "@/lib/api-client";
import { useMarginConfig } from "@/lib/api/margin";

/** Human label for the tenant's configured costing method (pos-cost-roles-spec §1). */
const COSTING_METHOD_LABEL: Record<string, string> = {
  WEIGHTED_AVERAGE: "weighted average",
  FIFO: "FIFO",
  LAST_COST: "last cost",
};

// ─── Formatters ───────────────────────────────────────────────────────────────

const usd = (x: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(x);

const pct = (x: number) => x.toFixed(1) + "%";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RevenuePeriod {
  period: string;
  revenue: number;
}

interface AovData {
  aov: number;
}

interface DsoData {
  dso: number;
  count: number;
}

interface GrossMarginData {
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
}

interface SalesByCategory {
  category: string;
  revenue: number;
}

interface TopProduct {
  id: string;
  name: string;
  totalRevenue: number;
  unitsSold: number;
}

interface InventoryTurnover {
  id: string;
  name: string;
  unitsSold: number;
  currentStock: number;
  turnoverRate: number;
}

interface DeadStock {
  id: string;
  name: string;
  currentStock: number;
  lastMovement: string;
  daysInactive: number;
}

interface MarginAlert {
  id: string;
  name: string;
  price: number;
  cost: number;
  marginPct: number;
}

interface TopCustomer {
  id: string;
  name: string;
  totalRevenue: number;
  orderCount: number;
}

interface RoutePerformance {
  id: string;
  name: string;
  totalRuns: number;
  completedRuns: number;
  completionRate: number;
}

interface DriverPerformance {
  id: string;
  name: string;
  totalDeliveries: number;
  completedDeliveries: number;
  completionRate: number;
}

// ─── Chart colours ────────────────────────────────────────────────────────────

const PIE_COLORS = [
  "#4F7FFA",
  "#22C55E",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#06B6D4",
  "#F97316",
  "#EC4899",
];

// ─── Skeleton helpers ─────────────────────────────────────────────────────────

function SkeletonLine({ w = "full", h = 4 }: { w?: string; h?: number }) {
  return <div className={cn("animate-pulse rounded bg-navy/10", `w-${w}`, `h-${h}`)} />;
}

function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="animate-pulse space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="grid gap-4" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }).map((_, j) => (
            <div key={j} className="h-4 rounded bg-navy/10" />
          ))}
        </div>
      ))}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="animate-pulse flex h-64 items-end gap-2 px-4 pb-4">
      {[60, 80, 45, 90, 70, 55, 85, 40, 75, 65, 50, 95].map((h, i) => (
        <div key={i} className="flex-1 rounded-t bg-navy/10" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors border-b-2",
        active
          ? "border-brand-500 text-brand-600"
          : "border-transparent text-navy/70 hover:text-navy hover:border-navy/20",
      )}
    >
      {children}
    </button>
  );
}

// ─── Section heading inside a card ────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-navy/70">{children}</h3>
  );
}

// ─── Simple table for analytics ───────────────────────────────────────────────

interface Column<T> {
  header: string;
  accessor: (row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
}

function AnalyticsTable<T extends { id: string }>({
  columns,
  data,
  isLoading,
  emptyText,
}: {
  columns: Column<T>[];
  data: T[];
  isLoading: boolean;
  emptyText?: string;
}) {
  if (isLoading) return <TableSkeleton rows={5} cols={columns.length} />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-border">
            {columns.map((col, i) => (
              <th
                key={i}
                className={cn(
                  "pb-2 text-xs font-semibold uppercase tracking-wider text-navy/70",
                  col.align === "right"
                    ? "text-right"
                    : col.align === "center"
                      ? "text-center"
                      : "text-left",
                  i > 0 ? "pl-4" : "",
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="py-8 text-center text-sm text-navy/70">
                {emptyText ?? "No data available"}
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr key={row.id} className="hover:bg-surface-raised/50 transition-colors">
                {columns.map((col, i) => (
                  <td
                    key={i}
                    className={cn(
                      "py-3",
                      col.align === "right"
                        ? "text-right"
                        : col.align === "center"
                          ? "text-center"
                          : "text-left",
                      i > 0 ? "pl-4" : "",
                    )}
                  >
                    {col.accessor(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tab 1: Revenue ────────────────────────────────────────────────────────────

function RevenueTab({ from, to }: { from: string; to: string }) {
  const { toast } = useToast();

  const [revenueTrend, setRevenueTrend] = React.useState<RevenuePeriod[]>([]);
  const [revenueTrendLoading, setRevenueTrendLoading] = React.useState(true);

  const [aov, setAov] = React.useState<number | null>(null);
  const [aovLoading, setAovLoading] = React.useState(true);

  const [dso, setDso] = React.useState<DsoData | null>(null);
  const [dsoLoading, setDsoLoading] = React.useState(true);

  const [grossMargin, setGrossMargin] = React.useState<GrossMarginData | null>(null);
  const [grossMarginLoading, setGrossMarginLoading] = React.useState(true);
  // The tenant's configured costing method, to state how COGS was costed.
  const { data: marginConfig } = useMarginConfig();

  const [salesByCategory, setSalesByCategory] = React.useState<SalesByCategory[]>([]);
  const [salesByCategoryLoading, setSalesByCategoryLoading] = React.useState(true);

  React.useEffect(() => {
    setRevenueTrendLoading(true);
    apiClient
      .get("/analytics/revenue", { params: { from, to, groupBy: "month" } })
      .then((r) => setRevenueTrend(r.data))
      .catch(() => toast({ title: "Failed to load revenue trend", variant: "error" }))
      .finally(() => setRevenueTrendLoading(false));
  }, [from, to]);

  React.useEffect(() => {
    setAovLoading(true);
    apiClient
      .get("/analytics/aov", { params: { from, to } })
      .then((r) => setAov((r.data as AovData).aov))
      .catch(() => setAov(null))
      .finally(() => setAovLoading(false));
  }, [from, to]);

  React.useEffect(() => {
    setDsoLoading(true);
    apiClient
      .get("/analytics/dso", { params: { from, to } })
      .then((r) => setDso(r.data as DsoData))
      .catch(() => setDso(null))
      .finally(() => setDsoLoading(false));
  }, [from, to]);

  React.useEffect(() => {
    setGrossMarginLoading(true);
    apiClient
      .get("/analytics/gross-margin", { params: { from, to } })
      .then((r) => setGrossMargin(r.data as GrossMarginData))
      .catch(() => setGrossMargin(null))
      .finally(() => setGrossMarginLoading(false));
  }, [from, to]);

  React.useEffect(() => {
    setSalesByCategoryLoading(true);
    apiClient
      .get("/analytics/sales-by-category", { params: { from, to } })
      .then((r) => setSalesByCategory(r.data))
      .catch(() => setSalesByCategory([]))
      .finally(() => setSalesByCategoryLoading(false));
  }, [from, to]);

  const totalRevenue = React.useMemo(
    () => revenueTrend.reduce((sum, p) => sum + p.revenue, 0),
    [revenueTrend],
  );

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {revenueTrendLoading ? (
          <>
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-lg border border-surface-border bg-white p-5"
              >
                <div className="mb-3 h-4 w-24 rounded bg-navy/10" />
                <div className="h-8 w-20 rounded bg-navy/10" />
              </div>
            ))}
          </>
        ) : (
          <>
            <StatCard
              label="Total Revenue"
              value={usd(totalRevenue)}
              icon={<DollarSign className="h-5 w-5" />}
            />
            <StatCard
              label="Avg Order Value"
              value={aovLoading ? "—" : aov !== null ? usd(aov) : "—"}
              icon={<TrendingUp className="h-5 w-5" />}
            />
            <StatCard
              label="DSO (Days)"
              value={dsoLoading ? "—" : dso !== null ? dso.dso.toFixed(1) : "—"}
              icon={<Clock className="h-5 w-5" />}
            />
            <StatCard
              label="Gross Margin"
              value={
                grossMarginLoading
                  ? "—"
                  : grossMargin !== null
                    ? pct(grossMargin.grossMarginPct)
                    : "—"
              }
              icon={<Percent className="h-5 w-5" />}
            />
          </>
        )}
      </div>

      {/* Revenue trend chart */}
      <Card title="Revenue Trend">
        {revenueTrendLoading ? (
          <ChartSkeleton />
        ) : revenueTrend.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-sm text-navy/70">
            No revenue data for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={revenueTrend} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
              <XAxis
                dataKey="period"
                tick={{ fontSize: 12, fill: "#6B7280" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 12, fill: "#6B7280" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip
                formatter={(value) => [usd(Number(value)), "Revenue"]}
                contentStyle={{
                  borderRadius: "8px",
                  border: "1px solid #E5E7EB",
                  fontSize: "12px",
                }}
              />
              <Bar dataKey="revenue" fill="#4F7FFA" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* Gross Margin detail + Sales by Category */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Gross Margin Breakdown">
          {grossMarginLoading ? (
            <div className="space-y-3">
              <SkeletonLine />
              <SkeletonLine w="3/4" />
              <SkeletonLine w="1/2" />
            </div>
          ) : grossMargin ? (
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between rounded-lg bg-surface-raised px-4 py-3">
                <dt className="text-navy/70">Revenue</dt>
                <dd className="font-semibold text-navy">{usd(grossMargin.revenue)}</dd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-surface-raised px-4 py-3">
                <dt className="text-navy/70">COGS</dt>
                <dd className="font-semibold text-danger">{usd(grossMargin.cogs)}</dd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-surface-raised px-4 py-3">
                <dt className="text-navy/70">Gross Profit</dt>
                <dd className="font-semibold text-success">{usd(grossMargin.grossProfit)}</dd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-brand-50 px-4 py-3">
                <dt className="font-semibold text-navy">Gross Margin %</dt>
                <dd className="text-lg font-bold text-brand-600">
                  {pct(grossMargin.grossMarginPct)}
                </dd>
              </div>
              {marginConfig?.costingMethod && (
                <p className="pt-1 text-[11px] text-navy/50">
                  COGS costed using{" "}
                  {COSTING_METHOD_LABEL[marginConfig.costingMethod] ?? marginConfig.costingMethod}.
                  Method changes apply going forward (effective-dated).
                </p>
              )}
            </dl>
          ) : (
            <p className="text-sm text-navy/70">No margin data available</p>
          )}
        </Card>

        <Card title="Sales by Category">
          {salesByCategoryLoading ? (
            <ChartSkeleton />
          ) : salesByCategory.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-navy/70">
              No category data for this period
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={salesByCategory}
                  dataKey="revenue"
                  nameKey="category"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {salesByCategory.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => usd(Number(v))} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── Tab 2: Products & Inventory ───────────────────────────────────────────────

function ProductsInventoryTab({ from, to }: { from: string; to: string }) {
  const { toast } = useToast();

  const [topMetric, setTopMetric] = React.useState<"revenue" | "units">("revenue");

  const [topProducts, setTopProducts] = React.useState<TopProduct[]>([]);
  const [topProductsLoading, setTopProductsLoading] = React.useState(true);

  const [turnover, setTurnover] = React.useState<InventoryTurnover[]>([]);
  const [turnoverLoading, setTurnoverLoading] = React.useState(true);

  const [deadStock, setDeadStock] = React.useState<DeadStock[]>([]);
  const [deadStockLoading, setDeadStockLoading] = React.useState(true);

  const [marginAlerts, setMarginAlerts] = React.useState<MarginAlert[]>([]);
  const [marginAlertsLoading, setMarginAlertsLoading] = React.useState(true);

  React.useEffect(() => {
    setTopProductsLoading(true);
    const metric = topMetric === "revenue" ? "revenue" : "units";
    apiClient
      .get("/analytics/products/top", { params: { metric, limit: 10, from, to } })
      .then((r) => setTopProducts(r.data))
      .catch(() => toast({ title: "Failed to load top products", variant: "error" }))
      .finally(() => setTopProductsLoading(false));
  }, [topMetric, from, to]);

  React.useEffect(() => {
    setTurnoverLoading(true);
    apiClient
      .get("/analytics/inventory/turnover", { params: { from, to } })
      .then((r) => setTurnover(r.data))
      .catch(() => setTurnover([]))
      .finally(() => setTurnoverLoading(false));
  }, [from, to]);

  React.useEffect(() => {
    setDeadStockLoading(true);
    apiClient
      .get("/analytics/inventory/dead-stock", { params: { from, to } })
      .then((r) => setDeadStock(r.data))
      .catch(() => setDeadStock([]))
      .finally(() => setDeadStockLoading(false));
  }, [from, to]);

  React.useEffect(() => {
    setMarginAlertsLoading(true);
    apiClient
      .get("/analytics/inventory/margin-alerts", { params: { from, to } })
      .then((r) => setMarginAlerts(r.data))
      .catch(() => setMarginAlerts([]))
      .finally(() => setMarginAlertsLoading(false));
  }, [from, to]);

  const topProductColumns: Column<TopProduct>[] = [
    {
      header: "Product",
      accessor: (row) => <span className="font-medium text-navy">{row.name}</span>,
    },
    {
      header: "Revenue",
      accessor: (row) => <span className="text-navy/80">{usd(row.totalRevenue)}</span>,
      align: "right",
    },
    {
      header: "Units Sold",
      accessor: (row) => <span className="text-navy/80">{row.unitsSold.toLocaleString()}</span>,
      align: "right",
    },
  ];

  const turnoverColumns: Column<InventoryTurnover>[] = [
    {
      header: "Product",
      accessor: (row) => <span className="font-medium text-navy">{row.name}</span>,
    },
    {
      header: "Units Sold",
      accessor: (row) => <span className="text-navy/80">{row.unitsSold.toLocaleString()}</span>,
      align: "right",
    },
    {
      header: "Current Stock",
      accessor: (row) => <span className="text-navy/80">{row.currentStock.toLocaleString()}</span>,
      align: "right",
    },
    {
      header: "Turnover Rate",
      accessor: (row) => (
        <span
          className={cn(
            "font-medium",
            row.turnoverRate >= 4
              ? "text-success"
              : row.turnoverRate >= 1
                ? "text-navy"
                : "text-warning",
          )}
        >
          {row.turnoverRate.toFixed(2)}x
        </span>
      ),
      align: "right",
    },
  ];

  const deadStockColumns: Column<DeadStock>[] = [
    {
      header: "Product",
      accessor: (row) => <span className="font-medium text-navy">{row.name}</span>,
    },
    {
      header: "Stock",
      accessor: (row) => <span className="text-navy/80">{row.currentStock.toLocaleString()}</span>,
      align: "right",
    },
    {
      header: "Last Movement",
      accessor: (row) => (
        <span className="text-navy/70">
          {row.lastMovement
            ? new Date(row.lastMovement).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })
            : "Never"}
        </span>
      ),
    },
    {
      header: "Days Inactive",
      accessor: (row) => (
        <span
          className={cn(
            "font-medium",
            row.daysInactive > 90
              ? "text-danger"
              : row.daysInactive > 30
                ? "text-warning"
                : "text-navy",
          )}
        >
          {row.daysInactive}d
        </span>
      ),
      align: "right",
    },
  ];

  const marginAlertColumns: Column<MarginAlert>[] = [
    {
      header: "Product",
      accessor: (row) => <span className="font-medium text-navy">{row.name}</span>,
    },
    {
      header: "Price",
      accessor: (row) => <span className="text-navy/80">{usd(row.price)}</span>,
      align: "right",
    },
    {
      header: "Cost",
      accessor: (row) => <span className="text-navy/80">{usd(row.cost)}</span>,
      align: "right",
    },
    {
      header: "Margin",
      accessor: (row) => (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
            row.marginPct < 10
              ? "bg-danger/10 text-danger"
              : row.marginPct < 20
                ? "bg-warning/10 text-warning"
                : "bg-success/10 text-success",
          )}
        >
          {row.marginPct < 10 && <AlertTriangle className="h-3 w-3" />}
          {pct(row.marginPct)}
        </span>
      ),
      align: "right",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Top Products */}
      <Card>
        <div className="mb-4 flex items-center justify-between gap-4">
          <SectionTitle>Top Products</SectionTitle>
          <div className="w-40">
            <Select
              options={[
                { value: "revenue", label: "By Revenue" },
                { value: "units", label: "By Units Sold" },
              ]}
              value={topMetric}
              onChange={(e) => setTopMetric(e.target.value as "revenue" | "units")}
            />
          </div>
        </div>
        <AnalyticsTable
          columns={topProductColumns}
          data={topProducts}
          isLoading={topProductsLoading}
          emptyText="No product data available"
        />
      </Card>

      {/* Inventory Turnover */}
      <Card title="Inventory Turnover">
        <AnalyticsTable
          columns={turnoverColumns}
          data={turnover}
          isLoading={turnoverLoading}
          emptyText="No turnover data available"
        />
      </Card>

      {/* Dead Stock */}
      <Card title="Dead Stock">
        <AnalyticsTable
          columns={deadStockColumns}
          data={deadStock}
          isLoading={deadStockLoading}
          emptyText="No dead stock items — great!"
        />
      </Card>

      {/* Margin Alerts */}
      <Card title="Margin Alerts">
        <AnalyticsTable
          columns={marginAlertColumns}
          data={marginAlerts}
          isLoading={marginAlertsLoading}
          emptyText="All products are within healthy margin thresholds"
        />
      </Card>
    </div>
  );
}

// ─── Tab 3: Customers ──────────────────────────────────────────────────────────

function CustomersTab({ from, to }: { from: string; to: string }) {
  const { toast } = useToast();

  const [metric, setMetric] = React.useState<"revenue" | "orders">("revenue");
  const [customers, setCustomers] = React.useState<TopCustomer[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    const m = metric === "revenue" ? "revenue" : "orderCount";
    apiClient
      .get("/analytics/customers/top", { params: { metric: m, limit: 10, from, to } })
      .then((r) => setCustomers(r.data))
      .catch(() => toast({ title: "Failed to load top customers", variant: "error" }))
      .finally(() => setLoading(false));
  }, [metric, from, to]);

  const columns: Column<TopCustomer>[] = [
    {
      header: "#",
      accessor: (_row, index?: number) => (
        <span className="text-sm font-semibold text-navy/70">{(index ?? 0) + 1}</span>
      ),
    },
    {
      header: "Customer",
      accessor: (row) => <span className="font-medium text-navy">{row.name}</span>,
    },
    {
      header: "Total Revenue",
      accessor: (row) => <span className="text-navy/80">{usd(row.totalRevenue)}</span>,
      align: "right",
    },
    {
      header: "Orders",
      accessor: (row) => <span className="text-navy/80">{row.orderCount.toLocaleString()}</span>,
      align: "right",
    },
  ];

  // Augment columns accessor with index support
  const columnsWithIndex: Column<TopCustomer>[] = columns.map((col, ci) => ({
    ...col,
    accessor: (row: TopCustomer) => {
      if (ci === 0) {
        const idx = customers.indexOf(row);
        return <span className="text-sm font-semibold text-navy/70">{idx + 1}</span>;
      }
      return col.accessor(row);
    },
  }));

  return (
    <div className="space-y-6">
      <Card>
        <div className="mb-4 flex items-center justify-between gap-4">
          <SectionTitle>Top Customers</SectionTitle>
          <div className="w-44">
            <Select
              options={[
                { value: "revenue", label: "By Revenue" },
                { value: "orders", label: "By Order Count" },
              ]}
              value={metric}
              onChange={(e) => setMetric(e.target.value as "revenue" | "orders")}
            />
          </div>
        </div>
        <AnalyticsTable
          columns={columnsWithIndex}
          data={customers}
          isLoading={loading}
          emptyText="No customer data available"
        />
      </Card>
    </div>
  );
}

// ─── Tab 4: Operations ─────────────────────────────────────────────────────────

function OperationsTab({ from, to }: { from: string; to: string }) {
  const { toast } = useToast();

  const [routes, setRoutes] = React.useState<RoutePerformance[]>([]);
  const [routesLoading, setRoutesLoading] = React.useState(true);

  const [drivers, setDrivers] = React.useState<DriverPerformance[]>([]);
  const [driversLoading, setDriversLoading] = React.useState(true);

  React.useEffect(() => {
    setRoutesLoading(true);
    apiClient
      .get("/analytics/routes/performance", { params: { from, to } })
      .then((r) => setRoutes(r.data))
      .catch(() => toast({ title: "Failed to load route performance", variant: "error" }))
      .finally(() => setRoutesLoading(false));
  }, [from, to]);

  React.useEffect(() => {
    setDriversLoading(true);
    apiClient
      .get("/analytics/drivers/performance", { params: { from, to } })
      .then((r) => setDrivers(r.data))
      .catch(() => toast({ title: "Failed to load driver performance", variant: "error" }))
      .finally(() => setDriversLoading(false));
  }, [from, to]);

  const routeColumns: Column<RoutePerformance>[] = [
    {
      header: "Route",
      accessor: (row) => <span className="font-medium text-navy">{row.name}</span>,
    },
    {
      header: "Total Runs",
      accessor: (row) => <span className="text-navy/80">{row.totalRuns.toLocaleString()}</span>,
      align: "right",
    },
    {
      header: "Completed",
      accessor: (row) => (
        <span className="text-success font-medium">{row.completedRuns.toLocaleString()}</span>
      ),
      align: "right",
    },
    {
      header: "Completion Rate",
      accessor: (row) => (
        <div className="flex items-center justify-end gap-2">
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-navy/10">
            <div
              className={cn(
                "h-full rounded-full",
                row.completionRate >= 90
                  ? "bg-success"
                  : row.completionRate >= 70
                    ? "bg-warning"
                    : "bg-danger",
              )}
              style={{ width: `${Math.min(100, row.completionRate)}%` }}
            />
          </div>
          <span
            className={cn(
              "w-12 text-right text-sm font-medium",
              row.completionRate >= 90
                ? "text-success"
                : row.completionRate >= 70
                  ? "text-warning"
                  : "text-danger",
            )}
          >
            {pct(row.completionRate)}
          </span>
        </div>
      ),
      align: "right",
    },
  ];

  const driverColumns: Column<DriverPerformance>[] = [
    {
      header: "Driver",
      accessor: (row) => <span className="font-medium text-navy">{row.name}</span>,
    },
    {
      header: "Total Deliveries",
      accessor: (row) => (
        <span className="text-navy/80">{row.totalDeliveries.toLocaleString()}</span>
      ),
      align: "right",
    },
    {
      header: "Completed",
      accessor: (row) => (
        <span className="text-success font-medium">{row.completedDeliveries.toLocaleString()}</span>
      ),
      align: "right",
    },
    {
      header: "Completion Rate",
      accessor: (row) => (
        <div className="flex items-center justify-end gap-2">
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-navy/10">
            <div
              className={cn(
                "h-full rounded-full",
                row.completionRate >= 90
                  ? "bg-success"
                  : row.completionRate >= 70
                    ? "bg-warning"
                    : "bg-danger",
              )}
              style={{ width: `${Math.min(100, row.completionRate)}%` }}
            />
          </div>
          <span
            className={cn(
              "w-12 text-right text-sm font-medium",
              row.completionRate >= 90
                ? "text-success"
                : row.completionRate >= 70
                  ? "text-warning"
                  : "text-danger",
            )}
          >
            {pct(row.completionRate)}
          </span>
        </div>
      ),
      align: "right",
    },
  ];

  return (
    <div className="space-y-6">
      <Card title="Route Performance">
        <AnalyticsTable
          columns={routeColumns}
          data={routes}
          isLoading={routesLoading}
          emptyText="No route performance data available"
        />
      </Card>

      <Card title="Driver Performance">
        <AnalyticsTable
          columns={driverColumns}
          data={drivers}
          isLoading={driversLoading}
          emptyText="No driver performance data available"
        />
      </Card>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

type TabId = "revenue" | "products" | "customers" | "operations";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "revenue", label: "Revenue", icon: <DollarSign className="h-4 w-4" /> },
  { id: "products", label: "Products & Inventory", icon: <Package className="h-4 w-4" /> },
  { id: "customers", label: "Customers", icon: <Users className="h-4 w-4" /> },
  { id: "operations", label: "Operations", icon: <Truck className="h-4 w-4" /> },
];

function getDefaultDates() {
  const now = new Date();
  const from = `${now.getFullYear()}-01-01`;
  const to = now.toISOString().split("T")[0];
  return { from, to };
}

function fmt(d: Date) {
  return d.toISOString().split("T")[0];
}

const DATE_PRESETS = [
  {
    label: "This Month",
    range: () => {
      const now = new Date();
      return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmt(now) };
    },
  },
  {
    label: "Last Month",
    range: () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: fmt(start), to: fmt(end) };
    },
  },
  {
    label: "This Quarter",
    range: () => {
      const now = new Date();
      const q = Math.floor(now.getMonth() / 3);
      return { from: fmt(new Date(now.getFullYear(), q * 3, 1)), to: fmt(now) };
    },
  },
  {
    label: "YTD",
    range: () => {
      const now = new Date();
      return { from: fmt(new Date(now.getFullYear(), 0, 1)), to: fmt(now) };
    },
  },
];

export default function AnalyticsPage() {
  const { setTitle } = usePageTitle();

  React.useEffect(() => {
    setTitle("Analytics");
  }, [setTitle]);

  const defaults = React.useMemo(() => getDefaultDates(), []);

  const [activeTab, setActiveTab] = React.useState<TabId>("revenue");
  const [fromInput, setFromInput] = React.useState(defaults.from);
  const [toInput, setToInput] = React.useState(defaults.to);
  const [appliedFrom, setAppliedFrom] = React.useState(defaults.from);
  const [appliedTo, setAppliedTo] = React.useState(defaults.to);

  const handleApply = () => {
    setAppliedFrom(fromInput);
    setAppliedTo(toInput);
  };

  const applyPreset = (preset: (typeof DATE_PRESETS)[number]) => {
    const { from, to } = preset.range();
    setFromInput(from);
    setToInput(to);
    setAppliedFrom(from);
    setAppliedTo(to);
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <PageHeader
        title="Analytics"
        action={
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-navy/70 flex-shrink-0" />
            <input
              type="date"
              value={fromInput}
              max={toInput}
              onChange={(e) => setFromInput(e.target.value)}
              className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              title="From date"
            />
            <span className="text-navy/70 text-sm">–</span>
            <input
              type="date"
              value={toInput}
              min={fromInput}
              onChange={(e) => setToInput(e.target.value)}
              className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              title="To date"
            />
            <Button variant="primary" size="sm" onClick={handleApply}>
              Apply
            </Button>
          </div>
        }
      />

      {/* Date preset shortcuts */}
      <div className="flex items-center gap-2">
        {DATE_PRESETS.map((preset) => {
          const { from, to } = preset.range();
          const isActive = appliedFrom === from && appliedTo === to;
          return (
            <button
              key={preset.label}
              onClick={() => applyPreset(preset)}
              className={cn(
                "rounded-full px-3 py-1 text-sm font-medium transition-colors",
                isActive
                  ? "bg-brand-100 text-brand-700"
                  : "bg-surface-raised text-navy/70 hover:text-navy",
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="border-b border-surface-border">
        <nav className="-mb-px flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <TabButton
              key={tab.id}
              active={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="flex items-center gap-1.5">
                {tab.icon}
                {tab.label}
              </span>
            </TabButton>
          ))}
        </nav>
      </div>

      {/* Tab panels */}
      {activeTab === "revenue" && <RevenueTab from={appliedFrom} to={appliedTo} />}
      {activeTab === "products" && <ProductsInventoryTab from={appliedFrom} to={appliedTo} />}
      {activeTab === "customers" && <CustomersTab from={appliedFrom} to={appliedTo} />}
      {activeTab === "operations" && <OperationsTab from={appliedFrom} to={appliedTo} />}
    </div>
  );
}
