"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { PageHeader, Card } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useProduct } from "@/lib/api/products";
import { displayProductName } from "@/lib/product-display";
import { ProductFinder } from "@/components/insights/ProductFinder";

/**
 * #2119 / plan §B: route shell only. `GET /analytics/products/:id/insights`
 * (#2105-a / #2118) hasn't landed yet, so this renders what needs no new
 * API — the product identity, loading, and unknown-id states — and a
 * placeholder where the KPI tiles / trend / buyers table / CSV land once
 * that DTO layer (`packages/types/api/analytics-insights.ts`) ships.
 */
export default function ProductInsightsPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { setTitle } = usePageTitle();
  const { data: product, isLoading, isError } = useProduct(id);

  React.useEffect(() => {
    setTitle(product ? `Insights — ${displayProductName(product)}` : "Insights");
  }, [setTitle, product]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={product ? displayProductName(product) : "Product insights"}
        subtitle={product?.sku ? `SKU ${product.sku}` : undefined}
        action={
          <Link
            href="/insights"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-navy/70 hover:text-navy"
          >
            <ArrowLeft size={16} />
            Back to finder
          </Link>
        }
      />

      {isLoading ? (
        <Card className="p-6 text-sm text-navy/70">Loading…</Card>
      ) : isError || !product ? (
        <Card className="space-y-4 p-6">
          <p className="text-sm text-navy">No product found for that id.</p>
          <ProductFinder />
        </Card>
      ) : (
        <Card className="flex flex-col items-center gap-2 p-10 text-center text-sm text-navy/70">
          <BarChart3 size={28} className="text-navy/30" />
          <p className="font-medium text-navy">Insights are on the way</p>
          <p>
            Sales history, demand trend and buyer breakdown for this product land once the insights
            API (#2105-a) ships.
          </p>
        </Card>
      )}
    </div>
  );
}
