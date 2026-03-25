"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Package, LayoutGrid, LayoutList, Plus } from "lucide-react";
import { PageHeader, Table, Badge, Button, Select, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { useProducts, useCreateProduct } from "@/lib/api/products";

// ─── Types ────────────────────────────────────────────────────────────────────

type StockStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK";

interface ApiProduct {
  id: string;
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit: string;
  pricePerUnit: string;
  isActive: boolean;
  currentStock: number;
  averageCost?: string;
  description?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStockStatus(p: ApiProduct): StockStatus {
  if (!p.isActive) return "OUT_OF_STOCK";
  if (p.currentStock <= 0) return "OUT_OF_STOCK";
  if (p.currentStock <= 5) return "LOW";
  return "IN_STOCK";
}

// ─── Stock badge ──────────────────────────────────────────────────────────────

function StockBadge({ status }: { status: StockStatus }) {
  if (status === "OUT_OF_STOCK") return <Badge variant="danger" label="Out of Stock" />;
  if (status === "LOW") return <Badge variant="warning" label="Low Stock" />;
  return <Badge variant="success" label="In Stock" />;
}

// ─── Product grid card ────────────────────────────────────────────────────────

function ProductCard({ product, onClick }: { product: ApiProduct; onClick: () => void }) {
  const status = getStockStatus(product);
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-white text-left shadow-card transition-shadow hover:shadow-dropdown",
        status === "LOW" && "border-warning/40",
        status === "OUT_OF_STOCK" && "border-danger/40",
        status === "IN_STOCK" && "border-surface-border",
      )}
    >
      {/* Image placeholder */}
      <div
        className={cn(
          "flex h-28 w-full items-center justify-center",
          status === "LOW" && "bg-warning-bg",
          status === "OUT_OF_STOCK" && "bg-danger-bg",
          status === "IN_STOCK" && "bg-surface-raised",
        )}
      >
        <Package
          className={cn(
            "h-10 w-10",
            status === "LOW" && "text-warning/40",
            status === "OUT_OF_STOCK" && "text-danger/40",
            status === "IN_STOCK" && "text-navy/20",
          )}
        />
      </div>

      {/* Info */}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div>
          <p className="text-xs text-navy/40">{product.sku}</p>
          <p className="mt-0.5 text-sm font-semibold leading-snug text-navy line-clamp-2">
            {product.name}
          </p>
        </div>
        <div className="mt-auto flex items-end justify-between gap-1">
          <p className="text-base font-bold text-navy">
            ${parseFloat(String(product.pricePerUnit)).toFixed(2)}
            <span className="ml-1 text-xs font-normal text-navy/40">
              / {product.unit}
            </span>
          </p>
        </div>
        <StockBadge status={status} />
      </div>
    </button>
  );
}

// ─── Table column defs ────────────────────────────────────────────────────────

const tableColumns: ColumnDef<ApiProduct, unknown>[] = [
  {
    accessorKey: "name",
    header: "Product",
    cell: ({ row }) => (
      <div>
        <p className="font-medium text-navy">{row.original.name}</p>
        <p className="text-xs text-navy/40">{row.original.sku}</p>
      </div>
    ),
  },
  {
    accessorKey: "category",
    header: "Category",
    cell: ({ row }) => <span className="text-navy/70">{row.original.category}</span>,
  },
  {
    accessorKey: "unit",
    header: "Unit",
    enableSorting: false,
    cell: ({ row }) => <span className="text-navy/60">{row.original.unit}</span>,
  },
  {
    accessorKey: "pricePerUnit",
    header: "Price",
    cell: ({ row }) => (
      <span className="font-medium text-navy">
        ${parseFloat(String(row.original.pricePerUnit)).toFixed(2)}
      </span>
    ),
  },
  {
    accessorKey: "currentStock",
    header: "Stock",
    cell: ({ row }) => {
      const status = getStockStatus(row.original);
      return (
        <div className="flex items-center gap-2">
          <StockBadge status={status} />
          <span className="text-xs text-navy/50">
            {Number(row.original.currentStock).toFixed(0)} {row.original.unit}
          </span>
        </div>
      );
    },
  },
];

// ─── Create product modal ──────────────────────────────────────────────────────

