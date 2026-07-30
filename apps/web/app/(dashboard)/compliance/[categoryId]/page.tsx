"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, FileText, Layers, Loader2, Package, Receipt, ShieldCheck } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge, Button, Card, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { fmt } from "@/lib/formatting";
import {
  useTrackedCategory,
  useTrackedSubcategories,
  useRegulatedFilings,
  usePrepareFiling,
  useRegulatedLedger,
  fetchRegulatedFilingUrl,
} from "@/lib/api/tracked-categories";
import { lastCompletedPeriod, taxRuleLabel, treatmentLabel } from "@/lib/regulated-format";
import { RegulatedFilingsTable } from "@/components/RegulatedFilingsTable";
import { RegulatedReportPanel } from "@/components/RegulatedReportPanel";

export default function RegulatedSectionPage({ params }: { params: { categoryId: string } }) {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const category = useTrackedCategory(params.categoryId);
  const { data: subs = [] } = useTrackedSubcategories(params.categoryId);
  const { data: filings = [] } = useRegulatedFilings(params.categoryId);
  const prepare = usePrepareFiling();

  React.useEffect(() => {
    setTitle(category.data?.name ?? "Regulated type");
  }, [setTitle, category.data?.name]);

  // Year-to-date ledger (net sales + tax by month) for this section. `to` is
  // left unbounded so today's sales (after 00:00 UTC) are included — the endpoint
  // treats `to` as an inclusive date, which would otherwise clip the current day.
  // Amounts arrive as numbers.
  const now = new Date();
  const year = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1; // 1-12
  const from = `${year}-01-01`;
  const ledger = useRegulatedLedger({ category: params.categoryId, from });

  // Read the query's own array reference (stable across renders) so the memo
  // below doesn't recompute every render on a fresh `?? []`.
  const ledgerRows = ledger.data?.rows;
  const monthKey = `${year}-${String(currentMonth).padStart(2, "0")}`;
  const thisMonth = ledgerRows?.find((r) => r.periodBucket === monthKey);

  const chartData = React.useMemo(() => {
    const byMonth = new Map((ledgerRows ?? []).map((r) => [r.periodBucket, r]));
    const out: { month: string; netSales: number; categoryTax: number }[] = [];
    for (let m = 1; m <= currentMonth; m++) {
      const key = `${year}-${String(m).padStart(2, "0")}`;
      const r = byMonth.get(key);
      out.push({ month: key, netSales: r?.netSales ?? 0, categoryTax: r?.categoryTax ?? 0 });
    }
    return out;
  }, [ledgerRows, year, currentMonth]);

  const activeSubs = subs.filter((s) => s.active);

  const [preparing, setPreparing] = React.useState(false);
  const handlePrepare = () => {
    const c = category.data;
    if (!c) return;
    const { year: py, index } = lastCompletedPeriod(c.reportCadence);
    setPreparing(true);
    prepare.mutate(
      { trackedCategoryId: c.id, cadence: c.reportCadence, year: py, index },
      {
        onSuccess: async (filing) => {
          toast({ title: `Filing prepared · ${filing.periodKey}`, variant: "success" });
          try {
            const url = await fetchRegulatedFilingUrl(filing.id, "csv");
            window.open(url, "_blank", "noopener");
          } catch {
            /* saved; the CSV link in the filings table still works */
          }
        },
        onError: () => toast({ title: "Failed to prepare filing", variant: "error" }),
        onSettled: () => setPreparing(false),
      },
    );
  };

  if (category.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-navy/50" />
      </div>
    );
  }

  if (!category.data) {
    return (
      <div className="space-y-4 p-6">
        <Link
          href="/compliance"
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Regulated Items
        </Link>
        <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 py-16 text-center text-sm text-navy/70">
          This regulated type wasn&apos;t found. It may have been removed.
        </div>
      </div>
    );
  }

  const c = category.data;

  return (
    <div className="space-y-5 p-6">
      <div>
        <Link
          href="/compliance"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Regulated Items
        </Link>
        <div className="mt-1 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-brand-600" />
              <h1 className="text-2xl font-bold text-navy">{c.name}</h1>
              {c.requiresLicense && <Badge variant="warning" label="License" />}
              {!c.active && <Badge variant="neutral" label="Off" />}
            </div>
            <p className="mt-1 text-sm text-navy/70">
              {taxRuleLabel(c)} · {treatmentLabel(c.invoiceTreatment)} ·{" "}
              {c.reportCadence.toLowerCase()} filings
            </p>
          </div>
          <Button
            variant="secondary"
            leftIcon={
              preparing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )
            }
            onClick={handlePrepare}
            disabled={preparing}
          >
            Prepare filing
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <div className="flex items-center gap-2 text-xs text-navy/70">
            <Receipt className="h-4 w-4" /> Net Sales (this month)
          </div>
          <p className="mt-1 text-2xl font-bold text-navy">
            {ledger.isLoading ? "…" : fmt(thisMonth?.netSales ?? 0)}
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-xs text-navy/70">
            <Receipt className="h-4 w-4" /> Tax (this month)
          </div>
          <p className="mt-1 text-2xl font-bold text-navy">
            {ledger.isLoading ? "…" : fmt(thisMonth?.categoryTax ?? 0)}
          </p>
          <p className="mt-0.5 text-[11px] text-navy/50">
            Snapshot pending the tax engine · net sales are live
          </p>
        </Card>
        <Link
          href={`/products?section=${params.categoryId}`}
          title="View these products"
          className="block rounded-lg transition-shadow hover:ring-2 hover:ring-brand-200"
        >
          <Card>
            <div className="flex items-center gap-2 text-xs text-navy/70">
              <Package className="h-4 w-4" /> Regulated Products
            </div>
            <p className="mt-1 text-2xl font-bold text-navy">{c.productCount}</p>
          </Card>
        </Link>
        <Card>
          <div className="flex items-center gap-2 text-xs text-navy/70">
            <FileText className="h-4 w-4" /> Filings
          </div>
          <p className="mt-1 text-2xl font-bold text-navy">{filings.length}</p>
        </Card>
      </div>

      {/* Monthly trend */}
      <Card title={`Monthly Net Sales vs Tax (${year})`}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
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
                  name === "netSales" ? "Net sales" : "Tax",
                ]) as any
              }
            />
            <Legend
              formatter={(v: string) => (v === "netSales" ? "Net sales" : "Tax collected")}
              wrapperStyle={{ fontSize: 11 }}
            />
            <Bar dataKey="netSales" fill="#3b82f6" radius={[3, 3, 0, 0]} />
            <Bar dataKey="categoryTax" fill="#10b981" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Subcategories (read-only; manage in Settings) */}
      <Card title="Categories">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs text-navy/60">Classification tags within this type.</p>
          <Link
            href="/settings?tab=regulated"
            className="text-xs font-medium text-brand-600 hover:underline"
          >
            Manage in Settings →
          </Link>
        </div>
        {activeSubs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-surface-border bg-surface-raised/40 px-4 py-6 text-center text-sm text-navy/60">
            No categories yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {activeSubs.map((s) => (
              <li
                key={s.id}
                className="inline-flex items-center gap-2 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm text-navy"
              >
                <Layers className="h-3.5 w-3.5 text-brand-600" />
                {s.name}
                <span className="text-[11px] text-navy/50">
                  {s.productCount} {s.productCount === 1 ? "product" : "products"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Reports — arbitrary date-range preview + CSV, separate from the filings archive below */}
      <RegulatedReportPanel
        categoryId={params.categoryId}
        categoryName={c.name}
        categoryDefaultTemplate={c.reportTemplate}
      />

      {/* Filings */}
      <Card title="Filings">
        <RegulatedFilingsTable
          filings={filings}
          emptyHint={
            <>
              No filings prepared yet. Use{" "}
              <span className="font-medium text-navy">Prepare filing</span> above to generate one
              for the last completed period.
            </>
          }
        />
      </Card>
    </div>
  );
}
