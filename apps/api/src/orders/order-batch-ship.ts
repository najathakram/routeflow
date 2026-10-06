/**
 * Batch "Mark shipped" (#3168): ship several carrier (fulfillPath SHIP) orders in one request.
 *
 * `OrdersService.changeStatus` stays the ONLY authority: this service classifies each order with the
 * pure `classifyForShip`, refuses what cannot ship (zero writes), then calls the existing
 * `updateShipment` (only when tracking was given) and `changeStatus(CONFIRMED -> OUT_FOR_DELIVERY)`, so
 * the credit gate, the B1095 CAS, the shipment-time invoice and the one shipped email all run exactly as
 * for a single order. Orders run one after another (never in parallel): each changeStatus takes locks
 * and settles an invoice, and a failure of one order must not touch the next.
 *
 * Every id is read through `prisma.forTenant()`: a foreign or missing id is NOT_FOUND with the same
 * shape as any other, so a batch can neither write to nor probe another tenant's order.
 */
import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { FulfillPath, OrderStatus } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersService } from "./orders.service";
import { ORDER_STATUS_TRANSITIONS } from "./order-status-transitions";
import { SHIPPED_STATUSES } from "./shipment-notifications";

/** The api's literal copy of packages/types BATCH_SHIP_OUTCOMES (L-072; order-batch-ship.spec.ts pins it). */
export const BATCH_SHIP_OUTCOMES = [
  "SHIPPED",
  "SHIPPED_INVOICE_PENDING",
  "NOT_CARRIER_ORDER",
  "ALREADY_SHIPPED",
  "NOT_CONFIRMED",
  "CREDIT_HOLD",
  "ORDER_CHANGED",
  "INVALID_TRACKING",
  "NOT_FOUND",
  "FAILED",
] as const;
export type BatchShipOutcome = (typeof BATCH_SHIP_OUTCOMES)[number];

export interface BatchShipInput {
  orderId: string;
  carrier?: string;
  trackingNumber?: string;
}
export interface BatchShipRow {
  orderId: string;
  orderNumber: string | null;
  outcome: BatchShipOutcome;
  message: string;
  /** True when the tracking was written but the order did not ship (the tracking stays saved). */
  trackingSaved?: boolean;
}

const MESSAGES: Record<BatchShipOutcome, string> = {
  SHIPPED: "Marked shipped.",
  SHIPPED_INVOICE_PENDING:
    "Marked shipped, but its invoice could not be created. Open the order to generate it.",
  NOT_CARRIER_ORDER: "Not a carrier order, so it cannot be marked shipped here.",
  ALREADY_SHIPPED: "Already shipped. Nothing was changed.",
  NOT_CONFIRMED: "Only confirmed orders can be marked shipped.",
  CREDIT_HOLD: "On credit hold. Resolve the customer's credit limit, then ship it again.",
  ORDER_CHANGED: "The order changed while shipping. Review it and try again.",
  INVALID_TRACKING: "The carrier or tracking number is not valid. Nothing was changed.",
  NOT_FOUND: "Order not found.",
  FAILED: "Could not be marked shipped. Nothing was confirmed; try it from the order page.",
};

/** Same limits as UpdateShipmentDto (carrier 64, tracking 128). */
const MAX_CARRIER = 64;
const MAX_TRACKING = 128;
const SHIPPED_OUTCOMES: ReadonlySet<BatchShipOutcome> = new Set<BatchShipOutcome>([
  "SHIPPED",
  "SHIPPED_INVOICE_PENDING",
]);

/**
 * Pure: why this order cannot ship, or null when it can. Reads the shared transition table and
 * SHIPPED_STATUSES; never re-declares them. Order matters: carrier first, then already-shipped.
 */
export function classifyForShip(order: {
  status: OrderStatus;
  fulfillPath: FulfillPath;
}): BatchShipOutcome | null {
  if (order.fulfillPath !== FulfillPath.SHIP) return "NOT_CARRIER_ORDER";
  if (SHIPPED_STATUSES.has(order.status)) return "ALREADY_SHIPPED";
  const canShip =
    order.status === OrderStatus.CONFIRMED &&
    (ORDER_STATUS_TRANSITIONS[order.status] ?? []).includes(OrderStatus.OUT_FOR_DELIVERY);
  return canShip ? null : "NOT_CONFIRMED";
}

const codeOf = (err: unknown): string | undefined => {
  const res = (err as { getResponse?: () => unknown } | null)?.getResponse?.();
  return res && typeof res === "object" ? (res as { code?: string }).code : undefined;
};

