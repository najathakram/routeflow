"use client";

import * as React from "react";
import { PageHeader } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { ProductFinder } from "@/components/insights/ProductFinder";

/**
 * #2119 / plan §A9-A10: the one shared entry into product insights — camera
 * scan through the existing barcode resolve ladder, or a typeahead search.
 * Customer insights (§C) are reached from the customer page (#2121).
 */
export default function InsightsPage() {
  const { setTitle } = usePageTitle();

  React.useEffect(() => {
    setTitle("Insights");
  }, [setTitle]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Insights"
        subtitle="Scan or search a product to see its sales history and demand trend."
      />
      <ProductFinder />
    </div>
  );
}
