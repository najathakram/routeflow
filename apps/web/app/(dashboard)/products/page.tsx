"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Package, LayoutGrid, LayoutList, RefreshCw } from "lucide-react";
import { PageHeader, Table, Badge, Button, Select, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { useProducts } from "@/lib/api/products";
import { useZohoSync, useZohoStatus } from "@/lib/api/zoho";

// ─── Types ────────────────────────────────────────────────────────────────────

type StockStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK";

interface ApiProduct {
  id: string;
  name: string;
  sku?: string;
  category?: string;
  unit: string;
  pricePerUnit: string;
  isActive: boolean;
  lowStock: boolean;
  hasLocalOverride: boolean;
  description?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStockStatus(p: ApiProduct): StockStatus {
  if (!p.isActive) return "OUT_OF_STOCK";
  if (p.lowStock) return "LOW";
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
    accessorKey: "lowStock",
    header: "Stock",
    cell: ({ row }) => {
      const status = getStockStatus(row.original);
      return <StockBadge status={status} />;
    },
  },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => { setTitle("Products"); }, [setTitle]);

  const isLowStockParam = searchParams.get("lowStock") === "true";

  const [search, setSearch] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState("");
  const [stockFilter, setStockFilter] = React.useState(isLowStockParam ? "LOW" : "");
  const [viewMode, setViewMode] = React.useState<"grid" | "table">("grid");

  const syncMutation = useZohoSync();
  const { data: zohoStatus } = useZohoStatus();

  const { data: result, isLoading } = useProducts({
    search,
    category: categoryFilter || undefined,
    lowStock: stockFilter === "LOW" ? true : undefined,
    isActive: stockFilter === "OUT_OF_STOCK" ? false : undefined,
  });

  const productList: ApiProduct[] = result?.data ?? [];

  const categories = Array.from(
    new Set(productList.map((p) => p.category).filter(Boolean))
  ) as string[];

  const filtered = React.useMemo(() => {
    if (stockFilter === "IN_STOCK") {
      return productList.filter((p) => getStockStatus(p) === "IN_STOCK");
    }
    return productList;
  }, [productList, stockFilter]);

  const handleSync = () => {
    syncMutation.mutate(undefined, {
      onSuccess: (result) => {
        toast({
          title: "Sync complete",
          description: `${result.synced ?? 0} products synced from Zoho.`,
          variant: "success",
        });
      },
      onError: (err: Error) => {
        toast({
          title: "Sync failed",
          description: err.message ?? "Failed to sync from Zoho.",
          variant: "error",
        });
      },
    });
  };

  const lastSyncTime = zohoStatus?.lastSync
    ? new Date(zohoStatus.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "Never";

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Products"
        subtitle={`Last synced: ${lastSyncTime}`}
        action={
          <Button
            leftIcon={<RefreshCw className={cn("h-4 w-4", syncMutation.isPending && "animate-spin")} />}
            loading={syncMutation.isPending}
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