/** The invoice-settle failure shape (order-status-invoicing.ts): the review code, or its "marked ..., but its invoice" 409. */
const isInvoiceFailure = (err: unknown, code: string | undefined): boolean => {
  if (code === API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW) return true;
  return (
    err instanceof ConflictException &&
    /^The order was marked \w+, but its invoice /.test(err.message ?? "")
  );
};

@Injectable()
export class OrderBatchShipService {
  private readonly logger = new Logger(OrderBatchShipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
  ) {}

  async batchShip(
    inputs: BatchShipInput[],
    user: JwtPayload,
  ): Promise<{ results: BatchShipRow[] }> {
    const results: BatchShipRow[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      if (seen.has(input.orderId)) continue; // processed once
      seen.add(input.orderId);
      results.push(await this.shipOne(input, user));
    }
    return { results };
  }

  private row(
    orderId: string,
    orderNumber: string | null,
    outcome: BatchShipOutcome,
  ): BatchShipRow {
    return { orderId, orderNumber, outcome, message: MESSAGES[outcome] };
  }

  /** A not-shipped result after the tracking was already written: say the tracking was saved. */
  private rowTrackingSaved(
    orderId: string,
    orderNumber: string | null,
    outcome: BatchShipOutcome,
  ): BatchShipRow {
    if (SHIPPED_OUTCOMES.has(outcome)) return this.row(orderId, orderNumber, outcome);
    const base = MESSAGES[outcome].replace(/ ?Nothing was (changed|confirmed)[^.]*\.?/, "");
    return {
      orderId,
      orderNumber,
      outcome,
      message: `${base.trim()} The tracking was saved.`,
      trackingSaved: true,
    };
  }

  private async shipOne(input: BatchShipInput, user: JwtPayload): Promise<BatchShipRow> {
    const { orderId } = input;
    let order: {
      id: string;
      orderNumber: string | null;
      status: OrderStatus;
      fulfillPath: FulfillPath;
    } | null;
    try {
      order = await this.prisma.forTenant().order.findFirst({
        where: { id: orderId },
        select: { id: true, orderNumber: true, status: true, fulfillPath: true },
      });
    } catch (err) {
      this.logger.warn(`batch ship read failed for ${orderId}: ${err}`);
      return this.row(orderId, null, "FAILED");
    }
    if (!order) return this.row(orderId, null, "NOT_FOUND");
    const num = order.orderNumber;

    const refused = classifyForShip(order);
    if (refused) return this.row(orderId, num, refused);

    const carrier = input.carrier?.trim() ?? "";
    const tracking = input.trackingNumber?.trim() ?? "";
    if (carrier.length > MAX_CARRIER || tracking.length > MAX_TRACKING) {
      return this.row(orderId, num, "INVALID_TRACKING");
    }

    let trackingWritten = false;
    try {
      if (tracking) {
        await this.ordersService.updateShipment(
          orderId,
          { shippingCarrier: carrier, shippingTrackingNumber: tracking },
          user,
        );
        trackingWritten = true;
      }
    } catch (err) {
      if (err instanceof BadRequestException) return this.row(orderId, num, "INVALID_TRACKING");
      this.logger.warn(`batch ship tracking write failed for ${orderId}: ${err}`);
      return this.row(orderId, num, "FAILED");
    }

    try {
      await this.ordersService.changeStatus(
        orderId,
        { status: OrderStatus.OUT_FOR_DELIVERY },
        user,
      );
      return this.row(orderId, num, "SHIPPED");
    } catch (err) {
      const outcome = await this.mapStatusError(orderId, err);
      return trackingWritten
        ? this.rowTrackingSaved(orderId, num, outcome)
        : this.row(orderId, num, outcome);
    }
  }

  /** changeStatus threw: map by error code; any other 409 is judged by whether the status committed. */
  private async mapStatusError(orderId: string, err: unknown): Promise<BatchShipOutcome> {
    const code = codeOf(err);
    if (code === API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED) return "CREDIT_HOLD";
    if (code === API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT) return "ORDER_CHANGED";
    // A 400 from changeStatus is a status/transition refusal, not bad tracking (tracking was validated
    // by updateShipment above), so it falls through to FAILED.
    if (isInvoiceFailure(err, code)) {
      // changeStatus raises the invoice-settle failure AFTER the status committed.
      if (await this.isShippedNow(orderId)) return "SHIPPED_INVOICE_PENDING";
    }
    this.logger.warn(
      `batch ship failed for ${orderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "FAILED";
  }

  private async isShippedNow(orderId: string): Promise<boolean> {
    try {
      const o = await this.prisma
        .forTenant()
        .order.findFirst({ where: { id: orderId }, select: { status: true } });
      return !!o && SHIPPED_STATUSES.has(o.status);
    } catch {
      return false;
    }
  }
}
