"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Package,
  Flag,
  Pencil,
  Check,
  X,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Badge, Button, Card, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useProduct, useUpdateProduct, useClearProductOverride } from "@/lib/api/products";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic 30-day demand data seeded by product ID. */
function generateDemandData(productId: string): { day: string; units: number }[] {
  const seed = Array.from(productId).reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const base = new Date(2026, 1, 8); // Feb 8
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const units = Math.max(
      1,
      Math.round(8 + ((seed * 3 + i * 7) % 14) + Math.round(Math.sin((i + seed) * 0.7) * 4)),
    );
    return { day: `${d.getMonth() + 1}/${d.getDate()}`, units };
  });
}

type StockStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK";

function getStockStatus(lowStock: boolean, isActive: boolean): StockStatus {
  if (!isActive) return "OUT_OF_STOCK";
  if (lowStock) return "LOW";
  return "IN_STOCK";
}

// ─── Local override banner ────────────────────────────────────────────────────

function OverrideBanner({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-warning/30 bg-warning-bg px-4 py-3">
      <div className="flex items-center gap-2">
        <Flag className="h-4 w-4 shrink-0 text-warning" />
        <p className="text-sm font-medium text-warning">
          Zoho sync paused — local overrides are active on this product.
        </p>
      </div>
      <button
        onClick={onReset}
        className="shrink-0 text-xs text-warning/70 underline hover:text-warning transition-colors"
      >
        Resume sync
      </button>
    </div>
  );
}

// ─── Info row ─────────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-navy/50">{label}</p>
      <div className="mt-0.5 text-sm font-medium text-navy">{value}</div>
    </div>
  );
}

// ─── Inline number field ──────────────────────────────────────────────────────

function EditableNumber({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={0}
      step={0.01}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
    />
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { data: product, isLoading } = useProduct(params.id);
  const updateProduct = useUpdateProduct();
  const clearOverride = useClearProductOverride();

  const [isEditing, setIsEditing] = React.useState(false);
  const [editDraft, setEditDraft] = React.useState<Record<string, unknown>>({});
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => { setIsMounted(true); }, []);
  React.useEffect(() => {
    setTitle(product?.name ?? "Product");
  }, [setTitle, product?.name]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12 text-navy/40">Loading...</div>
    );
  }

  if (!product) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Product not found.</p>
        <Button variant="secondary" href="/products">Back to Products</Button>
      </div>
    );
  }

  const priceNumber = parseFloat(String(product.pricePerUnit));
  const stockStatus = getStockStatus(product.lowStock, product.isActive);
  const demandData = generateDemandData(product.id);

  const startEdit = () => {
    setEditDraft({
      name: product.name,
      pricePerUnit: String(priceNumber),
      description: product.description ?? "",
    });
    setIsEditing(true);
  };

  const saveEdit = () => {
    updateProduct.mutate({ id: params.id, ...editDraft });
    setIsEditing(false);
  };

  const cancelEdit = () => {
    setEditDraft({});
    setIsEditing(false);
  };

  const resumeSync = () => {
    clearOverride.mutate(params.id);
  };

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/products"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Products
      </Link>

      {/* Override warning */}
      {product.hasLocalOverride && <OverrideBanner onReset={resumeSync} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* ── Left: image + stock card ── */}
        <div className="space-y-4">
          <div
            className={cn(
              "flex h-52 w-full items-center justify-center rounded-xl border",
              stockStatus === "LOW" && "border-warning/30 bg-warning-bg",
              stockStatus === "OUT_OF_STOCK" && "border-danger/30 bg-danger-bg",
              stockStatus === "IN_STOCK" && "border-surface-border bg-surface-raised",
            )}
          >
            <Package
              className={cn(
                "h-16 w-16",
                stockStatus === "LOW" && "text-warning/30",
                stockStatus === "OUT_OF_STOCK" && "text-danger/30",
                stockStatus === "IN_STOCK" && "text-navy/15",
              )}
            />
          </div>

          <Card>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-navy/60">Stock status</span>
                {stockStatus === "OUT_OF_STOCK" ? (
                  <Badge variant="danger" label="Out of Stock" />
                ) : stockStatus === "LOW" ? (
                  <Badge variant="warning" label="Low Stock" />
                ) : (
                  <Badge variant="success" label="In Stock" />
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-navy/60">Low stock flag</span>
                <span className="font-medium text-navy">
                  {product.lowStock ? "Yes" : "No"}
                </span>
              </div>
            </div>
          </Card>
        </div>

        {/* ── Right: details + chart ── */}
        <div className="space-y-5 lg:col-span-2">

          {/* Product details */}
          <Card>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <input
                    value={(editDraft.name as string) ?? ""}
                    onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                    className="w-full rounded border border-surface-border px-2 py-1 text-lg font-bold text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                ) : (
                  <h1 className="text-xl font-bold text-navy">{product.name}</h1>
                )}
                <p className="mt-1 font-mono text-xs text-navy/40">{product.sku}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isEditing ? (
                  <>
                    <button
                      onClick={cancelEdit}
                      title="Cancel"
                      className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                    <Button
                      size="sm"
                      onClick={saveEdit}
                      loading={updateProduct.isPending}
                      leftIcon={<Check className="h-4 w-4" />}
                    >
                      Save
                    </Button>
                  </>
                ) : (
                  <button
                    onClick={startEdit}
                    title="Edit product"
                    className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <InfoRow label="Category" value={product.category} />
              <InfoRow label="Unit of Measure" value={product.unit} />
              <InfoRow
                label="Price"
                value={
                  isEditing ? (
                    <EditableNumber
                      value={parseFloat(String(editDraft.pricePerUnit ?? priceNumber))}
                      onChange={(v) => setEditDraft((d) => ({ ...d, pricePerUnit: String(v) }))}
                    />
                  ) : (
                    `$${priceNumber.toFixed(2)}`
                  )
                }
              />
            </div>

            <div className="mt-4">
              <p className="mb-1 text-xs text-navy/50">Description</p>
              {isEditing ? (
                <textarea
                  value={(editDraft.description as string) ?? ""}
                  onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))}
                  rows={3}
                  className="w-full resize-y rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              ) : (
                <p className="text-sm text-navy/80">{product.description}</p>
              )}
            </div>

            {product.hasLocalOverride && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-warning">
                <Flag className="h-3.5 w-3.5" />
                Local overrides active — Zoho sync paused
              </p>
            )}
          </Card>

          {/* 30-day demand chart */}
          <Card title="30-Day Order Demand">
            {isMounted ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={demandData}
                  margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#e2e8f0"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: "#1B3A5C99" }}
                    tickLine={false}
                    axisLine={false}
                    interval={4}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#1B3A5C99" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid #e2e8f0",
                      fontSize: 12,
                      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                    }}
                    labelStyle={{ color: "#1B3A5C", fontWeight: 600 }}
                    formatter={(v: number) => [`${v} units`, "Ordered"]}
                  />
                  <Bar dataKey="units" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[200px] animate-pulse rounded-lg bg-surface-raised" />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
