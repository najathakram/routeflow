import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { SendReceiptResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { calendarDayBounds } from "../common/calendar-date";
import { taxRatePercentFrom } from "../common/tax-rate";
import { resolveZone } from "../common/tenant-time-zone";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import { RECEIPT_CHANNELS } from "./receipt-channels";
import {
  RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_DEFAULT,
  RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_KEY,
  RECEIPT_EMAIL_PER_ORDER_DEFAULT,
  RECEIPT_EMAIL_PER_ORDER_KEY,
  RECEIPT_EMAIL_PER_TENANT_PER_DAY_DEFAULT,
  RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY,
  resolveReceiptLimit,
} from "./receipt-limits";
import { isLiveInvoice, type ReceiptBranding, type ReceiptPaymentInput } from "./receipt-model";
import { renderOrderReceipt } from "./render-order-receipt";
import type { SendReceiptDto } from "./send-receipt.dto";

/** The EmailDelivery `kind` and `entityType` every receipt send is logged (and counted) under. */
const RECEIPT_KIND = "RECEIPT" as const;
const ORDER_ENTITY = "Order";

/** SystemConfig keys read in ONE query: the two limits, and the legacy business profile TenantConfig overrides (as GET /settings reads it). */
const SETTING_KEYS = [
  RECEIPT_EMAIL_PER_ORDER_KEY,
  RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY,
  RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_KEY,
  "settings.businessName",
  "settings.street",
  "settings.city",
  "settings.state",
  "settings.zip",
  "settings.phone",
  "settings.receiptFooter",
  "settings.taxRate",
  // the invoices' own switch: no struck list price and no Discounts row
  "invoice.hideOriginalPrice",
];

const tooMany = (code: string, message: string) =>
  new HttpException({ code, message }, HttpStatus.TOO_MANY_REQUESTS);

/**
 * POST /orders/:id/receipt (SA-751r). One path for every order with a live invoice: read the order tenant-scoped (another
 * tenant's id is a 404 and nothing is sent or counted), refuse a voided one, check the two limits against the SENT delivery
 * rows, render from stored rows, and hand the rendered receipt to the channel's sender. The typed address goes to the
 * transport and the delivery log only: this class writes no customer, order or invoice row.
 *
 * The limits are counted, not locked: two sends racing past the same count can both go (at most one over a cap), which is
 * accepted for an anti-abuse cap on a 44 px button; a delivery row is the ledger either way.
 */
@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async send(
    orderId: string,
    dto: SendReceiptDto,
    now: Date = new Date(),
  ): Promise<SendReceiptResponse> {
    // the address as typed, trimmed: it is what is sent and logged. Only the cap's count key is normalised.
    const to = dto.to.trim();
    const tenantId = this.prisma.getTenantId();
    // forTenant() is UNSCOPED without a tenant: refuse, like the Today's-sales read.
    if (!tenantId) throw new ForbiddenException("Receipts need a tenant-scoped session");
    const db = this.prisma.forTenant();

    const order = await db.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        total: true,
        tax: true,
        createdAt: true,
        orderDate: true,
        counterSale: true,
        counterCashTendered: true,
        // the name and the walk-in flag only: the customer's email is never read, a typed address is never kept
        customer: { select: { businessName: true, isWalkIn: true } },
        // row 317: the cashier's username only, printed as "Cashier: <name>" (never an email)
        soldBy: { select: { username: true } },
        lineItems: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            status: true,
            qty: true,
            unitPrice: true,
            originalPrice: true,
            priceType: true,
            notes: true,
            unitsPerBox: true,
            boxes: true,
            pieces: true,
            product: {
              select: {
                name: true,
                variantName: true,
                parentProductId: true,
                parent: { select: { name: true } },
                // row 317b: the unit word a plain line's detail prints
                unit: true,
              },
            },
          },
        },
        invoices: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            // the stored line rates the receipt names its tax rate from (pricing's storedTaxRatePercent), and the
            // levy each line billed with its category name (CQ-03: its own named charge)
            items: {
              select: {
                taxRate: true,
                categoryTaxAmount: true,
                trackedCategoryId: true,
                categoryTaxType: true,
                trackedCategory: { select: { id: true, name: true, taxType: true } },
              },
            },
            // in the order they were taken: the first stored tender decides whether change is served
            payments: {
              orderBy: { createdAt: "asc" },
              select: { method: true, amount: true, status: true },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    const invoices = order.invoices.map(({ id, invoiceNumber, status, items }) => ({
      id,
      invoiceNumber,
      status,
      items,
    }));
    if (order.status === "CANCELLED" || !invoices.some(isLiveInvoice)) {
      throw new ConflictException({
        code: API_ERROR_CODES.RECEIPT_NOT_AVAILABLE,
        message: "This sale has no receipt to send",
      });
    }

    const [config, settingRows, resolvedZone] = await Promise.all([
      this.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: {
          businessName: true,
          addressLine1: true,
          city: true,
          state: true,
          zip: true,
          phone: true,
        },
      }),
      db.systemConfig.findMany({
        where: { key: { in: SETTING_KEYS } },
        select: { key: true, value: true },
      }),
      // the tenant zone has ONE reader (common/tenant-time-zone.ts); never selected here
      resolveZone(this.prisma, { tenantId }),
    ]);
    const settings = Object.fromEntries(
      (settingRows as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
    );
    const zone = resolvedZone.zone;

    // per-order first: it is the limit the cashier can read and act on
    const perOrderCap = resolveReceiptLimit(
      settings[RECEIPT_EMAIL_PER_ORDER_KEY],
      RECEIPT_EMAIL_PER_ORDER_DEFAULT,
    );
    const sentOnOrder = await db.emailDelivery.count({
      where: {
        tenantId,
        kind: RECEIPT_KIND,
        entityType: ORDER_ENTITY,
        entityId: order.id,
        status: "SENT",
      },
    });
    if (sentOnOrder >= perOrderCap) {
      throw tooMany(
        API_ERROR_CODES.RECEIPT_EMAIL_ORDER_LIMIT,
        "This receipt has reached its email limit",
      );
    }
    const perDayCap = resolveReceiptLimit(
      settings[RECEIPT_EMAIL_PER_TENANT_PER_DAY_KEY],
      RECEIPT_EMAIL_PER_TENANT_PER_DAY_DEFAULT,
    );
    // the tenant's own calendar day, on the (tenantId, kind, createdAt) index
    const dayStart = calendarDayBounds(zone, now).start;
    const sentToday = await db.emailDelivery.count({
      where: { tenantId, kind: RECEIPT_KIND, status: "SENT", createdAt: { gte: dayStart } },
    });
    if (sentToday >= perDayCap) {
      throw tooMany(
        API_ERROR_CODES.RECEIPT_EMAIL_DAY_LIMIT,
        "Today's receipt email limit is reached",
      );
    }

    // per address: the same (trimmed, lower-cased) address in the tenant's day, ALL statuses, so a stranger's inbox cannot be flooded
    // by changing the order or by retrying failures
    const perAddressCap = resolveReceiptLimit(
      settings[RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_KEY],
      RECEIPT_EMAIL_PER_ADDRESS_PER_DAY_DEFAULT,
    );
    const sentToAddress = await db.emailDelivery.count({
      where: {
        tenantId,
        kind: RECEIPT_KIND,
        toAddress: { equals: to.toLowerCase(), mode: "insensitive" },
        createdAt: { gte: dayStart },
      },
    });
    if (sentToAddress >= perAddressCap) {
      throw tooMany(
        API_ERROR_CODES.RECEIPT_EMAIL_ADDRESS_LIMIT,
        "This address has reached today's receipt limit",
      );
    }

    const payments: ReceiptPaymentInput[] = order.invoices.flatMap((i) =>
      i.payments.map((p) => ({
        invoiceId: i.id,
        method: p.method,
        amount: p.amount,
        status: p.status,
      })),
    );
    const branding: ReceiptBranding = {
      businessName: config?.businessName || settings["settings.businessName"],
      street: config?.addressLine1 ?? settings["settings.street"],
      city: config?.city ?? settings["settings.city"],
      state: config?.state ?? settings["settings.state"],
      zip: config?.zip ?? settings["settings.zip"],
      phone: config?.phone ?? settings["settings.phone"],
      footer: settings["settings.receiptFooter"],
      configuredTaxPercent: taxRatePercentFrom(settings["settings.taxRate"]),
      hideOriginalPrice: settings["invoice.hideOriginalPrice"] === "true",
    };
    const { subject, html, text } = renderOrderReceipt(order, invoices, payments, branding, zone);

    try {
      await RECEIPT_CHANNELS[dto.channel](
        { email: this.email },
        {
          to,
          subject,
          html,
          text,
          delivery: { tenantId, kind: RECEIPT_KIND, entityType: ORDER_ENTITY, entityId: order.id },
        },
      );
    } catch (err) {
      // the delivery row already holds the (redacted) provider text; the client gets a code, never that text
      this.logger.warn(
        `Receipt email for order ${order.id} was not sent: ${(err as Error).message}`,
      );
      throw new BadGatewayException({
        code: API_ERROR_CODES.RECEIPT_EMAIL_NOT_SENT,
        message: "The receipt could not be sent",
      });
    }
    return { channel: dto.channel, to };
  }
}
