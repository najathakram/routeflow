"use client";

import * as React from "react";
import Link from "next/link";
import { FileText, Layers, Loader2, Package, Receipt, ShieldCheck } from "lucide-react";
import { Badge, Card, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { fmt } from "@/lib/formatting";
import { useHasAddon, useTobaccoOverview, TOBACCO_ADDON } from "@/lib/api/tobacco";
import { useTrackedCategories, useRegulatedFilings } from "@/lib/api/tracked-categories";
import { taxRuleLabel, treatmentLabel } from "@/lib/regulated-format";
import { RegulatedFilingsTable } from "@/components/RegulatedFilingsTable";

/**
 * Regulated Items hub — a read-only index. KPI overview, one card per section
 * (each links to that section's dashboard at /compliance/[id]), and a filings
 * roll-up across all sections. Creating/editing sections lives in
 * Settings → Regulated (TENANT_ADMIN); per-section stats + filing prep live on
 * the section dashboard.
 */
export default function CompliancePage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => setTitle("Regulated Items"), [setTitle]);

  const { data: categories = [], isLoading } = useTrackedCategories();
  const hasTobacco = useHasAddon(TOBACCO_ADDON);
  // The generic per-category tax KPI is still deferred (W3 tax engine); for a
  // tobacco tenant we surface the existing tobacco overview total, else "—".
  const { data: overview } = useTobaccoOverview(undefined, { enabled: hasTobacco });
  const { data: filings = [] } = useRegulatedFilings();

  const activeCount = categories.filter((c) => c.active).length;
  const regulatedProducts = categories.reduce((sum, c) => sum + (c.productCount ?? 0), 0);
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? "—";

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Regulated Items</h1>
          <p className="text-sm text-navy/70">
            Separately-handled sections · per-section tax, invoicing and filings
          </p>
        </div>
        <Link
          href="/settings?tab=regulated"
          className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border px-3 py-2 text-sm font-medium text-navy hover:bg-surface-raised"
        >
          <ShieldCheck className="h-4 w-4" /> Manage types
        </Link>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <div className="flex items-center gap-2 text-xs text-navy/70">
            <Layers className="h-4 w-4" /> Regulated Types
          </div>
          <p className="mt-1 text-2xl font-bold text-navy">
            {activeCount}
            {categories.length > activeCount && (
              <span className="ml-2 text-sm font-medium text-navy/50">
                / {categories.length} total
              </span>
            )}
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-xs text-navy/70">
            <Package className="h-4 w-4" /> Regulated Products
          </div>
          <p className="mt-1 text-2xl font-bold text-navy">{regulatedProducts}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-xs text-navy/70">
            <Receipt className="h-4 w-4" /> Tax Collected (this month)
          </div>
          <p className="mt-1 text-2xl font-bold text-navy">
            {hasTobacco && overview ? fmt(overview.sales.totalTax) : "—"}
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-xs text-navy/70">
            <FileText className="h-4 w-4" /> Filings
          </div>
          <p className="mt-1 text-2xl font-bold text-navy">{filings.length}</p>
          {hasTobacco && (
            <Link href="/tobacco" className="text-xs text-brand-600 hover:underline">
              Tobacco reports →
            </Link>
          )}
        </Card>
      </div>

      {/* Sections */}
      <Card title="Regulated Types">
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-navy/50" />
          </div>
        ) : categories.length === 0 ? (
          <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 py-10 text-center text-sm text-navy/70">
            No regulated types yet.{" "}
            <Link
              href="/settings?tab=regulated"
              className="font-medium text-brand-600 hover:underline"
            >
              Create one in Settings
            </Link>{" "}
            (tobacco is added automatically for tenants that sell it).
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {categories.map((c) => (
              <Link
                key={c.id}
                href={`/compliance/${c.id}`}
                className={cn(
                  "block rounded-xl border border-surface-border bg-white p-4 transition hover:border-brand-300 hover:shadow-sm",
                  !c.active && "opacity-60",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-brand-600" />
                    <span className="font-semibold text-navy">{c.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {c.requiresLicense && <Badge variant="warning" label="License" />}
                    <Badge
                      variant={c.active ? "success" : "neutral"}
                      label={c.active ? "Active" : "Off"}
                    />
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-navy/60">Tax rule</dt>
                    <dd className="font-medium text-navy">{taxRuleLabel(c)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-navy/60">Invoice treatment</dt>
                    <dd className="font-medium text-navy">{treatmentLabel(c.invoiceTreatment)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-navy/60">Products</dt>
                    <dd className="font-medium text-navy">{c.productCount}</dd>
                  </div>
                </dl>
                <div className="mt-3 border-t border-surface-border pt-3 text-xs font-medium text-brand-600">
                  View dashboard →
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>

      {/* Filings roll-up (all sections) */}
      <Card title="Filings">
        <RegulatedFilingsTable filings={filings} showCategory categoryName={categoryName} />
      </Card>
    </div>
  );
}
