"use client";

import * as React from "react";
import Link from "next/link";
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
import { usePrintInvoice } from "@/lib/use-print-invoice";
import { useOrderStatusLabel } from "@/components/OrderStatusBadge";
import { ActionTier } from "./ActionTier";
import { PickupHandOverButton } from "./PickupHandOver";

type PosOrder = Pick<Order, "invoices"> & { fulfillPath?: string | null };

/** A VOID invoice is not an invoice for the order's purposes (no step done, nothing to pay or print). */
const invoicesOf = (order: PosOrder) => (order.invoices ?? []).filter((i) => i.status !== "VOID");

/** The Invoice card's Generate Invoice button, which the Invoice step in the progress row takes you to (SA-1066 F01). */
export const GENERATE_INVOICE_ID = "generate-invoice-button";

/** The Invoice card itself: where the step lands when no Generate Invoice button is drawn (only a voided invoice exists). */
export const INVOICE_CARD_ID = "invoice-card";

function goToGenerateInvoice() {
  const button = document.getElementById(GENERATE_INVOICE_ID);
  const target = button ?? document.getElementById(INVOICE_CARD_ID);
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  if (button) button.focus({ preventScroll: true });
}

/**
 * POS-mode order page (SA-763r P-2): Confirmed -> Invoice (draft) -> Handed over. There is no Out-for-delivery
 * step: hand-over IS the completion. The invoice step reads "(draft)" only while a draft invoice exists; with no
 * invoice at all it reads "Invoice" and is not done.
 */
