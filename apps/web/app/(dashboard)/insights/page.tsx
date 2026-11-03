"use client";

import * as React from "react";
import { PageHeader } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { ProductFinder } from "@/components/insights/ProductFinder";

/**
 * #2119 / SA-1087 PR-2: the one shared entry into product insights — camera scan through the
 * existing barcode resolve ladder, or a typeahead search. Products only; customer insights are
 * parked. Reached from Analytics and the command palette, not the sidebar.
 */
export default function InsightsPage() {
  const { setTitle } = usePageTitle();

  React.useEffect(() => {
    setTitle("Insights");
  }, [setTitle]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Product insights"
        subtitle="Scan or search a product to see how it sells over time."
      />
      <ProductFinder />
    </div>
  );
}
