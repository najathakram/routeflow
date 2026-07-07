"use client";

import * as React from "react";
import Link from "next/link";
import {
  Boxes,
  Download,
  FileText,
  Layers,
  Loader2,
  Package,
  Pencil,
  Plus,
  Power,
  Receipt,
  ShieldCheck,
} from "lucide-react";
import { Badge, Button, Card, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { fmt } from "@/lib/formatting";
import { useHasAddon, useTobaccoOverview, TOBACCO_ADDON } from "@/lib/api/tobacco";
import {
  useTrackedCategories,
  useToggleTrackedCategory,
  usePrepareFiling,
  useRegulatedFilings,
  fetchRegulatedFilingUrl,
  type TrackedCategory,
  type InvoiceTreatment,
  type ReportCadence,
} from "@/lib/api/tracked-categories";
import { CategoryFormModal } from "@/components/CategoryFormModal";
import { AssignProductsModal } from "@/components/AssignProductsModal";

/** The most recent completed period for a cadence, as {year, index}. */
function lastCompletedPeriod(cadence: ReportCadence): { year: number; index: number } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12
  if (cadence === "ANNUAL") return { year: y - 1, index: 1 };
  if (cadence === "QUARTERLY") {
    const q = Math.floor((m - 1) / 3) + 1; // current quarter 1-4
    return q === 1 ? { year: y - 1, index: 4 } : { year: y, index: q - 1 };
  }
  return m === 1 ? { year: y - 1, index: 12 } : { year: y, index: m - 1 }; // MONTHLY: prev month
}

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
  const { toast } = useToast();

  const { data: categories = [], isLoading } = useTrackedCategories();
  const hasTobacco = useHasAddon(TOBACCO_ADDON);
  // KPIs bind to the existing tobacco overview initially; the generic per-category
  // ledger + filings arrive in W5. Only fetched when the tobacco addon is active
  // (the endpoint is addon-guarded — avoid a 403 for non-addon tenants).
  const { data: overview } = useTobaccoOverview(undefined, { enabled: hasTobacco });
  const toggle = useToggleTrackedCategory();
  const { data: filings = [] } = useRegulatedFilings();
  const prepare = usePrepareFiling();

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TrackedCategory | null>(null);
  const [assignFor, setAssignFor] = React.useState<TrackedCategory | null>(null);
  const [preparingId, setPreparingId] = React.useState<string | null>(null);

  const activeCount = categories.filter((c) => c.active).length;
  const regulatedProducts = categories.reduce((sum, c) => sum + (c.productCount ?? 0), 0);
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? "—";

  const openFilingUrl = async (id: string) => {
    const url = await fetchRegulatedFilingUrl(id, "csv");
    window.open(url, "_blank", "noopener");
  };

  // Prepare the most recent completed period for the category's cadence, then
  // open its CSV. The filing is persisted regardless, so a failed download still
  // leaves a working link in the filings list.
  const handlePrepare = (c: TrackedCategory) => {
    const { year, index } = lastCompletedPeriod(c.reportCadence);
    setPreparingId(c.id);
    prepare.mutate(
      { trackedCategoryId: c.id, cadence: c.reportCadence, year, index },
      {
        onSuccess: async (filing) => {
          toast({ title: `Filing prepared · ${filing.periodKey}`, variant: "success" });
          try {
            await openFilingUrl(filing.id);
          } catch {
            /* saved; the download link in the list still works */
          }
        },
        onError: () => toast({ title: "Failed to prepare filing", variant: "error" }),
        onSettled: () => setPreparingId(null),
      },
    );
  };

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (c: TrackedCategory) => {
    setEditing(c);
    setFormOpen(true);
  };
  const handleToggle = (c: TrackedCategory) =>
    toggle.mutate(c.id, {
      onSuccess: (updated) =>
        toast({
          title: updated.active ? `${c.name} activated` : `${c.name} deactivated`,
          variant: "success",
        }),
      onError: () => toast({ title: "Failed to update category", variant: "error" }),
    });

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Regulated Items</h1>
          <p className="text-sm text-navy/70">
            Separately-handled categories · per-category tax, invoicing and filings
          </p>
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openNew}>
          New category
        </Button>
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
          <p className="mt-1 text-2xl font-bold text-navy">{filings.length}</p>
          {hasTobacco && (
            <Link href="/tobacco" className="text-xs text-brand-600 hover:underline">
              Tobacco reports →
            </Link>
          )}
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
            No tracked categories yet.{" "}
            <button
              type="button"
              onClick={openNew}
              className="font-medium text-brand-600 hover:underline"
            >
              Create your first category
            </button>{" "}
            (tobacco is added automatically for tenants that sell it).
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
                <div className="mt-3 flex items-center gap-1 border-t border-surface-border pt-3">
                  <button
                    type="button"
                    onClick={() => setAssignFor(c)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy"
                  >
                    <Boxes className="h-3.5 w-3.5" /> Products
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(c)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePrepare(c)}
                    disabled={preparingId === c.id}
                    title={`Prepare the last completed ${c.reportCadence.toLowerCase()} filing`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy disabled:opacity-50"
                  >
                    {preparingId === c.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileText className="h-3.5 w-3.5" />
                    )}{" "}
                    Prepare filing
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggle(c)}
                    disabled={toggle.isPending}
                    className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy disabled:opacity-50"
                  >
                    <Power className="h-3.5 w-3.5" /> {c.active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Filings */}
      <Card title="Filings">
        {filings.length === 0 ? (
          <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 py-8 text-center text-sm text-navy/70">
            No filings prepared yet. Use{" "}
            <span className="font-medium text-navy">Prepare filing</span> on a category above to
            generate one for the last completed period.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border text-left text-xs text-navy/60">
                  <th className="py-2 pr-3 font-medium">Period</th>
                  <th className="py-2 pr-3 font-medium">Category</th>
                  <th className="py-2 pr-3 text-right font-medium">Net sales</th>
                  <th className="py-2 pr-3 text-right font-medium">Tax</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {filings.map((f) => (
                  <tr key={f.id} className="border-b border-surface-border/60 last:border-0">
                    <td className="py-2 pr-3 font-medium text-navy">{f.periodKey}</td>
                    <td className="py-2 pr-3 text-navy/80">{categoryName(f.trackedCategoryId)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-navy">
                      {fmt(Number(f.totalNetSales))}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-navy">
                      {fmt(Number(f.totalCategoryTax))}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge
                        variant={f.status === "GENERATED" ? "success" : "warning"}
                        label={f.status === "GENERATED" ? "Generated" : "Failed"}
                      />
                    </td>
                    <td className="py-2 text-right">
                      {f.csvKey && (
                        <button
                          type="button"
                          onClick={() =>
                            openFilingUrl(f.id).catch(() =>
                              toast({ title: "Failed to open CSV", variant: "error" }),
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-600 hover:bg-surface-raised"
                        >
                          <Download className="h-3.5 w-3.5" /> CSV
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CategoryFormModal isOpen={formOpen} onClose={() => setFormOpen(false)} category={editing} />
      <AssignProductsModal
        isOpen={!!assignFor}
        onClose={() => setAssignFor(null)}
        category={assignFor}
      />
    </div>
  );
}