export function PosProgress({ order, status }: { order: PosOrder; status: string }) {
  if (status === "DRAFT" || status === "CANCELLED") return null;
  const invoices = invoicesOf(order);
  const confirmed =
    status === "CONFIRMED" || status === "OUT_FOR_DELIVERY" || status === "DELIVERED";
  const handedOver = status === "DELIVERED";
  const hasInvoice = invoices.length > 0;
  const first = invoices[0];
  const invoiceIsDraft = hasInvoice && invoices.some((i) => i.status === "DRAFT");
  const steps = [
    { key: "confirmed", label: POS_COPY.stepConfirmed, done: confirmed },
    {
      key: "invoice",
      label: invoiceIsDraft ? POS_COPY.stepInvoiceDraft : POS_COPY.stepInvoice,
      done: hasInvoice,
    },
    {
      key: "handed",
      // W-1043: a PICKUP order that is Ready is not handed over yet; the step says what is true until DELIVERED.
      label:
        order.fulfillPath === "PICKUP" && status === "OUT_FOR_DELIVERY"
          ? POS_COPY.readyForPickup
          : POS_COPY.stepHandedOver,
      done: handedOver,
    },
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
          {s.key === "invoice" && !s.done ? (
            // F01: no invoice yet, so the step is the way to the card's Generate Invoice button. The padding is the
            // 44 x 44 tap area; the negative margins keep the pill's own size (24 high).
            <button
              type="button"
              onClick={goToGenerateInvoice}
              className="-mx-0.5 -my-[14px] min-w-11 px-0.5 py-[14px] text-center underline"
            >
              {s.label}
            </button>
          ) : (
            s.label
          )}
          {s.key === "invoice" && first?.invoiceNumber ? (
            // SA-1071 V1: the number once one exists, as a link to it ("+N" for a mixed order's other invoices). Same 44 px
            // tap area trick as the Generate step: the padding is the target, the negative margins keep the pill's size.
            <>
              {" "}
              <Link
                href={`/invoices/${first.id}`}
                className="-mx-0.5 -my-[14px] min-w-11 px-0.5 py-[14px] text-center underline"
              >
                {first.invoiceNumber}
              </Link>
              {invoices.length > 1 ? <span>+{invoices.length - 1}</span> : null}
            </>
          ) : null}
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
 * The action-bar slice of a POS order: ONE primary per state. PENDING: Ready for pickup (Confirm order, which the
 * page renders, steps down to secondary) and the switch; CONFIRMED: Create invoice, then Hand over; DELIVERED: Record payment / Print.
 * Edit order and the status demotions stay where the page already renders them.
 */
export function PosOrderActions({
  order,
  orderId,
  status,
  onHandOver,
  onReadyForPickup,
  readyPending,
  onConfirm,
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
  /** "Confirm order" for a PENDING POS order: Ready for pickup is its primary now, so Confirm lives here as a secondary. */
  onConfirm: () => void;
  moveOptions?: PosMoveOptions;
  /** Moves the order off pickup (the page asks first): "Switch to delivery" / "Ship by carrier…". */
  onMove: (path: "ROUTE" | "SHIP") => void;
}) {
  const { toast } = useToast();
  const createInvoice = useCreateInvoiceFromOrder({ localErrorToast: true });
  const printInvoice = usePrintInvoice();
  const invoices = invoicesOf(order);
  const firstInvoice = invoices[0];

  // ONE wrap unit: the path moves sit in a single flex group that is full width below md, so on a phone they
  // wrap together on their own row (never one of them beside Delete, which the page renders after this).
  const switchToDelivery =
    moveOptions.delivery || moveOptions.ship ? (
      <ActionTier tier="secondary">
        <div
          role="group"
          aria-label="Move this order off pickup"
          className="flex flex-wrap items-center gap-2 max-md:w-full"
        >
          {moveOptions.delivery && (
            <Button
              size="sm"
              className="h-11"
              variant="secondary"
              leftIcon={<Truck className="h-4 w-4" />}
              onClick={() => moveOptions.delivery && onMove(moveOptions.delivery)}
            >
              {POS_COPY.switchToDelivery}
            </Button>
          )}
          {moveOptions.ship && (
            <Button
              size="sm"
              className="h-11"
              variant="secondary"
              leftIcon={<Package className="h-4 w-4" />}
              onClick={() => onMove("SHIP")}
            >
              {POS_COPY.shipByCarrier}
            </Button>
          )}
        </div>
      </ActionTier>
    ) : null;

  // W-1043: at PENDING it is the order's one primary action (the page's Confirm order steps down); at CONFIRMED it
  // follows Create invoice / Hand over. One server step either way (POST /orders/:id/ready-for-pickup).
  const readyForPickup = (primary: boolean) => (
    <ActionTier tier={primary ? "primary" : "secondary"}>
      <Button
        size="sm"
        className="h-11"
        variant={primary ? undefined : "secondary"}
        leftIcon={<Bell className="h-4 w-4" />}
        onClick={onReadyForPickup}
        loading={readyPending}
      >
        {POS_COPY.readyForPickup}
      </Button>
    </ActionTier>
  );

  // The same mutation and write gate wherever it is offered. CONFIRMED: the primary. Ready (SA-1066 M2): a secondary
  // while no invoice exists, so Hand over stays the one primary (hand-over does not wait for it; SA-1026 B issues then).
  const createInvoiceTier = (primary: boolean) => (
    <ActionTier tier={primary ? "primary" : "secondary"}>
      <Button
        size="sm"
        className="h-11"
        variant={primary ? undefined : "secondary"}
        leftIcon={<FileText className="h-4 w-4" />}
        loading={createInvoice.isPending}
        onClick={() =>
          createInvoice.mutate(orderId, {
            onSuccess: (made) => {
              const number = made?.[0]?.invoiceNumber;
              toast({
                title: number
                  ? POS_COPY.invoiceCreatedNamed(number, made.length - 1)
                  : POS_COPY.invoiceCreated,
                variant: "success",
              });
            },
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
  );

  if (status === "PENDING") {
    return (
      <>
        {readyForPickup(true)}
        <ActionTier tier="secondary">
          <Button
            size="sm"
            className="h-11"
            variant="secondary"
            leftIcon={<CheckCircle2 className="h-4 w-4" />}
            onClick={onConfirm}
            loading={readyPending}
          >
            {POS_COPY.confirmOrder}
          </Button>
        </ActionTier>
        {/* SA-1066 F02: billing was only on the Invoice card, far down the page. Same button and write gate as at Ready. */}
        {!firstInvoice && createInvoiceTier(false)}
        {switchToDelivery}
      </>
    );
  }

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
            {createInvoiceTier(true)}
            {handOver(false)}
          </>
        )}
        {readyForPickup(false)}
        {switchToDelivery}
      </>
    );
  }

  if (status === "OUT_FOR_DELIVERY") return firstInvoice ? null : createInvoiceTier(false);

  if (status === "DELIVERED" && firstInvoice) {
    const paid = invoices.every((i) => i.status === "PAID");
    // SA-1026 B: handed over means issued and numbered, so Print invoice prints every non-void invoice of the order (oldest first)
    const printButton = (
      <Button
        size="sm"
        className="h-11"
        variant={paid ? undefined : "secondary"}
        loading={printInvoice.printing}
        onClick={() => void printInvoice.print(invoices.map((i) => i.id))}
        leftIcon={<Printer className="h-4 w-4" />}
      >
        {POS_COPY.printInvoice}
      </Button>
    );
    return paid ? (
      <ActionTier tier="primary">{printButton}</ActionTier>
    ) : (
      <>
        <ActionTier tier="primary">
          <Button
            size="sm"
            className="h-11"
            href={`/invoices/${firstInvoice.id}`}
            leftIcon={<Wallet className="h-4 w-4" />}
          >
            {POS_COPY.recordPayment}
          </Button>
        </ActionTier>
        <ActionTier tier="secondary">{printButton}</ActionTier>
      </>
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
              : "Out for delivery"}
        </Button>
        {fulfillPath === "SHIP" && (
          <p className="text-[11px] text-navy/50">
            {`Sets the order to ${statusLabel("OUT_FOR_DELIVERY", "Out for delivery", fulfillPath as "SHIP")} — the customer is notified it's on the way.`}
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
