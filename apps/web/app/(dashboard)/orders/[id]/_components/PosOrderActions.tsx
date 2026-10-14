"use client";

import * as React from "react";
import { Button, useToast } from "@routeflow/ui/web";
import {
  Bell,
  CheckCircle2,
  Circle,
  FileText,
  Package,
  Printer,
  Truck,
  Wallet,
} from "lucide-react";
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
          {i === current && <Circle className="h-3 w-3" aria-hidden />}
          {s.label}
          {s.done && <span className="sr-only"> (completed)</span>}
          {i === current && <span className="sr-only"> (next step)</span>}
        </li>
      ))}
    </ol>
  );
}

/** Which "move off pickup" buttons a POS order offers, from the ROUTE / SHIP paths the account offers. */
export interface PosMoveOptions {
  /** The "Switch to delivery" button's target path, or null when it is not offered (a ship-only account). */
  delivery: "ROUTE" | "SHIP" | null;
  /** The "Ship by carrier…" button (always moves to SHIP). */
  ship: boolean;
}

/**
 * Both paths: the two buttons ("Switch to delivery" is the route, "Ship by carrier…" the carrier). One path:
 * its own single button. Neither (a pickup-only account): today's lone "Switch to delivery" to the account default.
 */
export function posMoveOptions(
  methods: readonly string[],
  formDefault: "ROUTE" | "SHIP",
): PosMoveOptions {
  const route = methods.includes("ROUTE");
  const ship = methods.includes("SHIP");
  if (route) return { delivery: "ROUTE", ship };
  if (ship) return { delivery: null, ship: true };
  return { delivery: formDefault, ship: false };
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
  moveOptions = { delivery: "ROUTE", ship: false },
  onMove,
}: {
  order: PosOrder;
  orderId: string;
  status: string;
  onHandOver: () => void;
  /** "Ready for pickup": the customer notification (the order's OUT_FOR_DELIVERY step, kept out of the 3-step layout). */
  onReadyForPickup: () => void;
  readyPending?: boolean;
  moveOptions?: PosMoveOptions;
  /** Moves the order off pickup (the page asks first): "Switch to delivery" / "Ship by carrier…". */
  onMove: (path: "ROUTE" | "SHIP") => void;
}) {
  const { toast } = useToast();
  const createInvoice = useCreateInvoiceFromOrder({ localErrorToast: true });
  const invoices = invoicesOf(order);
  const firstInvoice = invoices[0];

  const switchToDelivery = (
    <>
      {moveOptions.delivery && (
        <ActionTier tier="secondary">
          <Button
            size="sm"
            className="h-11"
            variant="secondary"
            leftIcon={<Truck className="h-4 w-4" />}
            onClick={() => moveOptions.delivery && onMove(moveOptions.delivery)}
          >
            {POS_COPY.switchToDelivery}
          </Button>
        </ActionTier>
      )}
      {moveOptions.ship && (
        <ActionTier tier="secondary">
          <Button
            size="sm"
            className="h-11"
            variant="secondary"
            leftIcon={<Package className="h-4 w-4" />}
            onClick={() => onMove("SHIP")}
          >
            {POS_COPY.shipByCarrier}
          </Button>
        </ActionTier>
      )}
    </>
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