function CreateProductModal({
  onClose,
  onCreate,
  isLoading,
}: {
  onClose: () => void;
  onCreate: (data: Record<string, unknown>) => Promise<unknown>;
  isLoading: boolean;
}) {
  const [form, setForm] = React.useState({
    name: "", sku: "", barcode: "", unit: "", pricePerUnit: "", category: "", description: "",
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onCreate({
      name: form.name,
      sku: form.sku || undefined,
      barcode: form.barcode || undefined,
      unit: form.unit,
      pricePerUnit: form.pricePerUnit,
      category: form.category || undefined,
      description: form.description || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-surface-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">New Product</h2>
          <button onClick={onClose} className="text-navy/40 hover:text-navy transition-colors">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-navy">Name *</label>
              <input required value={form.name} onChange={(e) => set("name", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">SKU</label>
              <input value={form.sku} onChange={(e) => set("sku", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Barcode</label>
              <input value={form.barcode} onChange={(e) => set("barcode", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Unit *</label>
              <input required placeholder="e.g. case, kg, unit" value={form.unit} onChange={(e) => set("unit", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Price per unit *</label>
              <input required type="number" min="0" step="0.01" value={form.pricePerUnit} onChange={(e) => set("pricePerUnit", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-navy">Category</label>
              <input value={form.category} onChange={(e) => set("category", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-navy">Description</label>
              <textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)}
                className="w-full resize-y rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={isLoading}>Create Product</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => { setTitle("Products"); }, [setTitle]);

  const [search, setSearch] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState("");
  const [stockFilter, setStockFilter] = React.useState("");
  const [viewMode, setViewMode] = React.useState<"grid" | "table">("grid");
  const [showCreate, setShowCreate] = React.useState(false);
  const createProduct = useCreateProduct();

  const { data: result, isLoading } = useProducts({
    search,
    category: categoryFilter || undefined,
    isActive: stockFilter === "OUT_OF_STOCK" ? false : undefined,
  });

  const productList: ApiProduct[] = result?.data ?? [];

  const categories = Array.from(
    new Set(productList.map((p) => p.category).filter(Boolean))
  ) as string[];

  const filtered = React.useMemo(() => {
    if (stockFilter === "IN_STOCK") return productList.filter((p) => getStockStatus(p) === "IN_STOCK");
    if (stockFilter === "LOW") return productList.filter((p) => getStockStatus(p) === "LOW");
    return productList;
  }, [productList, stockFilter]);

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Products"
        subtitle="Manage your product catalog"
        action={
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setShowCreate(true)}>
            New Product
          </Button>
        }
      />

      {/* Create product modal */}
      {showCreate && (
        <CreateProductModal
          onClose={() => setShowCreate(false)}
          onCreate={(data) =>
            createProduct.mutateAsync(data, {
              onSuccess: () => {
                setShowCreate(false);
                toast({ title: "Product created", variant: "success" });
              },
              onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "error" }),
            })
          }
          isLoading={createProduct.isPending}
        />
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by name or SKU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-44">
          <Select
            options={[
              { value: "", label: "All Categories" },
              ...categories.map((c) => ({ value: c, label: c })),
            ]}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          />
        </div>
        <div className="w-40">
          <Select
            options={[
              { value: "", label: "All Stock" },
              { value: "IN_STOCK", label: "In Stock" },
              { value: "LOW", label: "Low Stock" },
              { value: "OUT_OF_STOCK", label: "Out of Stock" },
            ]}
            value={stockFilter}
            onChange={(e) => setStockFilter(e.target.value)}
          />
        </div>

        {/* View toggle */}
        <div className="ml-auto flex items-center rounded-lg border border-surface-border bg-white p-1">
          <button
            onClick={() => setViewMode("grid")}
            className={cn(
              "rounded p-1.5 transition-colors",
              viewMode === "grid"
                ? "bg-navy text-white"
                : "text-navy/40 hover:text-navy",
            )}
            title="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={cn(
              "rounded p-1.5 transition-colors",
              viewMode === "table"
                ? "bg-navy text-white"
                : "text-navy/40 hover:text-navy",
            )}
            title="Table view"
          >
            <LayoutList className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-surface-border bg-white py-12 text-center">
          <p className="text-sm text-navy/40">No products match your filters.</p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              onClick={() => router.push(`/products/${p.id}`)}
            />
          ))}
        </div>
      ) : (
        <Table
          data={filtered}
          columns={tableColumns}
          onRowClick={(row) => router.push(`/products/${row.original.id}`)}
        />
      )}
    </div>
  );
}
