"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Package,
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
import { useProduct, useUpdateProduct, useDeleteProduct } from "@/lib/api/products";

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

function getStockStatus(currentStock: number, isActive: boolean): StockStatus {
  if (!isActive) return "OUT_OF_STOCK";
  if (currentStock <= 0) return "OUT_OF_STOCK";
  if (currentStock <= 5) return "LOW";
  return "IN_STOCK";
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
  const deleteProduct = useDeleteProduct();

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
  const currentStock = Number(product.currentStock ?? 0);
  const stockStatus = getStockStatus(currentStock, product.isActive);
  const demandData = generateDemandData(product.id);

  const startEdit = () => {
    setEditDraft({
      name: product.name,
      sku: product.sku ?? "",
      barcode: product.barcode ?? "",
      unit: product.unit,
      pricePerUnit: String(priceNumber),
      category: product.category ?? "",
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
                <span className="text-sm text-navy/60">On hand</span>
                <span className="font-medium text-navy">
                  {currentStock.toFixed(2)} {product.unit}
                </span>
              </div>
              {product.averageCost && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-navy/60">Avg cost</span>
                  <span className="font-medium text-navy">
                    ${parseFloat(String(product.averageCost)).toFixed(2)}
                  </span>
                </div>
              )}
              <Link
                href={`/inventory/movements?product=${product.id}`}
                className="block text-xs text-brand-500 hover:underline"
              >
                View stock movements →
              </Link>
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
                {!isEditing && <p className="mt-1 font-mono text-xs text-navy/40">{product.sku}</p>}
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
                  <>
                    <button
                      onClick={startEdit}
                      title="Edit product"
                      className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => updateProduct.mutate({ id: params.id, isActive: !product.isActive })}
                      loading={updateProduct.isPending}
                    >
                      {product.isActive ? "Deactivate" : "Activate"}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <InfoRow
                label="SKU"
                value={isEditing ? (
                  <input value={(editDraft.sku as string) ?? ""} onChange={(e) => setEditDraft((d) => ({ ...d, sku: e.target.value }))}
                    className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
                ) : product.sku}
              />
              <InfoRow
                label="Barcode"
                value={isEditing ? (
                  <input value={(editDraft.barcode as string) ?? ""} onChange={(e) => setEditDraft((d) => ({ ...d, barcode: e.target.value }))}
                    className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
                ) : product.barcode ?? <span className="text-navy/30">—</span>}
              />
              <InfoRow
                label="Category"
                value={isEditing ? (
                  <input value={(editDraft.category as string) ?? ""} onChange={(e) => setEditDraft((d) => ({ ...d, category: e.target.value }))}
                    className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
                ) : product.category}
              />
              <InfoRow
                label="Unit of Measure"
                value={isEditing ? (
                  <input value={(editDraft.unit as string) ?? ""} onChange={(e) => setEditDraft((d) => ({ ...d, unit: e.target.value }))}
                    className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
                ) : product.unit}
              />
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
                    formatter={((v: number) => [`${v} units`, "Ordered"]) as any}
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
