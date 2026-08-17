"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge, Button, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useStockMovements } from "@/lib/api/inventory";
import { useProducts } from "@/lib/api/products";
import { useUrlPage, useClampPage } from "@/lib/hooks/useUrlPage";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  PURCHASE: "Purchase",
  SALE: "Sale",
  ADJUSTMENT: "Adjustment",
  RETURN: "Return",
  WRITE_OFF: "Write-Off",
};

const MOVEMENT_TYPE_VARIANTS: Record<string, "success" | "danger" | "neutral" | "warning"> = {
  PURCHASE: "success",
  SALE: "danger",
  ADJUSTMENT: "neutral",
  RETURN: "warning",
  WRITE_OFF: "neutral",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MovementsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Stock Movements");
  }, [setTitle]);

  const searchParams = useSearchParams();
  const initialProduct = searchParams.get("product") ?? "";

  const [filters, setFilters] = React.useState({
    productId: initialProduct,
    type: "",
    from: "",
    to: "",
  });
  const [page, setPage] = useUrlPage();

  const { data: productsData } = useProducts();
  const products = productsData?.data ?? [];

  const { data, isLoading } = useStockMovements({
    productId: filters.productId || undefined,
    type: filters.type || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    page,
    limit: 50,
  });

  const movements = data?.data ?? [];
  const meta = data?.meta;
  useClampPage(setPage, page, meta?.totalPages);

  const handleFilterChange = (key: string, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  return (
    <div className="space-y-5 p-6">
      <Link
        href="/inventory"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Inventory
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-navy">Stock Movements</h1>
        {meta && (
          <p className="text-sm text-navy/70">
            {meta.total} record{meta.total !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={filters.productId}
          onChange={(e) => handleFilterChange("productId", e.target.value)}
          className="rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All products</option>
          {products.map((p: any) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          value={filters.type}
          onChange={(e) => handleFilterChange("type", e.target.value)}
          className="rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All types</option>
          {Object.entries(MOVEMENT_TYPE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2">
          <input
            type="date"
            value={filters.from}
            onChange={(e) => handleFilterChange("from", e.target.value)}
            className="rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <span className="text-sm text-navy/70">to</span>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => handleFilterChange("to", e.target.value)}
            className="rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {(filters.productId || filters.type || filters.from || filters.to) && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setFilters({ productId: "", type: "", from: "", to: "" });
              setPage(1);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="p-8 text-center text-navy/70">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-surface-border">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
              <tr>
                {[
                  "Date",
                  "Product",
                  "Type",
                  "Quantity",
                  "Unit Cost",
                  "Supplier",
                  "Reference",
                  "Notes",
                  "By",
                ].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {movements.map((m: any) => {
                const qty = Number(m.quantity);
                const isNegative = qty < 0;
                return (
                  <tr key={m.id} className="transition-colors hover:bg-surface-raised/50">
                    <td className="px-4 py-3 text-navy/70 whitespace-nowrap">
                      {formatDate(m.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-navy">{m.product?.name}</p>
                      {m.product?.sku && (
                        <p className="font-mono text-xs text-navy/70">{m.product.sku}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={MOVEMENT_TYPE_VARIANTS[m.type] ?? "secondary"}
                        label={MOVEMENT_TYPE_LABELS[m.type] ?? m.type}
                      />
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 font-mono font-medium",
                        isNegative ? "text-danger" : "text-success",
                      )}
                    >
                      {isNegative ? "" : "+"}
                      {qty.toFixed(3)} {m.product?.unit}
                    </td>
                    <td className="px-4 py-3 text-navy/70">
                      {m.unitCost != null ? `$${Number(m.unitCost).toFixed(4)}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-navy/70">{m.supplier?.name ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-navy/70">{m.reference ?? "—"}</td>
                    <td className="px-4 py-3 text-navy/70">{m.notes ?? "—"}</td>
                    <td className="px-4 py-3 text-navy/70">{m.performedBy?.username ?? "—"}</td>
                  </tr>
                );
              })}
              {movements.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-navy/70">
                    No movements found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">
            Page {meta.page} of {meta.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={page >= meta.totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
