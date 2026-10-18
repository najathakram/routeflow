"use client";

import * as React from "react";
import { PageHeader } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useSuppliers } from "@/lib/api/inventory";
import { useProducts } from "@/lib/api/products";
import { displayProductName } from "@/lib/product-display";
import { sellableOnly } from "@/lib/product-search-groups";
import { PurchaseOrdersTab } from "../inventory/_components/PurchaseOrdersTab";
import { ScanPoButton } from "./ScanPoButton";
import type { Supplier } from "../inventory/_components/purchase-orders-shared";

/** Thin route for purchase orders — the same list + modals the Inventory tab used to host. */
export default function PurchaseOrdersPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Purchase Orders");
  }, [setTitle]);

  const [highlightId, setHighlightId] = React.useState<string | null>(null);
  const { data: suppliers = [] } = useSuppliers();
  // KEPT AS FETCH-ALL (board note): `products` is threaded into PurchaseOrdersTab, whose create and
  // edit modals pick lines from a native <select> over every active product, and whose receive
  // modal and expanded rows look lines up by id. The modal-open state lives inside the tab
  // (inventory/_components, outside this page), so this page cannot defer the read the way
  // [id]/PurchaseOrderDetail.tsx does. Fix there: have the tab fetch the catalog only while a
  // create/edit modal is open (or search the server from the picker) and look lines up by id via
  // useProductsByIds (lib/api/purchase-order-products.ts); then drop this call.
  const { data: productsData } = useProducts({ isActive: true, limit: 0 });
  // A FAMILY is a container, never a purchasable line (B1215 C7); a variant reads "<Parent> - <Variant>".
  const products = sellableOnly<any>(productsData?.data ?? []).map((p: any) => ({
    id: p.id,
    name: displayProductName(p),
    sku: p.sku,
    unitsPerBox: p.unitsPerBox ?? null,
  }));

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Purchase Orders"
        subtitle="Orders you place with suppliers — draft, send, receive into stock."
      />
      <PurchaseOrdersTab
        suppliers={suppliers as Supplier[]}
        products={products}
        headerExtra={<ScanPoButton onDrafted={setHighlightId} />}
        highlightId={highlightId}
      />
    </div>
  );
}
