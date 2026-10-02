"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, FileText, PackageCheck, Pencil, Send } from "lucide-react";
import { Button, EmptyState, PageHeader, Skeleton, useToast } from "@routeflow/ui/web";
import { poDisplayTotal } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { fmtCalendarDate, fmtDate } from "@/lib/formatting";
import { usePageTitle } from "@/lib/page-title-context";
import { usePlanFlag } from "@/lib/api/plan-flags";
import { planFlagVisible } from "@/lib/plan-gated-nav";
import { useProducts } from "@/lib/api/products";
import {
  useClosePurchaseOrder,
  usePurchaseOrder,
  useSendPurchaseOrder,
  useSuppliers,
} from "@/lib/api/inventory";
import { PurchaseOrderReadOnlyLines } from "../../inventory/_components/PurchaseOrderReadOnlyLines";
import { PurchaseOrdersEditModal } from "../../inventory/_components/PurchaseOrdersEditModal";
import { ReceivePOModal } from "../../inventory/_components/PurchaseOrdersReceiveModal";
import { poStatusBadge } from "../../inventory/_components/PurchaseOrdersTab";
import {
  linePack,
  type PurchaseOrder,
  type Supplier,
} from "../../inventory/_components/purchase-orders-shared";
import { poActions } from "./po-detail-logic";

const errorStatus = (e: unknown): number | undefined =>
  (e as { response?: { status?: number } } | null)?.response?.status;

/** The purchase order detail page: header, lines, receipts history, linked bill and the actions
 *  the list row already offers (Edit / Send / Receive / Close) through the same modals. */
