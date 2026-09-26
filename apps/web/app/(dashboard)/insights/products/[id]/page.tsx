"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader, Card } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useProduct } from "@/lib/api/products";
import { displayProductName } from "@/lib/product-display";
import { ProductFinder } from "@/components/insights/ProductFinder";
import { ProductInsightsPanel } from "@/components/insights/ProductInsightsPanel";

/**
 * #2119 / plan §B: one product's sales insights. The product identity, loading and unknown-id
 * states come from the product read; everything else — KPI tiles, trend, buyers, sold lines,
 * CSV — is `ProductInsightsPanel` on #2179's accrual-net API
 * (`GET /analytics/products/:id/insights`, `/sales`, `/insights.csv`).
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
        <ProductInsightsPanel productId={id} />
      )}
    </div>
  );
}
