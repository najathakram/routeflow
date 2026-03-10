"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Package, LayoutGrid, LayoutList, RefreshCw } from "lucide-react";
import { PageHeader, Table, Badge, Button, Select, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import {
  products,
  categories,
  getStockStatus,
  type Product,
  type StockStatus,
} from "@/mocks/products";

// ─── Stock badge ──────────────────────────────────────────────────────────────

function StockBadge({ status, level }: { status: StockStatus; level: number }) {
  if (status === "OUT_OF_STOCK") return <Badge variant="danger" label="Out of Stock" />;
  if (status === "LOW") return <Badge variant="warning" label={`Low · ${level}`} />;
  return <Badge variant="success" label={`${level} in stock`} />;
}

// ─── Product grid card ────────────────────────────────────────────────────────

function ProductCard({ product, onClick }: { product: Product; onClick: () => void }) {
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
            ${product.price.toFixed(2)}
            <span className="ml-1 text-xs font-normal text-navy/40">
              / {product.unitOfMeasure}
            </span>
          </p>
        </div>
        <StockBadge status={status} level={product.stockLevel} />
      </div>
    </button>
  );
}

// ─── Table column defs ────────────────────────────────────────────────────────

const tableColumns: ColumnDef<Product, unknown>[] = [
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
    accessorKey: "unitOfMeasure",
    header: "Unit",
    enableSorting: false,
    cell: ({ row }) => <span className="text-navy/60">{row.original.unitOfMeasure}</span>,
  },
  {
    accessorKey: "price",
    header: "Price",
    cell: ({ row }) => (
      <span className="font-medium text-navy">${row.original.price.toFixed(2)}</span>
    ),
  },
  {
    accessorKey: "stockLevel",
    header: "Stock",
    cell: ({ row }) => {
      const status = getStockStatus(row.original);
      return <StockBadge status={status} level={row.original.stockLevel} />;
    },
  },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductsPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => { setTitle("Products"); }, [setTitle]);

  const [search, setSearch] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState("");
  const [stockFilter, setStockFilter] = React.useState("");
  const [viewMode, setViewMode] = React.useState<"grid" | "table">("grid");
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [lastSyncTime, setLastSyncTime] = React.useState("Today at 9:14 AM");

  const filtered = React.useMemo(() => {
    const q = search.toLowerCase();
    return products.filter((p) => {
      const matchSearch =
        !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
      const matchCategory = !categoryFilter || p.category === categoryFilter;
      const matchStock =
        !stockFilter || getStockStatus(p) === stockFilter;
      return matchSearch && matchCategory && matchStock;
    });
  }, [search, categoryFilter, stockFilter]);

  const handleSync = async () => {
    setIsSyncing(true);
    await new Promise((r) => setTimeout(r, 1500));
    setIsSyncing(false);
    setLastSyncTime("Just now");
    toast({
      title: "Sync complete",
      description: `${products.length} products updated from Zoho.`,
      variant: "success",
    });
  };

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Products"
        subtitle={`Last synced: ${lastSyncTime}`}
        action={
          <Button
            leftIcon={<RefreshCw className={cn("h-4 w-4", isSyncing && "animate-spin")} />}
            loading={isSyncing}
            onClick={handleSync}
            variant="secondary"
          >
            Sync from Zoho
          </Button>
        }
      />

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
      {filtered.length === 0 ? (
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