export function PurchaseOrderDetail({ id }: { id: string }) {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch } = usePurchaseOrder(id);
  const po = data as PurchaseOrder | undefined;
  const { data: suppliers = [] } = useSuppliers();
  const { data: productsData } = useProducts({ isActive: true, limit: 0 });
  const billsFlag = usePlanFlag("flag.ap_bills");
  const sendPO = useSendPurchaseOrder();
  const closePO = useClosePurchaseOrder();
  const [editing, setEditing] = React.useState(false);
  const [receiving, setReceiving] = React.useState(false);

  React.useEffect(() => {
    setTitle(po?.poNumber ?? "Purchase Order");
  }, [setTitle, po?.poNumber]);

  const products = (productsData?.data ?? []).map((p: any) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    unitsPerBox: p.unitsPerBox ?? null,
  }));
  const catalogById = React.useMemo(
    () => new Map(products.map((p: { id: string }) => [p.id, p])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [productsData],
  ) as Map<string, { id: string; name?: string; unitsPerBox?: number | null }>;

  if (isLoading) {
    return (
      <div className="space-y-3 p-6" aria-busy="true">
        <Skeleton shape="block" height={48} />
        <Skeleton shape="block" height={160} />
        <Skeleton shape="block" height={96} />
      </div>
    );
  }

  if (isError || !po) {
    const notFound = errorStatus(error) === 404;
    return (
      <div className="p-6">
        <EmptyState
          title={notFound ? "Purchase order not found" : "Couldn't load this purchase order."}
          description={
            notFound
              ? "It may have been removed, or the link is wrong."
              : "Check your connection and try again."
          }
          action={
            notFound ? (
              <Link href="/purchase-orders" className="text-sm text-brand-500 hover:underline">
                Back to purchase orders
              </Link>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => refetch()}>
                Retry
              </Button>
            )
          }
        />
      </div>
    );
  }

  const actions = poActions(po.status);
  const bill = po.vendorBill ?? null;
  const canOpenBill = !!bill && planFlagVisible(billsFlag);
  const receipts = po.receipts ?? [];
  // A boxed product's cost is per PIECE: show it at 4dp like the lines table does.
  const boxedProductIds = new Set(
    (po.items ?? [])
      .filter((i) => linePack(i, Number(catalogById.get(i.productId)?.unitsPerBox ?? 0)) > 1)
      .map((i) => i.productId),
  );

  return (
    <div className="space-y-5 p-6">
      <Link
        href="/purchase-orders"
        className="inline-flex items-center gap-1 text-sm text-navy/70 hover:text-navy"
      >
        <ArrowLeft className="h-4 w-4" /> Back to purchase orders
      </Link>

      <PageHeader
        title={po.poNumber}
        subtitle={po.supplier?.name ?? undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {poStatusBadge(po.status)}
            {actions.edit && (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Pencil className="h-4 w-4" />}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            )}
            {actions.send && (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Send className="h-4 w-4" />}
                loading={sendPO.isPending}
                onClick={() =>
                  sendPO.mutate(po.id, {
                    onSuccess: () => toast({ title: "PO sent.", variant: "success" }),
                    onError: () => toast({ title: "Failed to send PO.", variant: "error" }),
                  })
                }
              >
                Send
              </Button>
            )}
            {actions.receive && (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<PackageCheck className="h-4 w-4" />}
                onClick={() => setReceiving(true)}
              >
                Receive
              </Button>
            )}
            {actions.close && (
              <Button
                size="sm"
                variant="secondary"
                loading={closePO.isPending}
                onClick={() =>
                  closePO.mutate(po.id, {
                    onSuccess: () => toast({ title: "PO closed.", variant: "success" }),
                    onError: () => toast({ title: "Failed to close PO.", variant: "error" }),
                  })
                }
              >
                Close
              </Button>
            )}
          </div>
        }
      />

      <dl className="grid grid-cols-2 gap-4 rounded-xl border border-surface-border bg-white p-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs font-medium text-navy/70">Supplier</dt>
          <dd className="font-medium text-navy">{po.supplier?.name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-navy/70">Expected</dt>
          <dd className="text-navy">{po.expectedDate ? fmtCalendarDate(po.expectedDate) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-navy/70">Total</dt>
          <dd className="font-medium text-navy" data-testid="po-total">
            {formatMoney(poDisplayTotal(po))}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-navy/70">Bill</dt>
          <dd className="text-navy">
            {bill ? (
              <div className="space-y-0.5">
                {bill.status === "VOID" && (
                  <span className="block text-xs font-medium text-amber-700">Bill voided</span>
                )}
                {canOpenBill ? (
                  <Link
                    href={`/vendor-bills/${bill.id}`}
                    className="inline-flex items-center gap-1 text-brand-500 hover:underline"
                  >
                    <FileText className="h-4 w-4" /> Open bill {bill.billNumber}
                  </Link>
                ) : (
                  <span>
                    {bill.status === "VOID" ? "Voided" : "Billed"} ({bill.billNumber})
                  </span>
                )}
              </div>
            ) : (
              <span className="text-navy/70">No bill yet</span>
            )}
          </dd>
        </div>
      </dl>

      {po.notes && (
        <p className="text-sm text-navy/70">
          <span className="font-medium">Notes:</span> {po.notes}
        </p>
      )}

      <section aria-labelledby="po-lines-h" className="space-y-2">
        <h3 id="po-lines-h" className="text-base font-semibold text-navy">
          Lines
        </h3>
        <PurchaseOrderReadOnlyLines items={po.items ?? []} catalogById={catalogById} />
      </section>

      <section aria-labelledby="po-receipts-h" className="space-y-2">
        <h3 id="po-receipts-h" className="text-base font-semibold text-navy">
          Receipts
        </h3>
        {receipts.length === 0 ? (
          <p className="text-sm text-navy/70">Nothing received yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-surface-border bg-white">
            <table className="w-full text-xs">
              <thead className="bg-surface-raised text-navy/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-left font-medium">Entry</th>
                  <th className="px-3 py-2 text-right font-medium">Qty (pcs)</th>
                  <th className="px-3 py-2 text-right font-medium">Unit cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 text-navy/70">{fmtDate(r.at)}</td>
                    <td className="px-3 py-2 font-medium text-navy">{r.productName ?? "—"}</td>
                    <td className="px-3 py-2 text-navy/70">
                      {r.kind === "REVERSAL" ? "Correction" : "Received"}
                    </td>
                    <td className="px-3 py-2 text-right text-navy/70">{r.quantity}</td>
                    <td className="px-3 py-2 text-right text-navy/70">
                      {r.unitCost == null
                        ? "—"
                        : `$${r.unitCost.toFixed(boxedProductIds.has(r.productId) ? 4 : 2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <PurchaseOrdersEditModal
          po={po}
          suppliers={suppliers as Supplier[]}
          products={products}
          onClose={() => setEditing(false)}
        />
      )}
      {receiving && (
        <ReceivePOModal po={po} products={products} onClose={() => setReceiving(false)} />
      )}
    </div>
  );
}
