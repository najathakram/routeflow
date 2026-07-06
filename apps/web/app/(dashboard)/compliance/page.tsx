"use client";

import * as React from "react";
import Link from "next/link";
import { FileText, Layers, Loader2, Package, Receipt, ShieldCheck } from "lucide-react";
import { Badge, Card, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { fmt } from "@/lib/formatting";
import { useHasAddon, useTobaccoOverview, TOBACCO_ADDON } from "@/lib/api/tobacco";
import {
  useTrackedCategories,
  type TrackedCategory,
  type InvoiceTreatment,
} from "@/lib/api/tracked-categories";

function taxRuleLabel(c: TrackedCategory): string {
  const rate = Number(c.rate);
  const basis = c.unitBasis || "unit";
  switch (c.taxType) {
    case "EXCISE_PER_UNIT":
    case "PER_VOLUME":
    case "DEPOSIT_PER_CONTAINER":
      return `${fmt(rate)} / ${basis}`;
    case "PERCENT_OF_SALE": {
      const pct = rate * 100;
      return `${pct % 1 === 0 ? pct : pct.toFixed(2)}% of sale`;
    }
    case "NONE":
    default:
      return "Tracked only · no auto tax";
  }
}

function treatmentLabel(t: InvoiceTreatment): string {
  return t === "SEPARATE_INVOICE"
    ? "Separate invoice"
    : t === "SEPARATE_SECTION"
      ? "Sectioned on invoice"
      : "Per-line tax";
}

export default function CompliancePage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => setTitle("Regulated Items"), [setTitle]);

  const { data: categories = [], isLoading } = useTrackedCategories();
  const hasTobacco = useHasAddon(TOBACCO_ADDON);
  // KPIs bind to the existing tobacco overview initially; the generic per-category
  // ledger + filings arrive in W5. Only fetched when the tobacco addon is active
  // (the endpoint is addon-guarded — avoid a 403 for non-addon tenants).
  const { data: overview } = useTobaccoOverview(undefined, { enabled: hasTobacco });

  const activeCount = categories.filter((c) => c.active).length;
  const regulatedProducts = categories.reduce((sum, c) => sum + (c.productCount ?? 0), 0);

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Regulated Items</h1>
          <p className="text-sm text-navy/70">
            Separately-handled categories · per-category tax, invoicing and filings
          </p>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <div className="flex items-center gap-2 text-xs text-navy/70">
            <Layers className="h-4 w-4" /> Tracked Categories
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
          <p className="mt-1 text-sm font-medium text-navy/70">
            {hasTobacco ? (
              <Link href="/tobacco" className="text-brand-600 hover:underline">
                Tobacco reports →
              </Link>
            ) : (
              "No filings configured"
            )}
          </p>
        </Card>
      </div>

      {/* Categories */}
      <Card title="Categories">
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-navy/50" />
          </div>
        ) : categories.length === 0 ? (
          <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 py-10 text-center text-sm text-navy/70">
            No tracked categories yet. Tobacco is created automatically for tenants that sell it;
            other categories will be manageable here soon.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {categories.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "rounded-xl border border-surface-border bg-white p-4",
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
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
