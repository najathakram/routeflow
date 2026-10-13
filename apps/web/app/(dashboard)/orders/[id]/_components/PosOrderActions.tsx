"use client";

import * as React from "react";
import { Button, useToast } from "@routeflow/ui/web";
import { Bell, CheckCircle2, FileText, Printer, Truck, Wallet } from "lucide-react";
import type { Order } from "@/lib/api/orders";
import { useCreateInvoiceFromOrder } from "@/lib/api/invoices";
import { codedToastCopy } from "@/lib/generic-toast-copy";
import { POS_COPY } from "@/lib/pos-copy";
import { useOrderStatusLabel } from "@/components/OrderStatusBadge";
import { ActionTier } from "./ActionTier";
import { PickupHandOverButton } from "./PickupHandOver";

type PosOrder = Pick<Order, "invoices">;

/** A VOID invoice is not an invoice for the order's purposes (no step done, nothing to pay or print). */
const invoicesOf = (order: PosOrder) => (order.invoices ?? []).filter((i) => i.status !== "VOID");

/**
 * POS-mode order page (SA-763r P-2): Confirmed -> Invoice (draft) -> Handed over. There is no Out-for-delivery
 * step: hand-over IS the completion. The invoice step reads "(draft)" until every invoice has been issued.
 */
export function PosProgress({ order, status }: { order: PosOrder; status: string }) {
  if (status === "DRAFT" || status === "CANCELLED") return null;
  const invoices = invoicesOf(order);
  const confirmed =
    status === "CONFIRMED" || status === "OUT_FOR_DELIVERY" || status === "DELIVERED";
  const handedOver = status === "DELIVERED";
  const hasInvoice = invoices.length > 0;
  const invoiceIsDraft = !hasInvoice || invoices.some((i) => i.status === "DRAFT");
  const steps = [
    { key: "confirmed", label: POS_COPY.stepConfirmed, done: confirmed },
    {
      key: "invoice",
      label: invoiceIsDraft ? POS_COPY.stepInvoiceDraft : POS_COPY.stepInvoice,
      done: hasInvoice,
    },
    { key: "handed", label: POS_COPY.stepHandedOver, done: handedOver },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol
      aria-label="Order progress"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium"
    >
      {steps.map((s, i) => (
        <li
          key={s.key}
          aria-current={i === current ? "step" : undefined}
          data-done={s.done ? "true" : "false"}
          className={
            s.done
              ? "inline-flex items-center gap-1 rounded-full bg-success-bg px-2.5 py-1 text-success"
              : i === current
                ? "inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-brand-700 ring-1 ring-brand-200"
                : "inline-flex items-center gap-1 rounded-full bg-navy/5 px-2.5 py-1 text-navy/70"
          }
        >
          {s.done && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
          {s.label}
          {s.done && <span className="sr-only"> (completed)</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * The action-bar slice of a POS order: ONE primary per state. PENDING offers only the switch (its primary is the
 * page's existing Confirm Order); CONFIRMED: Create invoice, then Hand over; DELIVERED: Record payment / Print.
 * Edit order and the status demotions stay where the page already renders them.
 */
export function PosOrderActions({
  order,
  orderId,
  status,
  onHandOver,
  onReadyForPickup,
  readyPending,
  onSwitchToDelivery,
}: {
  order: PosOrder;
  orderId: string;
  status: string;
  onHandOver: () => void;
  /** "Ready for pickup": the customer notification (the order's OUT_FOR_DELIVERY step, kept out of the 3-step layout). */
  onReadyForPickup: () => void;
  readyPending?: boolean;
  onSwitchToDelivery: () => void;
}) {
  const { toast } = useToast();
  const createInvoice = useCreateInvoiceFromOrder({ localErrorToast: true });
  const invoices = invoicesOf(order);
  const firstInvoice = invoices[0];

  const switchToDelivery = (
    <ActionTier tier="secondary">
      <Button
        size="sm"
        className="h-11"
        variant="secondary"
        leftIcon={<Truck className="h-4 w-4" />}
        onClick={onSwitchToDelivery}
      >
        {POS_COPY.switchToDelivery}
      </Button>
    </ActionTier>
  );

  if (status === "PENDING") return switchToDelivery;

  const readyForPickup = (
    <ActionTier tier="secondary">
      <Button
        size="sm"
        className="h-11"
        variant="secondary"
        leftIcon={<Bell className="h-4 w-4" />}
        onClick={onReadyForPickup}
        loading={readyPending}
      >
        {POS_COPY.readyForPickup}
      </Button>
    </ActionTier>
  );

  if (status === "CONFIRMED") {
    const handOver = (primary: boolean) => (
      <ActionTier tier={primary ? "primary" : "secondary"}>
        <Button
          size="sm"
          className="h-11"
          variant={primary ? undefined : "secondary"}
          leftIcon={<CheckCircle2 className="h-4 w-4" />}
          onClick={onHandOver}
        >
          {POS_COPY.handOver}
        </Button>
      </ActionTier>
    );
    return (
      <>
        {firstInvoice ? (
          handOver(true)
        ) : (
          <>
            <ActionTier tier="primary">
              <Button
                size="sm"
                className="h-11"
                leftIcon={<FileText className="h-4 w-4" />}
                loading={createInvoice.isPending}
                onClick={() =>
                  createInvoice.mutate(orderId, {
                    onSuccess: () => toast({ title: POS_COPY.invoiceCreated, variant: "success" }),
                    onError: (err) =>
                      toast({
                        title: codedToastCopy(err) ?? POS_COPY.invoiceFailed,
                        variant: "error",
                      }),
                  })
                }
              >
                {POS_COPY.createInvoice}
              </Button>
            </ActionTier>
            {handOver(false)}
          </>
        )}
        {readyForPickup}
        {switchToDelivery}
      </>
    );
  }

  if (status === "DELIVERED" && firstInvoice) {
    const paid = invoices.every((i) => i.status === "PAID");
    return (
      <ActionTier tier="primary">
        <Button
          size="sm"
          className="h-11"
          href={`/invoices/${firstInvoice.id}`}
          leftIcon={paid ? <Printer className="h-4 w-4" /> : <Wallet className="h-4 w-4" />}
        >
          {paid ? POS_COPY.printInvoice : POS_COPY.recordPayment}
        </Button>
      </ActionTier>
    );
  }
  return null;
}

/** Shown while editing a handed-over POS order: a cut never restocks. */
export function PosCutAfterHandOverNote() {
  return (
    <p
      role="note"
      className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200"
    >
      {POS_COPY.cutAfterHandOver}
    </p>
  );
}

/** CONFIRMED primary of a non-POS order: Out for Delivery / Mark shipped / Ready for pickup (moved out of page.tsx). */
export function ConfirmedPrimaryAction({
  fulfillPath,
  v2,
  onMarkShipped,
  pending,
}: {
  fulfillPath: string;
  v2: boolean;
  onMarkShipped: () => void;
  pending: boolean;
}) {
  const statusLabel = useOrderStatusLabel();
  return (
    <ActionTier tier="primary">
      <div className="flex flex-col items-start gap-1">
        <Button
          size="sm"
          className="h-11"
          variant={v2 ? undefined : "secondary"}
          leftIcon={<Truck className="h-4 w-4" />}
          onClick={onMarkShipped}
          loading={pending}
        >
          {fulfillPath === "SHIP"
            ? "Mark shipped"
            : fulfillPath === "PICKUP"
              ? "Ready for pickup"
              : "Out for Delivery"}
        </Button>
        {fulfillPath === "SHIP" && (
          <p className="text-[11px] text-navy/50">
            {`Sets the order to ${statusLabel("OUT_FOR_DELIVERY", "Out for Delivery", fulfillPath as "SHIP")} — the customer is notified it's on the way.`}
          </p>
        )}
      </div>
    </ActionTier>
  );
}

/** OUT_FOR_DELIVERY primary: the hand-over for PICKUP, otherwise Mark (as) Delivered (moved out of page.tsx). */
export function OutForDeliveryPrimary({
  fulfillPath,
  handOverLabel,
  onHandOver,
  onDeliver,
  pending,
}: {
  fulfillPath: string;
  handOverLabel?: string;
  onHandOver: () => void;
  onDeliver: () => void;
  pending: boolean;
}) {
  return (
    <ActionTier tier="primary">
      {fulfillPath === "PICKUP" ? (
        <PickupHandOverButton onOpen={onHandOver} label={handOverLabel} />
      ) : (
        <Button
          size="sm"
          className="h-11"
          leftIcon={<CheckCircle2 className="h-4 w-4" />}
          onClick={onDeliver}
          loading={pending}
        >
          {fulfillPath === "SHIP" ? "Mark delivered" : "Mark as Delivered"}
        </Button>
      )}
    </ActionTier>
  );
}
