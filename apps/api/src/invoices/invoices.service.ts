import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { compressDocument } from "../storage/compress.util";
import {
  computeLineSubtotal,
  computeCategoryTax,
  roundMoney,
  normalizeBoxesPieces,
  type CategoryTaxType,
} from "../common/pricing";
import { redactUpsellForCustomer } from "../common/upsell-redaction";
import { clampLimit } from "../common/pagination";
import { isInternalEmail } from "../common/internal-email";
import { loadMsrpMap } from "../common/msrp";
import { EntitlementsService } from "../billing/entitlements.service";
import { CheckStatus, InvoiceStatus, NotificationEvent, UserRole } from "@prisma/client";
import {
  CreateInvoiceDto,
  RecordInvoicePaymentDto,
  SetCheckStatusDto,
  StandalonePaymentDto,
  UpdatePaymentDto,
  WriteOffDto,
} from "./dto/create-invoice.dto";
import { CreatePartialInvoiceDto } from "./dto/create-partial-invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";
import { UpdateShipmentDto } from "../orders/dto/update-shipment.dto";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { formatDate, formatMoney } from "../messaging/messaging.helpers";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NSF_FEE_DESCRIPTION_PREFIX } from "../sales-agents/commission-math";

const TERM_DAYS: Record<string, number> = {
  "Due on Receipt": 0,
  "Net 15": 15,
  "Net 30": 30,
  "Net 45": 45,
  "Net 60": 60,
};

/**
 * The tenant's CURRENT calendar day, as the UTC-midnight instant of that day.
 *
 * `Invoice.issueDate`/`dueDate` are CALENDAR dates and every consumer (list, detail,
 * PDF, email) formats them with `timeZone: "UTC"` — so a stored value must be UTC
 * midnight of the intended day or it prints one day off. A raw `new Date()` breaks
 * that: a sale keyed at 8:10pm America/New_York is already 00:10Z the NEXT day and
 * would print (and fall due) one day late. Backdated orders already arrive as UTC
 * midnight; this gives same-day sales the identical shape.
 */
export function startOfCalendarDay(timeZone?: string | null, now: Date = new Date()): Date {
  let y: string, m: string, d: string;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const at = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    [y, m, d] = [at("year"), at("month"), at("day")];
  } catch {
    // Unknown/invalid IANA zone stored on TenantConfig — fall back to UTC, never throw.
    [y, m, d] = [
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
    ];
  }
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}

/**
 * Payment-term arithmetic on a calendar date, in UTC. `setDate`/`getDate` read LOCAL
 * components, so on a non-UTC host they shift a UTC-midnight instant by the DST delta
 * and can land the due date on the previous calendar day.
 */
export function addCalendarDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * P5-12: legal FORWARD transitions for the check lifecycle.
 * RECORDED → DEPOSITED → CLEARED (strict sequence); any non-bounced state can
 * go to BOUNCED (a deposited or even cleared check can be returned by the
 * bank). BOUNCED is terminal.
 */
const CHECK_TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  RECORDED: ["DEPOSITED", "BOUNCED"],
  DEPOSITED: ["CLEARED", "BOUNCED"],
  CLEARED: ["BOUNCED"],
  BOUNCED: [],
};

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly emailService: EmailService,
    private readonly pdfService: InvoicePdfService,
    private readonly systemConfig: SystemConfigService,
    private readonly ledger: RegulatedLedgerService,
    private readonly authGuard: AuthorizationGuardService,
    private readonly creditNotes: CreditNotesService,
    private readonly messaging: MessagingService,
    private readonly storage: StorageService,
    private readonly entitlements: EntitlementsService,
    private readonly commissionEngine: CommissionEngineService,
  ) {}

  /**
   * Stamp each line's MSRP at creation time. Snapshot, not a live read: an issued invoice
   * must never change because someone later edited the product's MSRP. No-ops (leaving
   * msrp null) when the tenant does not have flag.msrp, so a tenant that turns the feature
   * off simply stops emitting MSRP on NEW invoices while old ones keep what they printed.
   */
  private async applyMsrpSnapshots<T extends { productId?: string | null; msrp?: number | null }>(
    db: any,
    customerId: string,
    itemsData: T[],
  ): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId || !(await this.entitlements.hasFlag(tenantId, "flag.msrp"))) return;
    const ids = [...new Set(itemsData.map((i) => i.productId).filter(Boolean))] as string[];
    if (ids.length === 0) return;
    const map = await loadMsrpMap(db, customerId, ids);
    for (const it of itemsData) {
      if (it.productId) it.msrp = map.get(it.productId) ?? null;
    }
  }

  /**
   * Resolve the effective default invoice terms and corresponding due-days offset.
   *
   * A per-customer `defaultPaymentTerms` override ("this customer is always Net
   * 60") wins over the tenant SystemConfig default when one is set; otherwise
   * falls back to the existing tenant-only behavior. Callers that generate an
   * invoice FROM an order should pass the order's customerId so the customer's
   * override is honored.
   */
  async resolveDefaultTerms(customerId?: string): Promise<{ terms: string; dueDays: number }> {
    if (customerId) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { id: customerId }, select: { defaultPaymentTerms: true } });
      if (customer?.defaultPaymentTerms) {
        const terms = customer.defaultPaymentTerms;
        return { terms, dueDays: TERM_DAYS[terms] ?? 30 };
      }
    }
    const stored = await this.systemConfig.get("invoice.defaultTerms");
    const terms = stored || "Net 30";
    return { terms, dueDays: TERM_DAYS[terms] ?? 30 };
  }

  /**
   * Resolve the tenant's customer-facing invoice Notes and Terms & Conditions defaults,
   * plus its timezone — the calendar day a same-day invoice is dated in.
   */
  private async resolveTenantInvoiceDefaults(): Promise<{
    notes: string | null;
    terms: string | null;
    timezone: string | null;
  }> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return { notes: null, terms: null, timezone: null };
    const cfg = await this.prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { invoiceNotes: true, invoiceTerms: true, timezone: true },
    });
    return {
      notes: cfg?.invoiceNotes ?? null,
      terms: cfg?.invoiceTerms ?? null,
      timezone: cfg?.timezone ?? null,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async nextInvoiceNumber(): Promise<string> {
    return this.generateInvoiceNumber();
  }

  private recomputeStatus(
    totalPaid: number,
    total: number,
    dueDate: Date | null,
    currentStatus?: InvoiceStatus,
  ): InvoiceStatus {
    // DRAFT, VOID, and WRITTEN_OFF are terminal/deliberate states — payment-driven
    // recalculation must never override them.
    if (
      currentStatus === InvoiceStatus.DRAFT ||
      currentStatus === InvoiceStatus.VOID ||
      currentStatus === InvoiceStatus.WRITTEN_OFF
    ) {
      return currentStatus;
    }
    if (totalPaid >= total - 0.001) return InvoiceStatus.PAID;
    if (totalPaid > 0) return InvoiceStatus.PARTIAL;
    if (dueDate && new Date(dueDate) < new Date()) return InvoiceStatus.OVERDUE;
    return InvoiceStatus.SENT;
  }

  /**
   * Deliberately minimal deposit schedule (Tier 1): the deposit dollar amount is
   * ALWAYS derived from depositPercent * total at read time — never stored — and
   * depositOverdue is a computed filter, never a status flip. No InvoiceInstallment
   * table / deposit-aware statuses in this phase; recomputeStatus/AR aging are
   * completely untouched by this.
   */
  private computeDepositFields(
    inv: {
      total: number | string;
      depositPercent: number | string | null;
      depositDueDate: Date | null;
    },
    totalPaid: number,
  ): { depositAmount: number | null; depositOverdue: boolean } {
    if (inv.depositPercent == null) return { depositAmount: null, depositOverdue: false };
    const depositAmount = roundMoney((Number(inv.total) * Number(inv.depositPercent)) / 100);
    // RF-202 convention (see findAll): compare ISO date strings so a deposit due
    // TODAY is never flagged overdue. A raw Date compare treats the UTC-midnight
    // depositDueDate as past the instant UTC rolls over — i.e. the evening before
    // it is actually due for every tenant behind UTC.
    const depositDueIso = inv.depositDueDate
      ? new Date(inv.depositDueDate).toISOString().slice(0, 10)
      : null;
    const depositOverdue =
      depositDueIso != null &&
      depositDueIso < new Date().toISOString().slice(0, 10) &&
      totalPaid < depositAmount;
    return { depositAmount, depositOverdue };
  }

  private async findOneOrThrow(id: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException("Invoice not found");
    return inv;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  /**
   * RF-026: Previously, concurrent invoice creates both read the same last
   * invoice number and one crashed with Prisma P2002 → HTTP 500. Now catches
   * P2002 and returns 409 Conflict instead.
   */
  async create(dto: CreateInvoiceDto) {
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException("Customer not found");

    // Pre-fetch products for every product-linked line: box size for qty resolution
    // AND the regulated-category snapshot (so a manual regulated invoice reaches the
    // W5 sales ledger just like an order-derived one).
    const productIds = [...new Set(dto.items.filter((i) => i.productId).map((i) => i.productId!))];
    const products =
      productIds.length > 0
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: productIds } },
            select: {
              id: true,
              unitsPerBox: true,
              trackedCategoryId: true,
              trackedSubcategoryId: true,
            },
          })
        : [];
    const productMap = new Map(products.map((p) => [p.id, p]));
    // RF-4: load the regulated section (TrackedCategory) tax config so a manual
    // invoice's regulated lines carry + owe category tax just like an order-derived one.
    const manualCatIds = [
      ...new Set(products.map((p) => p.trackedCategoryId).filter(Boolean)),
    ] as string[];
    const categoryMap = new Map<string, any>(
      (manualCatIds.length > 0
        ? await this.prisma
            .forTenant()
            .trackedCategory.findMany({ where: { id: { in: manualCatIds } } })
        : []
      ).map((c: any) => [c.id, c]),
    );

    let subtotal = 0;
    const itemsData = dto.items.map((item) => {
      const product = item.productId ? productMap.get(item.productId) : undefined;
      let qty = item.qty;
      let boxes: number | null = null;
      let pieces: number | null = null;
      let unitsPerBox: number | undefined;
      if (item.productId && (item.boxes != null || item.pieces != null)) {
        if (product?.unitsPerBox) {
          unitsPerBox = product.unitsPerBox;
          // Force integer boxes/pieces and roll pieces >= unitsPerBox into boxes.
          const split = normalizeBoxesPieces({
            boxes: item.boxes,
            pieces: item.pieces,
            unitsPerBox,
          });
          boxes = split.boxes;
          pieces = split.pieces;
          qty = split.qty;
        }
      }
      // BUY_N_GET_M: free whole selling units come off the subtotal BEFORE pricing
      // (never a rounded net unit price). 0 for every other line.
      const freeUnits = this.clampLineFreeUnits(item.promoFreeUnits, boxes, qty);
      const beforeDiscount = computeLineSubtotal({
        unitPrice: item.unitPrice,
        qty,
        boxes,
        pieces,
        unitsPerBox,
        freeUnits,
      });
      const lineSub = roundMoney(beforeDiscount - (item.discount ?? 0));
      subtotal += lineSub;
      // RF-4: per-line regulated category tax on the NET (post-discount) sale — the
      // same basis as the regular line tax. Piece count is the basis for per-unit
      // levies; a boxed selling-unit line expands via the product's box size.
      const category = product?.trackedCategoryId
        ? categoryMap.get(product.trackedCategoryId)
        : null;
      const upbForPieces = Number(product?.unitsPerBox ?? 0);
      const pieceQty = boxes != null ? qty : upbForPieces > 1 ? qty * upbForPieces : qty;
      const categoryTaxAmount = category
        ? computeCategoryTax({
            taxType: category.taxType as CategoryTaxType,
            rate: Number(category.rate),
            unitBasisQty: pieceQty,
            lineSubtotal: lineSub,
            priceIncludesTax: category.priceIncludesTax,
          })
        : 0;
      return {
        description: item.description,
        productId: item.productId,
        qty,
        unitPrice: item.unitPrice,
        discount: item.discount ?? 0,
        taxRate: item.taxRate ?? 0,
        subtotal: lineSub,
        boxes,
        pieces,
        // Snapshot the box size when this line was priced as a box split, so a later
        // edit/PDF recompute uses the sale-time size (mirrors order-derived lines).
        unitsPerBox: boxes != null && unitsPerBox ? unitsPerBox : null,
        // BUY_N_GET_M snapshot — stored so the next edit re-prices off it.
        promoFreeUnits: freeUnits > 0 ? freeUnits : null,
        // Snapshot the regulated category/subcategory AT SALE TIME (never re-read the
        // live product later — it may drift), so the ledger and filings attribute this
        // line even if the product is re-classified afterward.
        trackedCategoryId: product?.trackedCategoryId ?? null,
        trackedSubcategoryId: product?.trackedSubcategoryId ?? null,
        // RF-4: per-line category tax snapshot (folded into taxTotal below).
        categoryTaxAmount,
        notes: item.notes ?? null,
        // MSRP snapshot — set below by applyMsrpSnapshots (null when flag.msrp is off).
        msrp: null as number | null,
        tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
      };
    });
    subtotal = roundMoney(subtotal);
    await this.applyMsrpSnapshots(this.prisma.forTenant(), dto.customerId, itemsData);

    // Validate no line item has a negative subtotal (discount > line total)
    for (const item of itemsData) {
      if (item.subtotal < 0) {
        throw new BadRequestException(
          `Line item "${item.description}" has a negative subtotal (${item.subtotal}). Discount cannot exceed line total.`,
        );
      }
    }

    const invDiscount = dto.discount ?? 0;
    const shipping = dto.shippingFee ?? 0;
    // RF-079: tax-exempt customers owe $0 tax regardless of line item tax rates.
    // Tax is derived from each line's stored post-discount subtotal — the SAME
    // basis as the line itself — so boxed/prorated lines are taxed on what they
    // actually bill (previously re-derived qty*unitPrice, which diverged).
    const isTaxExempt = !!(customer as any).isTaxExempt;
    const regularTax = isTaxExempt
      ? 0
      : roundMoney(itemsData.reduce((sum, it) => sum + it.subtotal * (it.taxRate ?? 0), 0));
    // RF-4: fold the regulated category tax into the invoice tax — exempt → 0 for
    // BOTH (foldCategoryTax also zeroes the per-line snapshots so the ledger records 0).
    const categoryTaxTotal = this.foldCategoryTax(itemsData, isTaxExempt);
    const taxTotal = roundMoney(regularTax + categoryTaxTotal);
    const total = roundMoney(subtotal - invDiscount + shipping + taxTotal);

    // Validate invoice-level discount doesn't exceed subtotal and total is non-negative
    if (invDiscount > subtotal) {
      throw new BadRequestException(
        `Invoice discount (${invDiscount}) cannot exceed subtotal (${subtotal}).`,
      );
    }
    if (total < 0) {
      throw new BadRequestException(`Invoice total cannot be negative (calculated: ${total}).`);
    }

    const tenantDefaults = await this.resolveTenantInvoiceDefaults();
    const invoiceNumber = await this.nextInvoiceNumber();
    // A regulated line makes this a filable sale — create the invoice AND its W5 ledger
    // rows atomically (a ledger write that fails must not leave a committed invoice with
    // no SALE row). Non-regulated invoices skip the ledger call entirely (no-op anyway).
    const hasRegulated = itemsData.some((it) => it.trackedCategoryId != null);
    let invoice: any;
    try {
      invoice = await this.prisma.tenantTransaction(async (tx: any) => {
        const created = await tx.invoice.create({
          data: {
            invoiceNumber,
            customerId: dto.customerId,
            status: InvoiceStatus.DRAFT,
            subtotal,
            taxAmount: taxTotal,
            discount: invDiscount,
            shippingFee: shipping,
            total,
            dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
            issueDate: dto.issueDate
              ? new Date(dto.issueDate)
              : startOfCalendarDay(tenantDefaults.timezone),
            notes: dto.notes ?? tenantDefaults.notes,
            terms: dto.terms ?? tenantDefaults.terms,
            paymentTermsLabel: dto.paymentTermsLabel ?? null,
            depositPercent: dto.depositPercent ?? null,
            depositDueDate: dto.depositDueDate ? new Date(dto.depositDueDate) : null,
            referenceNumber: dto.referenceNumber ?? null,
            subject: dto.subject ?? null,
            shippingCarrier: dto.shippingCarrier?.trim() || null,
            shippingTrackingNumber: dto.shippingTrackingNumber?.trim() || null,
            shippedAt: dto.shippingTrackingNumber?.trim() ? new Date() : null,
            items: { create: itemsData },
          },
          include: {
            customer: { select: { id: true, businessName: true } },
            items: true,
            payments: true,
          },
        });
        if (hasRegulated) {
          await this.ledger.writeSaleEntries({
            tenantId: this.prisma.getTenantId(),
            orderId: null,
            invoiceId: created.id,
            soldAt: created.issueDate ?? new Date(),
            lines: (created.items ?? []).map((it: any) => ({
              invoiceItemId: it.id,
              orderItemId: it.orderItemId ?? null,
              trackedCategoryId: it.trackedCategoryId ?? null,
              trackedSubcategoryId: it.trackedSubcategoryId ?? null,
              qty: Number(it.qty),
              netSales: Number(it.subtotal),
              categoryTax: Number(it.categoryTaxAmount ?? 0),
            })),
            db: tx,
          });
        }
        return created;
      });
    } catch (err: any) {
      // RF-050: duplicate invoiceNumber under concurrent requests
      if (err?.code === "P2002")
        throw new ConflictException("Invoice number conflict — please retry.");
      throw err;
    }

    // If the caller wants to immediately send the invoice, transition DRAFT → SENT
    if (dto.send) {
      return this.send(invoice.id);
    }

    return invoice;
  }

  /**
   * Auto-generate an Invoice from a delivered Order.
   * Accepts an optional Prisma transaction client so it can run
   * inside completeWithPayment()'s $transaction (via recordDeliveryPaymentInTx).
   *
   * RF-147: tenantId is now explicitly set on the Invoice record.  Previously
   * the create call omitted it, leaving invoices with tenantId=null which
   * bypassed all tenant-scoped queries.
   */
  async createInvoiceFromOrder(
    orderId: string,
    txClient?: any,
    overrides?: { dueDate?: string; terms?: string; paymentTermsLabel?: string },
  ) {
    const db = txClient ?? this.prisma;

    // Fetch order with non-cancelled line items
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: {
              select: {
                name: true,
                unitsPerBox: true,
                trackedCategoryId: true,
                trackedSubcategoryId: true,
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Build per-item remaining qty (qty - invoicedQty). If all items are fully invoiced,
    // skip — the order has already been split-invoiced by the operator/driver and there's
    // nothing left to bill.
    const remainingItems = order.lineItems
      .map((li: any) => ({
        li,
        remainingQty: Number(li.qty) - Number(li.invoicedQty ?? 0),
      }))
      .filter((x: any) => x.remainingQty > 0.001);

    if (remainingItems.length === 0) {
      // Everything already invoiced — return the order's existing invoice(s).
      // (W4: returns an array; a mixed order may have >1 sibling invoice.)
      const existing = await db.invoice.findMany({
        where: { orderId },
        orderBy: { createdAt: "desc" },
      });
      return existing;
    }

    // RF-079: check customer tax-exempt status
    const customer = await db.customer.findFirst({
      where: { id: order.customerId },
      select: { isTaxExempt: true },
    });

    const tenantId = this.prisma.getTenantId();
    // Due date from configured payment terms (e.g. "Net 30"), unless the caller
    // (e.g. the "New sale" flow) supplied an explicit override. Customer-aware:
    // the customer's own defaultPaymentTerms (when set) wins over the tenant default.
    const { terms: defaultTerms, dueDays } = await this.resolveDefaultTerms(order.customerId);
    // Customer-facing invoice Notes and T&C from tenant settings
    const tenantDefaults = await this.resolveTenantInvoiceDefaults();
    // A backdated order bills on its business date, and the payment term runs from
    // that date — not from when the invoice happened to be generated.
    const issueDate = order.orderDate ?? startOfCalendarDay(tenantDefaults.timezone);
    let dueDate: Date;
    if (overrides?.dueDate) {
      dueDate = new Date(overrides.dueDate);
    } else {
      dueDate = addCalendarDays(issueDate, dueDays);
    }
    const overrideTerms = overrides?.terms?.trim() || undefined;
    // INVARIANT: whatever string drove the dueDate math above is what gets
    // persisted here — an explicit caller-supplied label when given, else the
    // resolved default-terms label, so the label and the arithmetic can never
    // disagree. An explicit dueDate override with NO label means no term string
    // drove that date, so the label stays null (renders as nothing, exactly like
    // a historical row) rather than claiming arithmetic that never ran.
    // (overrideTerms above is the separate long-form T&C override and never
    // participates in the dueDate computation, so it is not a candidate.)
    const paymentTermsLabel =
      overrides?.paymentTermsLabel?.trim() || (overrides?.dueDate ? null : defaultTerms);

    const extraInvoiceData: Record<string, any> = {
      dueDate,
      terms: overrideTerms ?? tenantDefaults.terms ?? defaultTerms,
      paymentTermsLabel,
      issueDate,
      notes: tenantDefaults.notes ?? (order.orderNumber ? `Order #${order.orderNumber}` : null),
      // Carry carrier shipment tracking from the order onto the invoice so the
      // shipment shows on the customer's invoice + PDF.
      ...(order.shippingCarrier || order.shippingTrackingNumber
        ? {
            shippingCarrier: order.shippingCarrier ?? null,
            shippingTrackingNumber: order.shippingTrackingNumber ?? null,
            shippedAt: order.shippedAt ?? null,
          }
        : {}),
    };

    // Phase 4 (W4): split by regulated category — one invoice per SEPARATE_INVOICE
    // category + the standard invoice (siblings share invoiceGroupId, numbered
    // base / -R1 / -R2). A single-group order creates exactly one invoice as before.
    return this.createSplitInvoices({
      order,
      remainingItems,
      isTaxExempt: !!customer?.isTaxExempt,
      db,
      tenantId,
      extraInvoiceData,
      include: {
        customer: {
          select: { id: true, businessName: true, email: true, phone: true, mobile: true },
        },
        items: true,
        payments: true,
      },
    });
  }

  /**
   * RF-4: category (regulated) tax folds into an invoice's tax EXACTLY like the
   * regular sales tax w.r.t. tax exemption — an exempt customer owes $0 of BOTH.
   * Returns the Σ per-line category tax to add on top of the regular tax; when the
   * customer is exempt it returns 0 AND zeroes each line's snapshot in place, so the
   * stored InvoiceItem + the regulated-sales ledger record the $0 that was billed.
   */
  private foldCategoryTax(
    itemsData: Array<{ categoryTaxAmount?: number }>,
    isTaxExempt: boolean,
  ): number {
    if (isTaxExempt) {
      for (const it of itemsData) it.categoryTaxAmount = 0;
      return 0;
    }
    return roundMoney(itemsData.reduce((s, it) => s + Number(it.categoryTaxAmount ?? 0), 0));
  }

  /**
   * BUY_N_GET_M free units for a CLIENT-SUBMITTED invoice line (create + the
   * DRAFT edit, which delete-and-recreates every line). The snapshot travels on
   * the payload like `boxes`/`pieces`/`notes` do — without it an order-derived
   * BOGO line silently re-prices to full on save.
   *
   * Only WHOLE selling units count (boxes on a box-split line; qty otherwise) and
   * the result is capped at `units - 1`: the buyer always pays the N in every
   * (N + M), so no edit can hand over an entirely free line — the same ceiling the
   * order engine applies in `rescaleBogoFreeUnits`.
   */
  private clampLineFreeUnits(
    freeUnits: number | undefined,
    boxes: number | null,
    qty: number,
  ): number {
    const free = Math.max(0, Math.trunc(Number(freeUnits ?? 0) || 0));
    if (free <= 0) return 0;
    const wholeUnits = Math.trunc(Number(boxes != null ? boxes : qty) || 0);
    return Math.min(free, Math.max(0, wholeUnits - 1));
  }

  /**
   * Shared per-line invoice-item shape built from an order line, billing `billQty`
   * pieces of it. Reused by createInvoiceFromOrder, reconcileOrderDraftInvoice and
   * createPartialFromOrder so the invoice line NEVER drifts from the order line.
   *
   * COPY, DON'T RECOMPUTE. The order line already holds the agreed money
   * (`li.subtotal`) and the canonical box/piece denomination (`li.boxes` null ⇒
   * `qty` is in SELLING UNITS, not pieces). Re-deriving either from the billed qty
   * and the LIVE product.unitsPerBox is what let an invoice diverge from its order
   * (a packaging change re-priced past lines; the per-box price showed as the line
   * total). So:
   *   - Money comes from the STORED subtotal, never `computeLineSubtotal(live upb)`.
   *   - The box/piece split is only derived for lines that were themselves stored
   *     with a split (`li.boxes != null`); selling-unit lines keep `boxes = null`.
   *   - `unitsPerBox` is snapshotted so any later recompute (edit form, PDF) uses
   *     the sale-time box size, not the live product.
   *
   * Partial billing uses telescoping cumulative rounding keyed on
   * `opts.priorBilledQty` (the qty already billed by surviving invoices): each
   * bill's subtotal = round(S · (prior+bill)/Q) − round(S · prior/Q). This sums to
   * exactly `S` once the line is fully billed (no per-partial cent drift) and, for
   * a full bill from scratch (prior 0, bill = qty), copies `S` verbatim. On a
   * BUY_N_GET_M line the cumulative key is the PAID qty (raw minus the free units'
   * worth) so the prorated money agrees with the partial's whole-unit free
   * allocation — see the comment at the proration itself.
   */
  private buildInvoiceItemData(
    li: any,
    billQty: number,
    tenantId: string | null,
    opts?: { priorBilledQty?: number },
  ) {
    const orderQty = Number(li.qty) || 0;
    const storedSubtotal = li.subtotal != null ? Number(li.subtotal) : null;
    const unitPrice = Number(li.unitPrice);
    // Snapshot the box size: prefer the order line's own snapshot, fall back to the
    // live product for legacy rows created before the snapshot column shipped.
    const unitsPerBox = Number(li.unitsPerBox ?? li.product?.unitsPerBox ?? 0);
    const isBoxSplit = li.boxes != null; // stored WITH a box/piece split

    // Box/piece split for DISPLAY only (money is the stored subtotal). Selling-unit
    // and non-boxed lines keep boxes/pieces null so `qty` stays in whatever unit the
    // order line used — never re-interpreted as pieces.
    const split = isBoxSplit
      ? normalizeBoxesPieces({ qty: billQty, unitsPerBox })
      : { qty: billQty, boxes: null as number | null, pieces: null as number | null };

    const prior = Math.max(0, Number(opts?.priorBilledQty ?? 0));

    // BUY_N_GET_M: the order line's free-unit snapshot travels onto the invoice
    // line, allocated across partials by a CUMULATIVE floor (so Σ(partials) == the
    // order line's free units and a full bill copies it verbatim). The snapshot is
    // what keeps a later DRAFT edit from re-pricing the line to full.
    const storedFreeUnits = Math.max(0, Math.trunc(Number(li.promoFreeUnits ?? 0) || 0));
    const hasFreeUnits = storedFreeUnits > 0 && orderQty > 0;
    // A free unit is a whole SELLING unit: `unitsPerBox` pieces on a box-split line,
    // one qty unit on a selling-unit line.
    const freeUnitSize = isBoxSplit && unitsPerBox > 0 ? unitsPerBox : 1;
    const freeUnitsThrough = (cumQty: number) =>
      Math.min(storedFreeUnits, Math.floor((storedFreeUnits * Math.max(0, cumQty)) / orderQty));
    const promoFreeUnits = !hasFreeUnits
      ? storedFreeUnits
      : freeUnitsThrough(prior + billQty) - freeUnitsThrough(prior);

    // Free units are WHOLE units while the qty axis is pieces, so a subtotal prorated
    // over the raw qty disagrees with the floored free-unit allocation by up to one
    // unit price on a partial — and `update()` re-prices a DRAFT from the stored
    // `promoFreeUnits`, so a no-op re-save would move the money. Prorate over the PAID
    // quantity instead (raw minus the free units' worth): the stored subtotal then
    // equals `computeLineSubtotal(split, promoFreeUnits)` and the round-trip is
    // money-preserving, while Σ(partials) is still exactly the stored subtotal
    // (paid(0) = 0, paid(orderQty) = paidQty). Non-BOGO lines are untouched.
    const paidQty = orderQty - storedFreeUnits * freeUnitSize;
    const onPaidBasis = hasFreeUnits && paidQty > 0;
    const basisQty = onPaidBasis ? paidQty : orderQty;
    const billedThrough = (cumQty: number) =>
      onPaidBasis ? cumQty - freeUnitsThrough(cumQty) * freeUnitSize : cumQty;

    let subtotal: number;
    if (storedSubtotal == null || orderQty <= 0) {
      // Legacy/degenerate line with no stored money: fall back to the shared helper
      // using the STORED split (never a live re-split).
      subtotal = computeLineSubtotal({
        unitPrice,
        qty: split.qty,
        boxes: split.boxes,
        pieces: split.pieces,
        unitsPerBox,
        freeUnits: promoFreeUnits,
      });
    } else {
      // Telescoping cumulative rounding — exact and drift-free across partials.
      subtotal = roundMoney(
        roundMoney((storedSubtotal * billedThrough(prior + billQty)) / basisQty) -
          roundMoney((storedSubtotal * billedThrough(prior)) / basisQty),
      );
    }

    // RF-4: prorate the line's snapshotted category tax the SAME telescoping way as
    // the subtotal, so a partial / delivered-basis bill collects only its share and
    // Σ(partials) == the order line's full category tax. A full bill from scratch
    // (prior 0, billQty = orderQty) copies the stored amount verbatim.
    const storedCategoryTax = Number(li.categoryTaxAmount ?? 0);
    const categoryTaxAmount =
      storedCategoryTax === 0 || orderQty <= 0
        ? storedCategoryTax
        : roundMoney(
            roundMoney((storedCategoryTax * (prior + billQty)) / orderQty) -
              roundMoney((storedCategoryTax * prior) / orderQty),
          );

    return {
      // Catalog lines use the product name; unlisted lines carry a free-text `name`.
      description: li.product?.name ?? li.name ?? `Product`,
      productId: li.productId,
      // Provenance back to the source order line (null for freeform lines).
      orderItemId: li.id ?? null,
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox: unitsPerBox > 0 ? unitsPerBox : null,
      promoFreeUnits: promoFreeUnits > 0 ? promoFreeUnits : null,
      // MSRP snapshot — set below by the caller's applyMsrpSnapshots (null when
      // flag.msrp is off for the tenant).
      msrp: null as number | null,
      // Per-line note travels verbatim from the order line (buyer-visible).
      notes: li.notes ?? null,
      unitPrice,
      // `unitPrice` is ALREADY the net (post-override) price — the order stores the
      // override as a reduced unitPrice plus `originalPrice` for the strikethrough.
      // Re-deriving a `discount` from originalPrice here double-counts it: every
      // invoice consumer computes `computeLineSubtotal(unitPrice) - discount`, so a
      // line of {unitPrice 90, discount 10} would bill 80 for a 100→90 override.
      // Keep discount 0; the savings is shown via `originalPrice` (mirrors the order).
      discount: 0,
      originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
      priceType: li.priceType ?? "STANDARD",
      taxRate: 0,
      subtotal,
      // Phase 4 (W4): carry the line's regulated category onto the invoice line so
      // the split can group by it and reporting/ledger can read it. Prefer the
      // OrderItem sale-time snapshot; fall back to the live product category for
      // orders created before the snapshot shipped (best-effort — see resolveLineCategoryId).
      trackedCategoryId: li.trackedCategoryId ?? li.product?.trackedCategoryId ?? null,
      // RF-3: reporting-only subcategory snapshot, mirroring trackedCategoryId — prefer
      // the order-line snapshot, fall back to the live product for pre-RF-3 lines.
      trackedSubcategoryId: li.trackedSubcategoryId ?? li.product?.trackedSubcategoryId ?? null,
      categoryTaxAmount,
      ...(tenantId ? { tenantId } : {}),
    };
  }

  /**
   * Phase 4 (W4): partition an order's billable lines into invoice groups by
   * regulated category. The "standard" group (uncategorised lines + any category
   * whose invoiceTreatment is NOT SEPARATE_INVOICE — those fold into the main
   * invoice for now) comes first, then one group per SEPARATE_INVOICE category,
   * sorted by name for deterministic `-R1/-R2` numbering.
   *
   * When no SEPARATE_INVOICE-category lines are present the result is a SINGLE
   * group, so callers produce exactly one invoice — byte-identical to pre-split
   * behaviour. Category resolution prefers the OrderItem sale-time snapshot and
   * falls back to the live product category for orders created before W4.
   */
  private async groupOrderLinesForInvoicing(
    remainingItems: Array<{ li: any; remainingQty: number }>,
    db: any,
  ): Promise<
    Array<{ trackedCategoryId: string | null; category: any; items: typeof remainingItems }>
  > {
    const resolveCat = (li: any): string | null =>
      li.trackedCategoryId ?? li.product?.trackedCategoryId ?? null;

    const catIds = [
      ...new Set(remainingItems.map(({ li }) => resolveCat(li)).filter(Boolean)),
    ] as string[];
    const categories: any[] =
      catIds.length > 0 ? await db.trackedCategory.findMany({ where: { id: { in: catIds } } }) : [];
    const catMap = new Map<string, any>(categories.map((c: any) => [c.id, c]));
    const isSeparate = (id: string | null): boolean =>
      !!id && catMap.get(id)?.invoiceTreatment === "SEPARATE_INVOICE";

    const standard: typeof remainingItems = [];
    const byCat = new Map<string, typeof remainingItems>();
    let sawFolded = false;
    for (const entry of remainingItems) {
      const id = resolveCat(entry.li);
      if (isSeparate(id)) {
        const arr = byCat.get(id!) ?? [];
        arr.push(entry);
        byCat.set(id!, arr);
      } else {
        if (id) sawFolded = true; // a regulated category that isn't SEPARATE_INVOICE
        standard.push(entry);
      }
    }
    if (sawFolded) {
      this.logger.warn(
        "Regulated lines with a non-SEPARATE_INVOICE treatment were folded into the standard invoice (SEPARATE_SECTION / LINE_TAX presentation is a deferred follow-up).",
      );
    }

    const groups: Array<{ trackedCategoryId: string | null; category: any; items: any[] }> = [];
    if (standard.length > 0)
      groups.push({ trackedCategoryId: null, category: null, items: standard });
    for (const { trackedCategoryId, category, items } of [...byCat.entries()]
      .map(([id, items]) => ({ trackedCategoryId: id, category: catMap.get(id), items }))
      .sort((a, b) => String(a.category?.name ?? "").localeCompare(String(b.category?.name ?? ""))))
      groups.push({ trackedCategoryId, category, items });

    // remainingItems is always non-empty here, so groups is non-empty; guard anyway.
    if (groups.length === 0)
      groups.push({ trackedCategoryId: null, category: null, items: remainingItems });
    return groups;
  }

  /**
   * Phase 4 (W4): build + create the (possibly split) invoices for an order.
   * One invoice per SEPARATE_INVOICE category + one standard invoice; siblings
   * share an `invoiceGroupId` and are numbered base / base-R1 / base-R2…. Returns
   * every created invoice. For a single-group order this creates exactly one
   * invoice with `invoiceGroupId=null` (identical to pre-W4).
   *
   * Money: each group's subtotal is the sum of its line subtotals; the order's
   * regular tax is allocated proportionally by subtotal with the LARGEST group
   * absorbing the rounding remainder, so Σ(group regular tax) == the single-invoice
   * tax exactly. RF-4: the per-line category (regulated) tax is summed per group and
   * added on top — because every order line lands in exactly one group, Σ(group
   * category tax) == the order's category tax, so Σ(sibling total) == the order total
   * (subtotal + regular tax + category tax) to the cent. A tax-exempt customer owes
   * $0 of BOTH taxes (foldCategoryTax zeroes the per-line snapshots too).
   */
  private async createSplitInvoices(params: {
    order: any;
    remainingItems: Array<{ li: any; remainingQty: number }>;
    isTaxExempt: boolean;
    db: any;
    tenantId: string | null;
    extraInvoiceData: Record<string, any>;
    include: any;
  }): Promise<any[]> {
    const { order, remainingItems, isTaxExempt, db, tenantId, extraInvoiceData, include } = params;

    // W6b backstop: re-run the license guard at invoice time. Catches a regulated
    // line added to the order after its create-time guard (buyer merge) or a license
    // that EXPIRED between order creation and invoicing. Runs before any invoice row
    // is written (inside the tx), so a block never half-creates. Category resolves
    // from the line snapshot or the live product (mirrors buildInvoiceItemData).
    // orderId is passed so ORDER-scoped §8 overrides apply.
    await this.authGuard.assertAuthorizedOrThrow({
      customerId: order.customerId,
      lines: remainingItems.map(({ li }) => ({
        trackedCategoryId: li.trackedCategoryId ?? li.product?.trackedCategoryId ?? null,
      })),
      orderId: order.id,
    });

    const groups = await this.groupOrderLinesForInvoicing(remainingItems, db);

    const orderSubtotal = Number(order.subtotal) || 1;
    const orderTax = Number(order.tax) || 0;

    const groupData = groups.map((g) => {
      const itemsData = g.items.map(({ li, remainingQty }: any) =>
        // remainingQty = qty − invoicedQty, so prior + bill reaches the full line
        // qty and the stored subtotal is copied exactly (minus what prior invoices
        // already billed, via the telescoping rounding in buildInvoiceItemData).
        this.buildInvoiceItemData(li, remainingQty, tenantId, {
          priorBilledQty: Number(li.invoicedQty ?? 0),
        }),
      );
      const subtotal = roundMoney(itemsData.reduce((s: number, it: any) => s + it.subtotal, 0));
      // RF-4: Σ the per-line category tax for this group (0 when the customer is
      // tax-exempt — foldCategoryTax also zeroes the per-line snapshots then).
      const categoryTax = this.foldCategoryTax(itemsData, isTaxExempt);
      return {
        g,
        itemsData,
        subtotal,
        categoryTax,
        regularTax: 0,
        taxAmount: 0,
        shippingFee: 0,
        total: 0,
      };
    });
    // Snapshot MSRP on every group's lines (each sibling invoice bills the same
    // customer, so one map lookup set per group).
    for (const gd of groupData) {
      await this.applyMsrpSnapshots(db, order.customerId, gd.itemsData);
    }

    const totalSubtotal = roundMoney(groupData.reduce((s, gd) => s + gd.subtotal, 0));
    const totalRegularTax = isTaxExempt
      ? 0
      : roundMoney(orderTax * (totalSubtotal / orderSubtotal));
    // Allocate the order's regular tax proportionally by subtotal, then give the
    // rounding remainder to the LARGEST-subtotal group — never a tiny trailing
    // group, which could otherwise round to a NEGATIVE tax. Σ(group tax) still
    // equals the single-invoice tax exactly, so siblings sum to the order total.
    if (isTaxExempt) {
      groupData.forEach((gd) => {
        gd.regularTax = 0;
      });
    } else {
      let allocated = 0;
      groupData.forEach((gd) => {
        gd.regularTax = roundMoney(orderTax * (gd.subtotal / orderSubtotal));
        allocated = roundMoney(allocated + gd.regularTax);
      });
      const remainder = roundMoney(totalRegularTax - allocated);
      if (remainder !== 0 && groupData.length > 0) {
        let maxIdx = 0;
        for (let i = 1; i < groupData.length; i++)
          if (groupData[i].subtotal > groupData[maxIdx].subtotal) maxIdx = i;
        groupData[maxIdx].regularTax = roundMoney(groupData[maxIdx].regularTax + remainder);
      }
    }
    // Order-level shipping fee: the WHOLE remaining fee rides on exactly ONE
    // sibling — the largest-subtotal group (same recipient rule as the tax
    // rounding remainder). Never prorated, so Σ(sibling totals) still equals the
    // order total to the cent. "Remaining" defends against re-entry when some
    // non-void invoice for this order already carries fee dollars.
    const orderFee = roundMoney(Number((order as any).shippingFee ?? 0));
    if (orderFee > 0 && groupData.length > 0) {
      const priorFeeAgg = await db.invoice.aggregate({
        where: { orderId: order.id, status: { not: InvoiceStatus.VOID } },
        _sum: { shippingFee: true },
      });
      const feeRemaining = Math.max(
        0,
        roundMoney(orderFee - Number(priorFeeAgg._sum.shippingFee ?? 0)),
      );
      if (feeRemaining > 0) {
        let feeIdx = 0;
        for (let i = 1; i < groupData.length; i++)
          if (groupData[i].subtotal > groupData[feeIdx].subtotal) feeIdx = i;
        groupData[feeIdx].shippingFee = feeRemaining;
      }
    }
    groupData.forEach((gd) => {
      gd.taxAmount = roundMoney(gd.regularTax + gd.categoryTax);
      gd.total = roundMoney(gd.subtotal + gd.taxAmount + gd.shippingFee);
    });

    const multi = groupData.length > 1;
    const baseNumber = await this.generateInvoiceNumber(db);
    const invoiceGroupId = multi ? randomUUID() : null;

    // Create every sibling invoice + its ledger rows + the invoicedQty bumps
    // ATOMICALLY. A mid-batch failure (e.g. a ledger write on invoice 2) must not
    // leave invoice 1 committed while invoicedQty stays un-bumped — a retry would
    // then double-invoice. When a caller already passed a tx (txClient) we run
    // inline (already inside their transaction); otherwise we open one.
    const runCreation = async (tx: any): Promise<any[]> => {
      const out: any[] = [];
      for (let i = 0; i < groupData.length; i++) {
        const gd = groupData[i];
        const invoiceNumber = i === 0 ? baseNumber : `${baseNumber}-R${i}`;
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber,
            customerId: order.customerId,
            orderId: order.id,
            status: InvoiceStatus.DRAFT,
            subtotal: gd.subtotal,
            taxAmount: gd.taxAmount,
            discount: 0,
            shippingFee: gd.shippingFee,
            total: gd.total,
            ...(invoiceGroupId ? { invoiceGroupId } : {}),
            ...extraInvoiceData,
            items: { create: gd.itemsData },
            ...(tenantId ? { tenantId } : {}),
          },
          include,
        });
        out.push(inv);
        // W5: write the regulated-sales ledger from this invoice's regulated lines
        // (built off the created items, so invoiceItemId is real). orderItemId
        // provenance now flows through from the invoice item's stored order-line link.
        await this.ledger.writeSaleEntries({
          tenantId,
          orderId: order.id,
          invoiceId: inv.id,
          soldAt: inv.issueDate ?? new Date(),
          lines: (inv.items ?? []).map((it: any) => ({
            invoiceItemId: it.id,
            orderItemId: it.orderItemId ?? null,
            trackedCategoryId: it.trackedCategoryId ?? null,
            trackedSubcategoryId: it.trackedSubcategoryId ?? null,
            qty: Number(it.qty),
            netSales: Number(it.subtotal),
            categoryTax: Number(it.categoryTaxAmount ?? 0),
          })),
          db: tx,
        });
      }
      // Bump invoicedQty once per order item (each belongs to exactly one group).
      for (const { li, remainingQty } of remainingItems) {
        await tx.orderItem.update({
          where: { id: li.id },
          data: { invoicedQty: { increment: remainingQty } },
        });
      }
      // Apply any order-selected credit notes to the freshly created invoice(s).
      // Pass the effective tenantId explicitly: this runs on an unwrapped tx in the
      // fire-and-forget path (createInvoiceFromOrderWithTenant), where the tenant
      // proxy can't inject it and the credit payment would be tenant-orphaned.
      await this.creditNotes.settleOrderCreditsInTx(tx, order.id, tenantId);
      return out;
    };

    try {
      return db === this.prisma
        ? await this.prisma.tenantTransaction(runCreation)
        : await runCreation(db);
    } catch (err: any) {
      if (err?.code === "P2002")
        throw new ConflictException("Invoice number conflict — please retry.");
      throw err;
    }
  }

  /** The order's single open "pending mirror" draft, or null. */
  async findOpenOrderDraft(orderId: string, tx?: any) {
    const db = tx ?? this.prisma.forTenant();
    return db.invoice.findFirst({
      where: { orderId, status: InvoiceStatus.DRAFT, deliveryBatchId: null },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Re-sync the order's open pending-mirror draft to the order. No-op (returns
   * null) when the order has no open draft.
   *  - basis "order"     → mirror the full (non-cancelled) order line items.
   *  - basis "delivered" → bill only the delivered quantity per line (uses the
   *    cumulative OrderItem.deliveredQty, so it's idempotent across batches and
   *    excludes refused/zero lines).
   * Keeps the invoice DRAFT, rebuilds its items, recomputes totals (proportional
   * tax-exempt-aware), and RESETS each OrderItem.invoicedQty to exactly the qty
   * this draft now bills (0 for unbilled lines) — the draft is the order's sole
   * consumer, so set-not-increment stays correct on repeat.
   *
   * SIBLING-AWARE for splits: a regulated SEPARATE_INVOICE order has base + -R# open
   * drafts. `reconcileSplitOrderDrafts` rebuilds each from its OWN category group so the
   * base never folds in a sibling's line (which would double-bill). It only handles a
   * clean split; a single-group order (or any unclean case) falls through to the legacy
   * single-draft rebuild below, byte-identical to before.
   */
  async reconcileOrderDraftInvoice(
    orderId: string,
    opts: { basis: "order" | "delivered"; tx?: any },
  ) {
    const db = opts.tx ?? this.prisma.forTenant();
    const split = await this.reconcileSplitOrderDrafts(orderId, opts.basis, db);
    if (split) return split;

    const draft = await this.findOpenOrderDraft(orderId, db);
    if (!draft) return null;

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: {
              select: {
                name: true,
                unitsPerBox: true,
                trackedCategoryId: true,
                trackedSubcategoryId: true,
              },
            },
          },
        },
      },
    });
    if (!order) return null;

    const tenantId = this.prisma.getTenantId();
    const billable = order.lineItems
      .map((li: any) => ({
        li,
        billQty: opts.basis === "delivered" ? Number(li.deliveredQty ?? 0) : Number(li.qty),
      }))
      .filter((x: any) => x.billQty > 0.001);

    const itemsData = billable.map(({ li, billQty }: any) =>
      this.buildInvoiceItemData(li, billQty, tenantId),
    );
    await this.applyMsrpSnapshots(db, order.customerId, itemsData);
    const subtotal = roundMoney(itemsData.reduce((s: number, it: any) => s + it.subtotal, 0));

    const customer = await db.customer.findFirst({
      where: { id: order.customerId },
      select: { isTaxExempt: true },
    });
    const isTaxExempt = !!customer?.isTaxExempt;
    const orderSubtotal = Number(order.subtotal) || 1;
    const proportion = subtotal / orderSubtotal;
    const regularTax = isTaxExempt ? 0 : roundMoney(Number(order.tax) * proportion);
    // RF-4: fold the per-line category tax into the draft's tax (exempt → 0 for both).
    const categoryTax = this.foldCategoryTax(itemsData, isTaxExempt);
    const taxAmount = roundMoney(regularTax + categoryTax);
    // Order-driven reconcile: the ORDER owns the fee. Subtract fee dollars already
    // carried by OTHER non-void invoices of this order (split/partial siblings) so
    // Σ(invoice fees) == order.shippingFee stays exact.
    const otherFeeAgg = await db.invoice.aggregate({
      where: { orderId, status: { not: InvoiceStatus.VOID }, id: { not: draft.id } },
      _sum: { shippingFee: true },
    });
    const draftFee = Math.max(
      0,
      roundMoney(
        Number((order as any).shippingFee ?? 0) - Number(otherFeeAgg._sum.shippingFee ?? 0),
      ),
    );
    const total = roundMoney(subtotal - Number(draft.discount ?? 0) + draftFee + taxAmount);

    await db.invoiceItem.deleteMany({ where: { invoiceId: draft.id } });
    const updated = await db.invoice.update({
      where: { id: draft.id },
      data: {
        subtotal,
        taxAmount,
        shippingFee: draftFee,
        total,
        status: InvoiceStatus.DRAFT,
        pdfUrl: null,
        items: { create: itemsData },
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: true,
      },
    });

    // NOTE: the ledger is re-synced ONLY on the sibling-aware paths (rebuildSiblingDrafts).
    // This legacy single-draft rebuild is group-UNAWARE — for a bailed split it folds the
    // regulated line onto the base while the -R# sibling's SALE row stays live, so writing
    // a SALE here would double-count. Leave the ledger untouched (pre-existing behavior).

    // Reset invoicedQty on every order line to exactly what this draft bills.
    const billMap = new Map<string, number>(
      billable.map(({ li, billQty }: any) => [li.id, billQty]),
    );
    const allLines = await db.orderItem.findMany({ where: { orderId }, select: { id: true } });
    for (const ol of allLines) {
      await db.orderItem.update({
        where: { id: ol.id },
        data: { invoicedQty: billMap.get(ol.id) ?? 0 },
      });
    }

    return updated;
  }

  /**
   * Delivered-basis reconcile that is SIBLING-AWARE. Where reconcileOrderDraftInvoice
   * rebuilds a SINGLE draft from EVERY order line (group-unaware — unsafe for a split
   * order), this rebuilds EACH of the order's open DRAFT invoices from ONLY its own
   * order lines: the partition createSplitInvoices established, read back via each
   * InvoiceItem.orderItemId provenance. So a regulated SEPARATE_INVOICE order (base +
   * -R# siblings) bills every line on exactly ONE invoice at its delivered qty — no
   * line folds onto the base while a sibling still bills it (no double-bill), and a
   * refused line (deliveredQty 0) bills 0.
   *
   * SAFE only when the open DRAFTs are a CLEAN per-line partition (createSplitInvoices
   * siblings / a lone pending-mirror). It BAILS (returns null, leaving the invoices as
   * created) the moment provenance is not clean — a line shared by two open drafts, or
   * a line also billed by a finalized / delivery-batch invoice. Both are reachable
   * (createPartialFromOrder, or a prior group-unaware basis:"order" reconcile);
   * rebuilding those from a prior of 0 would double- or over-bill, so we prefer the
   * conservative full-qty bill there — NEVER a double.
   *
   * For a single-group order (one draft owning every line) this is byte-identical to
   * reconcileOrderDraftInvoice(basis:"delivered"). Order tax is allocated across the
   * siblings proportionally by delivered subtotal with the largest-subtotal sibling
   * absorbing the rounding remainder (mirrors createSplitInvoices), so on a CLEAN full
   * delivery Σ(sibling total) == order total to the cent. Each line's invoicedQty is
   * reset to what its one sibling now bills (0 for refused) — a plain SET since a line
   * belongs to a single sibling. No-op (null) when the order has no open draft.
   *
   * Re-syncs the regulated-sales ledger to the rebuilt qty via `resyncInvoiceLedger`
   * (in the shared rebuildSiblingDrafts core) — a short/refused regulated line now
   * reports its delivered qty, not the full-order qty createSplitInvoices first wrote.
   */
  async reconcileOrderDeliveredInvoices(orderId: string, tx?: any) {
    const db = tx ?? this.prisma.forTenant();
    // All the order's live invoices — so we can tell the open pending/sibling DRAFTs
    // (status DRAFT, deliveryBatchId null) apart from finalized or delivery-batch
    // invoices that already bill some of the lines.
    const invoices = await db.invoice.findMany({
      where: { orderId, status: { not: InvoiceStatus.VOID } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        deliveryBatchId: true,
        discount: true,
        shippingFee: true,
        items: { select: { orderItemId: true } },
      },
    });
    const drafts = invoices.filter(
      (i: any) => i.status === InvoiceStatus.DRAFT && i.deliveryBatchId == null,
    );
    if (drafts.length === 0) return null;

    // Provenance is a clean per-line partition only for createSplitInvoices siblings /
    // a lone mirror. BAIL if a member line is also billed by a finalized (non-open-
    // draft) invoice, or is shared across two open drafts — rebuilding those from a
    // prior of 0 would double- or over-bill. Conservative: leave them as created.
    const finalized = invoices.filter(
      (i: any) => !(i.status === InvoiceStatus.DRAFT && i.deliveryBatchId == null),
    );
    // A finalized OR draft line with no orderItemId provenance (legacy pre-provenance
    // rows, or a manually added / freeform invoice line) can't be matched to an order
    // line, so we can't prove the partition is clean — bail rather than risk an
    // over-bill (finalized) or an under-bill (dropping an untracked draft line).
    const hasUntracked = (i: any) => (i.items ?? []).some((it: any) => !it.orderItemId);
    if (finalized.some(hasUntracked) || drafts.some(hasUntracked)) return null;
    const finalizedLineIds = new Set<string>(
      finalized
        .flatMap((i: any) => (i.items ?? []).map((it: any) => it.orderItemId))
        .filter(Boolean),
    );
    const seen = new Set<string>();
    for (const d of drafts) {
      for (const it of d.items ?? []) {
        const id = it.orderItemId as string;
        if (seen.has(id) || finalizedLineIds.has(id)) return null; // not a clean partition
        seen.add(id);
      }
    }

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: {
              select: {
                name: true,
                unitsPerBox: true,
                trackedCategoryId: true,
                trackedSubcategoryId: true,
              },
            },
          },
        },
      },
    });
    if (!order) return null;

    // Partition the order's lines by WHICH draft already bills them (the invoice item's
    // orderItemId == the createSplitInvoices grouping — clean because the guard above
    // proved no line is shared across drafts or with a finalized invoice), then rebuild
    // each draft from its own lines on the delivered basis.
    const lineById = new Map<string, any>(order.lineItems.map((li: any) => [li.id, li]));
    const pairs = drafts.map((d: any) => {
      const memberIds = [
        ...new Set((d.items ?? []).map((it: any) => it.orderItemId).filter(Boolean)),
      ] as string[];
      return { draft: d, lines: memberIds.map((id) => lineById.get(id)).filter(Boolean) };
    });
    return this.rebuildSiblingDrafts(order, pairs, "delivered", db);
  }

  /**
   * Re-sync the regulated-sales ledger after a reconcile rebuilt ONE draft's items:
   * REVERSE the invoice's prior SALE rows (nets the old qty to 0, booked in the current
   * period per the ledger's never-backdate rule), then write fresh SALE rows from the new
   * items — so a short-picked / edited regulated line reports its RECONCILED qty, not the
   * full-order qty createSplitInvoices first wrote. A no-op for a non-regulated invoice
   * (the ledger service early-returns when there are no SALE rows / no regulated lines).
   *
   * Called ONLY from rebuildSiblingDrafts (the sibling-aware clean-partition paths), where
   * each draft owns a disjoint set of lines — never from the group-unaware legacy rebuild,
   * which would double-count a folded regulated line against its live sibling SALE.
   *
   * Uses `reverseInvoiceEntries({preserveReturns: true})` — it cancels only the
   * sale-record and LEAVES any prior RETURN / credit-note reversal standing, so a
   * re-reconcile after a received return nets to (delivered − returned), not delivered.
   * Idempotent across repeat re-syncs (a prior re-sync reversal has no returnId, so it's
   * counted; the old line finds 0 remaining and is skipped). The delivered-payment path
   * runs at delivery before any return exists, so it's unaffected either way.
   */
  private async resyncInvoiceLedger(
    invoiceId: string,
    orderId: string | null,
    items: any[],
    db: any,
  ): Promise<void> {
    // preserveReturns: cancel only the sale-record, leave any return/credit-note reversal
    // standing, so a re-reconcile after a return nets to (delivered − returned).
    await this.ledger.reverseInvoiceEntries({ invoiceId, db, preserveReturns: true });
    await this.ledger.writeSaleEntries({
      tenantId: this.prisma.getTenantId(),
      orderId,
      invoiceId,
      soldAt: new Date(),
      lines: (items ?? []).map((it: any) => ({
        invoiceItemId: it.id,
        orderItemId: it.orderItemId ?? null,
        trackedCategoryId: it.trackedCategoryId ?? null,
        trackedSubcategoryId: it.trackedSubcategoryId ?? null,
        qty: Number(it.qty),
        netSales: Number(it.subtotal),
        categoryTax: Number(it.categoryTaxAmount ?? 0),
      })),
      db,
    });
  }

  /**
   * Shared sibling-aware rebuild core for reconcileOrderDeliveredInvoices and
   * reconcileOrderDraftInvoice's split path. Rebuilds each (draft, lines) pair from ONLY
   * its own lines at `billQty` (basis "order" → li.qty, "delivered" → li.deliveredQty),
   * allocates the order's regular tax across the drafts by subtotal (rounding remainder
   * to the largest, mirroring createSplitInvoices → Σ == the single-invoice tax), keeps
   * each DRAFT, and SETs each line's invoicedQty to what its one draft now bills (each
   * line belongs to exactly one draft). Callers guarantee the pairs are a CLEAN per-line
   * partition of the order (no line on two drafts, none also on a finalized invoice).
   */
  private async rebuildSiblingDrafts(
    order: any,
    pairs: Array<{ draft: any; lines: any[] }>,
    basis: "order" | "delivered",
    db: any,
    opts?: { preserveStatus?: boolean },
  ): Promise<any[]> {
    const tenantId = this.prisma.getTenantId();
    const customer = await db.customer.findFirst({
      where: { id: order.customerId },
      select: { isTaxExempt: true },
    });
    const isTaxExempt = !!customer?.isTaxExempt;
    const orderSubtotal = Number(order.subtotal) || 1;
    const orderTax = Number(order.tax) || 0;
    const billQtyOf = (li: any) =>
      basis === "delivered" ? Number(li.deliveredQty ?? 0) : Number(li.qty);

    const perDraft = pairs.map(({ draft, lines }) => {
      const billable = lines
        .map((li: any) => ({ li, billQty: billQtyOf(li) }))
        .filter((x: any) => x.billQty > 0.001);
      const itemsData = billable.map(({ li, billQty }: any) =>
        this.buildInvoiceItemData(li, billQty, tenantId),
      );
      const subtotal = roundMoney(itemsData.reduce((s: number, it: any) => s + it.subtotal, 0));
      // RF-4: per-draft category tax (0 + zeroed snapshots when the customer is exempt).
      const categoryTax = this.foldCategoryTax(itemsData, isTaxExempt);
      return {
        draft,
        lines,
        billable,
        itemsData,
        subtotal,
        categoryTax,
        regularTax: 0,
        taxAmount: 0,
        shippingFee: 0,
        total: 0,
      };
    });
    // Snapshot MSRP on every sibling draft's rebuilt lines.
    for (const pd of perDraft) {
      await this.applyMsrpSnapshots(db, order.customerId, pd.itemsData);
    }

    if (!isTaxExempt && orderTax !== 0) {
      const totalSubtotal = roundMoney(perDraft.reduce((s, pd) => s + pd.subtotal, 0));
      const totalTax = roundMoney(orderTax * (totalSubtotal / orderSubtotal));
      let allocated = 0;
      perDraft.forEach((pd) => {
        pd.regularTax = roundMoney(orderTax * (pd.subtotal / orderSubtotal));
        allocated = roundMoney(allocated + pd.regularTax);
      });
      const remainder = roundMoney(totalTax - allocated);
      if (remainder !== 0 && perDraft.length > 0) {
        let maxIdx = 0;
        for (let i = 1; i < perDraft.length; i++)
          if (perDraft[i].subtotal > perDraft[maxIdx].subtotal) maxIdx = i;
        perDraft[maxIdx].regularTax = roundMoney(perDraft[maxIdx].regularTax + remainder);
      }
    }
    // Sibling fee placement. If the current sibling fees already sum to the order
    // fee, keep each sibling's own placement (an operator may have moved the fee
    // to a specific sibling via an invoice edit — that edit back-synced the order,
    // so the sums agree). On mismatch (the fee changed on the order side) re-seed
    // the whole fee onto the largest-subtotal sibling and zero the rest — mirrors
    // createSplitInvoices.
    const orderFee = roundMoney(Number(order.shippingFee ?? 0));
    const currentFeeSum = roundMoney(
      perDraft.reduce((s, pd) => s + Number(pd.draft.shippingFee ?? 0), 0),
    );
    if (currentFeeSum === orderFee) {
      perDraft.forEach((pd) => {
        pd.shippingFee = roundMoney(Number(pd.draft.shippingFee ?? 0));
      });
    } else {
      let maxIdx = 0;
      for (let i = 1; i < perDraft.length; i++)
        if (perDraft[i].subtotal > perDraft[maxIdx].subtotal) maxIdx = i;
      perDraft.forEach((pd, i) => {
        pd.shippingFee = i === maxIdx ? orderFee : 0;
      });
    }
    perDraft.forEach((pd) => {
      // RF-4: tax = allocated regular tax + this draft's category tax (both exempt-0).
      pd.taxAmount = roundMoney(pd.regularTax + pd.categoryTax);
      pd.total = roundMoney(
        pd.subtotal - Number(pd.draft.discount ?? 0) + pd.shippingFee + pd.taxAmount,
      );
    });

    const updated: any[] = [];
    for (const pd of perDraft) {
      // Status: the sibling-draft callers force DRAFT (open pending mirrors). R1's
      // post-delivery edit resync passes preserveStatus so a finalized/paid invoice
      // KEEPS its lifecycle — recompute it from its retained payments against the new
      // total (recomputeStatus leaves DRAFT/VOID/WRITTEN_OFF terminal, so an open draft
      // still stays DRAFT). This is what surfaces the "new balance" on a paid edit.
      let nextStatus: InvoiceStatus = InvoiceStatus.DRAFT;
      if (opts?.preserveStatus) {
        // Exclude VOID payments (a bounced check reverses to VOID) — mirrors the
        // balanceDue math in findAll/findOne so the recomputed status agrees.
        const paid = (pd.draft.payments ?? [])
          .filter((p: any) => p.status !== "VOID")
          .reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
        nextStatus = this.recomputeStatus(
          paid,
          pd.total,
          pd.draft.dueDate ?? null,
          pd.draft.status,
        );
      }
      await db.invoiceItem.deleteMany({ where: { invoiceId: pd.draft.id } });
      const inv = await db.invoice.update({
        where: { id: pd.draft.id },
        data: {
          subtotal: pd.subtotal,
          taxAmount: pd.taxAmount,
          shippingFee: pd.shippingFee,
          total: pd.total,
          status: nextStatus,
          // Invalidate a cached PDF only when the invoice is (re)opened as a DRAFT; a
          // preserved finalized invoice keeps regenerating on demand anyway.
          pdfUrl: null,
          items: { create: pd.itemsData },
        },
        include: { items: true },
      });
      updated.push(inv);
      // Re-sync the regulated-sales ledger to the rebuilt qty (no-op for non-regulated).
      await this.resyncInvoiceLedger(pd.draft.id, order.id, inv.items ?? [], db);
      // Sales agents & commissions: only an ISSUED invoice (not the freshly
      // rebuilt open DRAFT pending-mirror) can carry commission — this is
      // what fires when a post-delivery order edit rewrites the money of an
      // already-issued invoice via resyncOrderInvoicesForEdit(preserveStatus:true).
      if (nextStatus !== InvoiceStatus.DRAFT) {
        await this.commissionEngine.syncInvoiceCommissionSafe(pd.draft.id, db);
      }
      // SET each of this draft's lines' invoicedQty to what it now bills (0 for a
      // line billed 0 — refused/short). Each line belongs to one draft → SET, not add.
      const billMap = new Map<string, number>(
        pd.billable.map(({ li, billQty }: any) => [li.id, billQty]),
      );
      for (const li of pd.lines) {
        await db.orderItem.update({
          where: { id: li.id },
          data: { invoicedQty: billMap.get(li.id) ?? 0 },
        });
      }
    }
    return updated;
  }

  /**
   * R1 — re-sync an order's linked invoice(s) after a POST-DELIVERY edit. Where
   * reconcileOrderDraftInvoice only touches the open pending-mirror DRAFT, this also
   * rebuilds SENT / PAID / OVERDUE / delivery-batch invoices IN PLACE:
   *   • each invoice is rebuilt from its OWN order lines at the edited order qty
   *     (basis "order"), via the shared rebuildSiblingDrafts core;
   *   • the regulated-sales ledger re-syncs to the new qty (resyncInvoiceLedger);
   *   • payments are KEPT and status/balance recompute from them (preserveStatus) —
   *     a paid invoice simply shows the new balance (owes more, or is over-paid);
   *   • a NEW line added during the edit (no invoice provenance yet) attaches to the
   *     invoice that already bills its regulated category (its -R# sibling; the base
   *     for standard lines) so a SEPARATE_INVOICE split keeps one-invoice-per-category,
   *     falling back to the order's primary invoice — so it is billed + ledgered rather
   *     than dropped.
   *
   * Returns the updated invoices, or NULL when the order has no linked non-void
   * invoice, or when the partition is not clean/provable (a line shared across two
   * invoices, or an invoice line with no orderItemId provenance) — in which case it
   * BAILS rather than risk a double-bill, leaving the invoices as-is. Runs in its own
   * transaction when none is supplied (mirrors the post-commit reconcile call site).
   *
   * PRECONDITION (caller-enforced): the order must be either wholly un-invoiced OR
   * wholly invoiced (EVERY billable line's cumulative invoicedQty == its qty) — never
   * partially invoiced, whether that's a line billed for only part of its qty OR a
   * subset of lines billed at full qty while others are un-invoiced. `updateOrderItems`
   * gates this on the pre-edit invoicedQty (`anyInvoiced && !allFullyInvoiced` → skip),
   * because this method rebuilds each invoice at the full current line qty and would
   * otherwise expand an already-issued invoice to cover units/lines it never billed.
   */
  async resyncOrderInvoicesForEdit(orderId: string, tx?: any): Promise<any[] | null> {
    const run = async (db: any): Promise<any[] | null> => {
      const invoices = await db.invoice.findMany({
        where: { orderId, status: { not: InvoiceStatus.VOID } },
        // invoiceNumber tiebreak: split siblings share a createdAt (one tx timestamp),
        // so createdAt alone is non-deterministic for picking the primary/base.
        orderBy: [{ createdAt: "asc" }, { invoiceNumber: "asc" }],
        select: {
          id: true,
          status: true,
          deliveryBatchId: true,
          discount: true,
          shippingFee: true,
          dueDate: true,
          items: { select: { orderItemId: true } },
          payments: { select: { amount: true, status: true } },
        },
      });
      if (invoices.length === 0) return null;

      // Can't prove which order line a provenance-less (manual/freeform) invoice line
      // bills → can't safely rebuild it. Bail conservatively.
      const hasUntracked = (i: any) => (i.items ?? []).some((it: any) => !it.orderItemId);
      if (invoices.some(hasUntracked)) return null;

      // Map each order line → the ONE invoice that already bills it. A line shared by
      // two invoices is an unclean partition (double-bill risk) → bail.
      const invoiceByLine = new Map<string, string>();
      for (const inv of invoices) {
        for (const it of inv.items ?? []) {
          const oid = it.orderItemId as string;
          if (invoiceByLine.has(oid)) return null; // shared → unclean
          invoiceByLine.set(oid, inv.id);
        }
      }

      const order = await db.order.findUnique({
        where: { id: orderId },
        include: {
          lineItems: {
            where: { status: { not: "CANCELLED" } },
            include: {
              product: {
                select: {
                  name: true,
                  unitsPerBox: true,
                  trackedCategoryId: true,
                  trackedSubcategoryId: true,
                },
              },
            },
          },
        },
      });
      if (!order) return null;

      // Primary invoice new (unprovenanced) lines fall back to: the sole open pending
      // mirror if present, else the earliest invoice. For a single-invoice order this
      // is simply that one invoice, so it bills every current line.
      const primaryId =
        invoices.find((i: any) => i.status === InvoiceStatus.DRAFT && i.deliveryBatchId == null)
          ?.id ?? invoices[0].id;

      // Category → the invoice that already bills that regulated category (built from
      // each invoice's provenance-owned lines; "" = standard/non-regulated). A NEW line
      // attaches to its category's invoice so a SEPARATE_INVOICE split keeps regulated
      // lines on their -R# sibling instead of co-mingling onto the base. A category
      // billed by two invoices is ambiguous → its new lines fall back to primary.
      const categoryOwner = new Map<string, string>();
      const categoryAmbiguous = new Set<string>();
      for (const li of order.lineItems) {
        const owner = invoiceByLine.get(li.id);
        if (!owner) continue; // unprovenanced line — nothing to map from yet
        const cat = li.trackedCategoryId ?? "";
        const prev = categoryOwner.get(cat);
        if (prev === undefined) categoryOwner.set(cat, owner);
        else if (prev !== owner) categoryAmbiguous.add(cat);
      }

      const linesByInvoice = new Map<string, any[]>();
      for (const inv of invoices) linesByInvoice.set(inv.id, []);
      for (const li of order.lineItems) {
        const cat = li.trackedCategoryId ?? "";
        const invId =
          invoiceByLine.get(li.id) ??
          (categoryAmbiguous.has(cat) ? undefined : categoryOwner.get(cat)) ??
          primaryId;
        linesByInvoice.get(invId)!.push(li);
      }
      const pairs = invoices.map((inv: any) => ({
        draft: inv,
        lines: linesByInvoice.get(inv.id) ?? [],
      }));

      const updated = await this.rebuildSiblingDrafts(order, pairs, "order", db, {
        preserveStatus: true,
      });

      // Clear invoicedQty on any order line NO LONGER billed (removed / soft-cancelled
      // during the edit) — rebuildSiblingDrafts only re-sets the lines it rebuilt.
      const billedIds = new Set<string>(order.lineItems.map((li: any) => li.id));
      const allLines = await db.orderItem.findMany({ where: { orderId }, select: { id: true } });
      for (const ol of allLines) {
        if (!billedIds.has(ol.id)) {
          await db.orderItem.update({ where: { id: ol.id }, data: { invoicedQty: 0 } });
        }
      }
      return updated;
    };

    return tx ? run(tx) : this.prisma.tenantTransaction(run);
  }

  /**
   * Sibling-aware "order"/"delivered"-basis rebuild for a regulated SEPARATE_INVOICE
   * order whose createSplitInvoices left it with base + -R# open DRAFTs. Partitions the
   * CURRENT (non-cancelled) order lines by category (groupOrderLinesForInvoicing — so an
   * edit that added/removed lines still rebuilds each sibling from its own CURRENT lines,
   * which provenance can't) and rebuilds each draft from only its group. Returns the
   * updated invoices, or NULL when this isn't a clean split it can safely handle (a
   * single draft, a finalized invoice already billing part of the order, a group/draft
   * count mismatch, or an ambiguous category match) — the caller then falls back to the
   * legacy single-draft rebuild.
   */
  private async reconcileSplitOrderDrafts(
    orderId: string,
    basis: "order" | "delivered",
    db: any,
  ): Promise<any[] | null> {
    const invoices = await db.invoice.findMany({
      where: { orderId, status: { not: InvoiceStatus.VOID } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        deliveryBatchId: true,
        discount: true,
        shippingFee: true,
        items: { select: { orderItemId: true, trackedCategoryId: true } },
      },
    });
    const drafts = invoices.filter(
      (i: any) => i.status === InvoiceStatus.DRAFT && i.deliveryBatchId == null,
    );
    if (drafts.length <= 1) return null; // single-group → legacy path (byte-identical)
    // A finalized / delivery-batch invoice already bills part of the order; a full
    // rebuild across the drafts would double-count it. Bail to the legacy path.
    if (invoices.length !== drafts.length) return null;

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: {
              select: {
                name: true,
                unitsPerBox: true,
                trackedCategoryId: true,
                trackedSubcategoryId: true,
              },
            },
          },
        },
      },
    });
    if (!order) return null;

    // Partition CURRENT lines by category (mirrors createSplitInvoices) — each line lands
    // in exactly one group.
    const groups = await this.groupOrderLinesForInvoicing(
      order.lineItems.map((li: any) => ({ li, remainingQty: 1 })),
      db,
    );
    if (groups.length !== drafts.length) return null;

    // Match each group to its draft by the SEPARATE_INVOICE category snapshot on the
    // draft's items (standard group → the base draft with no such category).
    const sepCatIds = new Set(groups.map((g) => g.trackedCategoryId).filter(Boolean));
    const draftCategory = (d: any): string | null | undefined => {
      const cats = new Set<string>(
        (d.items ?? [])
          .map((it: any) => it.trackedCategoryId)
          .filter((c: any) => c && sepCatIds.has(c)),
      );
      if (cats.size > 1) return undefined; // ambiguous — a draft with two SEPARATE cats
      return cats.size === 1 ? [...cats][0] : null; // null → standard/base draft
    };
    const draftByCat = new Map<string | null, any>();
    for (const d of drafts) {
      const c = draftCategory(d);
      if (c === undefined || draftByCat.has(c)) return null; // ambiguous / duplicate
      draftByCat.set(c, d);
    }
    const pairs: Array<{ draft: any; lines: any[] }> = [];
    for (const g of groups) {
      const d = draftByCat.get(g.trackedCategoryId ?? null);
      if (!d) return null; // a group with no matching draft
      pairs.push({ draft: d, lines: g.items.map((x: any) => x.li) });
    }

    return this.rebuildSiblingDrafts(order, pairs, basis, db);
  }

  /**
   * BACKWARD SYNC (inverse of reconcileOrderDraftInvoice): rebuild a linked
   * order's line items + totals from the SUM of ALL its non-void invoices, so
   * editing an invoice keeps the order in step with what was actually billed.
   *
   * Aggregates billed qty + subtotal per SOURCE ORDER LINE (via the invoice item's
   * `orderItemId` provenance; falls back to productId for legacy invoice rows),
   * copies the billed subtotal verbatim, and PRESERVES each order line's stored
   * box/piece denomination + unitsPerBox snapshot — it never re-splits against the
   * live product (which used to turn selling-unit lines into phantom box splits).
   * Cancels order lines no invoice bills; preserves the order's effective tax rate.
   * No-op when the order has no surviving (non-void) invoices.
   */
  async recomputeOrderFromInvoices(orderId: string, tx?: any) {
    const db = tx ?? this.prisma.forTenant();
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: { lineItems: true },
    });
    if (!order) return null;

    const invoices = await db.invoice.findMany({
      where: { orderId, status: { not: InvoiceStatus.VOID } },
      include: { items: true },
    });
    if (invoices.length === 0) return null;

    const tenantId = this.prisma.getTenantId();
    const existingById = new Map<string, any>();
    const existingByProduct = new Map<string, any>();
    for (const li of order.lineItems as any[]) {
      existingById.set(li.id, li);
      if (li.productId) existingByProduct.set(li.productId, li);
    }

    // Aggregate billed qty + subtotal, resolving each invoice line to its source
    // order line: prefer the stored orderItemId; else first-match by productId
    // (legacy rows). An invoice line with a product but no matching order line
    // becomes a NEW order line (an item added on the invoice). Freeform invoice
    // lines (no product, no orderItemId) can't map to an order line and are skipped.
    type Agg = {
      line: any; // existing order line, or null → create new
      productId: string | null;
      qty: number;
      subtotal: number;
      categoryTax: number; // RF-4: Σ billed category tax for this source line
      freeUnits: number; // BUY_N_GET_M: Σ billed free selling units for this source line
      unitPrice: number;
      sample: any; // an invoice item, for the box/piece + upb snapshot
    };
    const byTarget = new Map<string, Agg>();
    for (const inv of invoices) {
      for (const it of inv.items as any[]) {
        const line =
          (it.orderItemId && existingById.get(it.orderItemId)) ||
          (it.productId && existingByProduct.get(it.productId)) ||
          null;
        if (!line && !it.productId) continue; // freeform — nothing to sync
        const key = line ? `line:${line.id}` : `product:${it.productId}`;
        const prev = byTarget.get(key) ?? {
          line,
          productId: it.productId ?? null,
          qty: 0,
          subtotal: 0,
          categoryTax: 0,
          freeUnits: 0,
          unitPrice: Number(it.unitPrice),
          sample: it,
        };
        prev.qty += Number(it.qty);
        prev.subtotal += Number(it.subtotal);
        prev.categoryTax += Number(it.categoryTaxAmount ?? 0);
        prev.freeUnits += Math.max(0, Math.trunc(Number(it.promoFreeUnits ?? 0) || 0));
        prev.unitPrice = Number(it.unitPrice); // most-recent line wins for display
        prev.sample = it;
        byTarget.set(key, prev);
      }
    }

    let subtotal = 0;
    let categoryTaxSum = 0;
    for (const agg of byTarget.values()) {
      const existing = agg.line;
      const lineSubtotal = roundMoney(agg.subtotal);
      const lineCategoryTax = roundMoney(agg.categoryTax);
      // BUY_N_GET_M: mirror the BILLED free units back too, so the order line's
      // snapshot can never contradict the subtotal it just took from the invoice.
      const lineFreeUnits = Math.max(0, Math.trunc(agg.freeUnits) || 0);
      subtotal += lineSubtotal;
      categoryTaxSum += lineCategoryTax;
      // Preserve the denomination. For an existing line use ITS stored box/piece
      // shape + snapshot upb; for a new line use the invoice item's snapshot. Box
      // splits re-derive their display split from the billed qty; selling-unit and
      // non-boxed lines keep boxes/pieces null (qty stays in their own unit). The
      // live product is NEVER consulted — that is what created phantom splits.
      const denomSource = existing ?? agg.sample;
      const isBoxSplit = denomSource?.boxes != null;
      const upb = Number(existing?.unitsPerBox ?? agg.sample?.unitsPerBox ?? 0);
      const split = isBoxSplit
        ? normalizeBoxesPieces({ qty: agg.qty, unitsPerBox: upb })
        : { qty: agg.qty, boxes: null as number | null, pieces: null as number | null };
      const upbSnapshot = upb > 0 ? upb : null;
      if (existing) {
        await db.orderItem.update({
          where: { id: existing.id },
          data: {
            qty: split.qty,
            boxes: split.boxes,
            pieces: split.pieces,
            unitsPerBox: upbSnapshot,
            unitPrice: agg.unitPrice,
            subtotal: lineSubtotal,
            // RF-4: mirror the billed category tax back onto the order line.
            categoryTaxAmount: lineCategoryTax,
            promoFreeUnits: lineFreeUnits > 0 ? lineFreeUnits : null,
            invoicedQty: split.qty,
            status: "PENDING",
          },
        });
        existingById.delete(existing.id);
      } else {
        await db.orderItem.create({
          data: {
            orderId,
            productId: agg.productId,
            qty: split.qty,
            boxes: split.boxes,
            pieces: split.pieces,
            unitsPerBox: upbSnapshot,
            unitPrice: agg.unitPrice,
            subtotal: lineSubtotal,
            // RF-4: mirror the billed category tax back onto the new order line.
            categoryTaxAmount: lineCategoryTax,
            promoFreeUnits: lineFreeUnits > 0 ? lineFreeUnits : null,
            invoicedQty: split.qty,
            status: "PENDING",
            ...(tenantId ? { tenantId } : {}),
          },
        });
      }
    }

    // Order lines billed by no invoice → cancel (they weren't actually sold).
    for (const orphan of existingById.values()) {
      await db.orderItem.update({
        where: { id: orphan.id },
        data: {
          status: "CANCELLED",
          qty: 0,
          subtotal: 0,
          boxes: null,
          pieces: null,
          invoicedQty: 0,
        },
      });
    }

    // Preserve the order's effective tax rate (avoids depending on global config
    // drift); mirror updateOrderItems' total = subtotal + regular tax + category tax.
    subtotal = roundMoney(subtotal);
    const prevSubtotal = Number(order.subtotal) || 0;
    const effectiveTaxRate = prevSubtotal > 0 ? Number(order.tax) / prevSubtotal : 0;
    const tax = roundMoney(subtotal * effectiveTaxRate);
    // RF-4: fold the billed category tax (Σ per line) back into the order total, so
    // the order stays in step with what the invoices actually charged.
    const categoryTax = roundMoney(categoryTaxSum);
    // Shipping back-sync: the order's fee is DEFINED as Σ(non-void invoice fees) —
    // an invoice-side fee edit lands here and updates the order, which is what
    // lets the order-driven reconciles treat the order as source of truth.
    const shippingFeeSum = roundMoney(
      invoices.reduce((s: number, inv: any) => s + Number(inv.shippingFee ?? 0), 0),
    );
    const total = roundMoney(subtotal + tax + categoryTax + shippingFeeSum);
    await db.order.update({
      where: { id: orderId },
      data: { subtotal, tax, total, shippingFee: shippingFeeSum },
    });
    return { orderId, subtotal, tax, total, shippingFee: shippingFeeSum };
  }

  /**
   * Fire-and-forget safe variant of createInvoiceFromOrder.
   * Accepts an explicit tenantId so it doesn't depend on AsyncLocalStorage
   * (which is lost when the call is not awaited in the request lifecycle).
   */
  async createInvoiceFromOrderWithTenant(
    orderId: string,
    tenantId: string | null,
    overrides?: { dueDate?: string; terms?: string; paymentTermsLabel?: string },
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, ...(tenantId ? { tenantId } : {}) },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: {
              select: {
                name: true,
                unitsPerBox: true,
                trackedCategoryId: true,
                trackedSubcategoryId: true,
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    const remainingItems = order.lineItems
      .map((li: any) => ({
        li,
        remainingQty: Number(li.qty) - Number(li.invoicedQty ?? 0),
      }))
      .filter((x: any) => x.remainingQty > 0.001);

    if (remainingItems.length === 0) {
      // Nothing left to invoice — return the order's existing invoice(s). (W4: array.)
      return this.prisma.invoice.findMany({
        where: { orderId, ...(tenantId ? { tenantId } : {}) },
        orderBy: { createdAt: "desc" },
      });
    }

    // RF-079: apply tax-exempt check in the fire-and-forget path too. Also carries
    // the customer's own defaultPaymentTerms, which (when set) wins over the
    // tenant default below — mirrors resolveDefaultTerms(customerId) used by the
    // awaited paths, adapted for this explicit-tenantId (no AsyncLocalStorage) call.
    const customerForTax = tenantId
      ? await this.prisma.customer.findFirst({
          where: { id: order.customerId, ...(tenantId ? { tenantId } : {}) },
          select: { isTaxExempt: true, defaultPaymentTerms: true },
        })
      : null;

    // Resolve default terms — read SystemConfig with explicit tenantId since we're
    // outside the normal request context (fire-and-forget, no AsyncLocalStorage).
    let defaultTerms = "Net 30";
    let dueDays = 30;
    if ((customerForTax as any)?.defaultPaymentTerms) {
      defaultTerms = (customerForTax as any).defaultPaymentTerms;
      dueDays = TERM_DAYS[defaultTerms] ?? 30;
    } else if (tenantId) {
      const cfg = await this.prisma.systemConfig.findFirst({
        where: { tenantId, key: "invoice.defaultTerms" },
        select: { value: true },
      });
      if (cfg?.value) {
        defaultTerms = cfg.value;
        dueDays = TERM_DAYS[defaultTerms] ?? 30;
      }
    }

    // Customer-facing invoice Notes and T&C from tenant settings
    let tenantNotes: string | null = null;
    let tenantTerms: string | null = null;
    let tenantTimezone: string | null = null;
    if (tenantId) {
      const cfg = await this.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: { invoiceNotes: true, invoiceTerms: true, timezone: true },
      });
      tenantNotes = cfg?.invoiceNotes ?? null;
      tenantTerms = cfg?.invoiceTerms ?? null;
      tenantTimezone = cfg?.timezone ?? null;
    }

    // A backdated order bills on its business date, and the payment term runs from
    // that date — not from when the invoice happened to be generated.
    const issueDate = order.orderDate ?? startOfCalendarDay(tenantTimezone);
    let dueDate: Date;
    if (overrides?.dueDate) {
      dueDate = new Date(overrides.dueDate);
    } else {
      dueDate = addCalendarDays(issueDate, dueDays);
    }

    const overrideTerms = overrides?.terms?.trim() || undefined;
    // INVARIANT: see createInvoiceFromOrder — persist whichever string drove the
    // dueDate math (an explicit override label, else the resolved default), and
    // null when an explicit dueDate override means no term string drove it.
    const paymentTermsLabel =
      overrides?.paymentTermsLabel?.trim() || (overrides?.dueDate ? null : defaultTerms);
    const extraInvoiceData: Record<string, any> = {
      dueDate,
      terms: overrideTerms ?? tenantTerms ?? defaultTerms,
      paymentTermsLabel,
      issueDate,
      notes: tenantNotes ?? (order.orderNumber ? `Order #${order.orderNumber}` : null),
    };

    // W4: split by regulated category (fire-and-forget path). db = unscoped prisma
    // with an explicit tenantId, exactly as this method already used it.
    return this.createSplitInvoices({
      order,
      remainingItems,
      isTaxExempt: !!customerForTax?.isTaxExempt,
      db: this.prisma,
      tenantId,
      extraInvoiceData,
      include: {
        customer: {
          select: { id: true, businessName: true, email: true, phone: true, mobile: true },
        },
        items: true,
        payments: true,
      },
    });
  }

  /**
   * Create one of N partial invoices for an order. Operator picks which order items
   * (and how many of each) go on this invoice + a due date. Each call increments
   * OrderItem.invoicedQty so we never over-bill.
   */
  async createPartialFromOrder(
    orderId: string,
    dto: CreatePartialInvoiceDto,
    overrides?: { dueDate?: string; terms?: string; paymentTermsLabel?: string },
  ) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: {
              select: {
                name: true,
                unitsPerBox: true,
                trackedCategoryId: true,
                trackedSubcategoryId: true,
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    const itemById = new Map(order.lineItems.map((li: any) => [li.id, li]));

    // Validate every requested item exists on the order and qty is within remaining.
    const itemsData: any[] = [];
    let subtotal = 0;
    for (const req of dto.items) {
      const li: any = itemById.get(req.orderItemId);
      if (!li) {
        throw new BadRequestException(
          `Order item ${req.orderItemId} not found on order ${orderId}`,
        );
      }
      const remaining = Number(li.qty) - Number(li.invoicedQty ?? 0);
      if (req.qty > remaining + 0.001) {
        throw new BadRequestException(
          `Requested qty ${req.qty} exceeds remaining ${remaining} for ${li.product?.name ?? li.productId}`,
        );
      }
      // Reuse the shared builder. It copies the order line's stored money and
      // prorates partials via telescoping cumulative rounding keyed on how much
      // this line has already been billed, so repeated partials sum to exactly the
      // order line's subtotal.
      const itemData = this.buildInvoiceItemData(li, req.qty, this.prisma.getTenantId(), {
        priorBilledQty: Number(li.invoicedQty ?? 0),
      });
      subtotal += itemData.subtotal;
      itemsData.push(itemData);
    }
    subtotal = roundMoney(subtotal);
    await this.applyMsrpSnapshots(this.prisma.forTenant(), order.customerId, itemsData);

    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { id: order.customerId }, select: { isTaxExempt: true } });
    const isTaxExempt = !!(customer as any)?.isTaxExempt;
    const orderSubtotal = Number(order.subtotal) || 1;
    const proportion = subtotal / orderSubtotal;
    const regularTax = isTaxExempt ? 0 : roundMoney(Number(order.tax) * proportion);
    // RF-4: fold each partial's share of the per-line category tax (exempt → 0 both).
    const categoryTax = this.foldCategoryTax(itemsData, isTaxExempt);
    const taxAmount = roundMoney(regularTax + categoryTax);
    // First partial carries the whole remaining order fee; later partials get 0.
    const orderFee = roundMoney(Number((order as any).shippingFee ?? 0));
    let feeRemaining = 0;
    if (orderFee > 0) {
      const priorFeeAgg = await this.prisma.forTenant().invoice.aggregate({
        where: { orderId: order.id, status: { not: InvoiceStatus.VOID } },
        _sum: { shippingFee: true },
      });
      feeRemaining = Math.max(0, roundMoney(orderFee - Number(priorFeeAgg._sum.shippingFee ?? 0)));
    }
    const total = roundMoney(subtotal + taxAmount + feeRemaining);

    // Resolve due date: explicit dto.dueDate wins, then a caller-supplied override,
    // else default term from the issue date. Customer-aware: the customer's own
    // defaultPaymentTerms (when set) wins over the tenant default.
    const { terms: defaultTerms, dueDays } = await this.resolveDefaultTerms(order.customerId);
    const tenantDefaults = await this.resolveTenantInvoiceDefaults();
    // A backdated order bills on its business date, and the payment term runs from
    // that date — not from when the invoice happened to be generated.
    const issueDate = order.orderDate ?? startOfCalendarDay(tenantDefaults.timezone);
    let dueDate: Date;
    if (dto.dueDate) {
      dueDate = new Date(dto.dueDate);
    } else if (overrides?.dueDate) {
      dueDate = new Date(overrides.dueDate);
    } else {
      dueDate = addCalendarDays(issueDate, dueDays);
    }
    const overrideTerms = overrides?.terms?.trim() || undefined;
    // INVARIANT: see createInvoiceFromOrder — persist whichever string drove the
    // dueDate math. The split-invoice UI posts the Net-N it picked as
    // `paymentTermsLabel` alongside the date it derived from it; only an explicit
    // dueDate from EITHER source with NO accompanying label persists null, since
    // the label must never describe arithmetic that never ran.
    const paymentTermsLabel =
      dto.paymentTermsLabel?.trim() ||
      overrides?.paymentTermsLabel?.trim() ||
      (dto.dueDate || overrides?.dueDate ? null : defaultTerms);
    const tenantId = this.prisma.getTenantId();
    const invoiceNumber = await this.generateInvoiceNumber();

    let invoice: any;
    try {
      invoice = await this.prisma.forTenant().invoice.create({
        data: {
          invoiceNumber,
          customerId: order.customerId,
          orderId: order.id,
          status: InvoiceStatus.DRAFT,
          subtotal,
          taxAmount,
          discount: 0,
          shippingFee: feeRemaining,
          total,
          dueDate,
          terms: dto.terms ?? overrideTerms ?? tenantDefaults.terms ?? defaultTerms,
          paymentTermsLabel,
          issueDate,
          notes:
            dto.notes ??
            tenantDefaults.notes ??
            (order.orderNumber ? `Order #${order.orderNumber}` : null),
          items: { create: itemsData },
          ...(tenantId ? { tenantId } : {}),
        },
        include: {
          customer: {
            select: { id: true, businessName: true, email: true, phone: true, mobile: true },
          },
          items: true,
          payments: true,
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002")
        throw new ConflictException("Invoice number conflict — please retry.");
      throw err;
    }

    // Increment invoicedQty on each chosen order item.
    for (const req of dto.items) {
      await this.prisma.forTenant().orderItem.update({
        where: { id: req.orderItemId },
        data: { invoicedQty: { increment: req.qty } },
      });
    }

    if (dto.send) {
      return this.send(invoice.id);
    }
    return invoice;
  }

  /**
   * Generate next invoice number. Accepts optional tx client for
   * transactional safety inside $transaction blocks.
   */
  private async generateInvoiceNumber(db?: any): Promise<string> {
    const client = db ?? this.prisma;
    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;
    const last = await client.invoice.findFirst({
      where: { invoiceNumber: { startsWith: prefix } },
      orderBy: { invoiceNumber: "desc" },
    });
    const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  async findAll(query: ListInvoicesDto, user?: JwtPayload) {
    const {
      status,
      statuses,
      isOverdue,
      customerId,
      search,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder,
      shipped,
      page = 1,
      limit = 20,
    } = query;
    const skip = (page - 1) * limit;
    const where: any = {};
    // Shipments view: only invoices that carry a carrier tracking number.
    if (shipped) where.shippingTrackingNumber = { not: null };
    if (isOverdue) {
      // Derived overdue: unpaid invoices (SENT/VIEWED/PARTIAL) past their due date
      where.status = {
        in: [
          InvoiceStatus.SENT,
          InvoiceStatus.VIEWED,
          InvoiceStatus.PARTIAL,
          InvoiceStatus.OVERDUE,
        ],
      };
      where.dueDate = { lt: new Date() };
    } else if (statuses && statuses.length > 0) {
      // RF-204: normalize legacy "VOIDED" alias → the DB enum value "VOID"
      where.status = { in: statuses.map((s: string) => (s === "VOIDED" ? "VOID" : s)) };
    } else if (status) {
      // RF-204: normalize "VOIDED" → "VOID" for single-status filter
      where.status = (status as string) === "VOIDED" ? "VOID" : status;
    }
    if (user?.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      where.customerId = customer.id;
      // Buyers must not see DRAFT invoices (not yet issued to them)
      if (!where.status) {
        where.status = { not: "DRAFT" };
      } else if (where.status?.in) {
        where.status.in = where.status.in.filter((s: string) => s !== "DRAFT");
      } else if (where.status === "DRAFT") {
        return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      }
    } else if (customerId) {
      where.customerId = customerId;
    }
    if (search) {
      where.OR = [
        { customer: { businessName: { contains: search, mode: "insensitive" } } },
        { invoiceNumber: { contains: search, mode: "insensitive" } },
        { shippingTrackingNumber: { contains: search, mode: "insensitive" } },
      ];
    }
    if (dateFrom || dateTo) {
      where.issueDate = {};
      if (dateFrom) where.issueDate.gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        where.issueDate.lte = end;
      }
    }

    // Build orderBy from sortBy/sortOrder params
    const validSortFields: Record<string, string> = {
      date: "issueDate",
      issueDate: "issueDate",
      dueDate: "dueDate",
      total: "total",
      amount: "total",
      createdAt: "createdAt",
      status: "status",
      invoiceNumber: "invoiceNumber",
    };
    const orderField = validSortFields[sortBy ?? ""] ?? "issueDate";
    const orderDir = sortOrder === "asc" ? "asc" : "desc";
    const orderBy: any = { [orderField]: orderDir };

    const [data, total] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          payments: { orderBy: { createdAt: "desc" } },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.forTenant().invoice.count({ where }),
    ]);

    // Compute balanceDue server-side so the client always gets the right value
    // regardless of whether InvoicePayment records exist (e.g. Zoho-imported invoices)
    //
    // RF-202: isOverdue uses ISO date-string comparison (YYYY-MM-DD) so that an
    // invoice due *today* is NOT considered overdue.  Comparing Date objects
    // directly would treat a due date of "2026-05-01" (midnight UTC) as overdue
    // any time after midnight UTC on that date, regardless of local timezone.
    // Business rule: grace period extends through the end of the due date.
    const todayIso = new Date().toISOString().slice(0, 10);
    const computedData = data.map((inv) => {
      // Exclude VOID payments (a bounced check reverses to VOID in P5-12) so the list's
      // balanceDue/isOverdue match findOne — a VOID payment sits on a still-open invoice.
      const paidAmount = inv.payments
        .filter((p) => p.status !== "VOID")
        .reduce((s, p) => s + Number(p.amount), 0);
      const isSettled =
        inv.status === InvoiceStatus.PAID ||
        inv.status === InvoiceStatus.VOID ||
        inv.status === InvoiceStatus.WRITTEN_OFF;
      const balanceDue = isSettled ? 0 : Math.max(0, Number(inv.total) - paidAmount);
      const dueDateIso = inv.dueDate
        ? (inv.dueDate instanceof Date ? inv.dueDate : new Date(inv.dueDate))
            .toISOString()
            .slice(0, 10)
        : null;
      const isOverdue = !isSettled && balanceDue > 0 && dueDateIso != null && dueDateIso < todayIso;
      const { depositAmount, depositOverdue } = this.computeDepositFields(inv as any, paidAmount);
      return { ...inv, balanceDue, paidAmount, isOverdue, depositAmount, depositOverdue };
    });

    return {
      data: computedData,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, user?: JwtPayload) {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            businessName: true,
            contactName: true,
            phone: true,
            mobile: true,
            email: true,
          },
        },
        items: {
          include: {
            product: { select: { id: true, name: true, unit: true, unitsPerBox: true } },
            // RF-2-lite: surface the regulated category/subcategory NAME so clients can
            // label regulated lines (previously only the trackedCategoryId was returned).
            trackedCategory: { select: { id: true, name: true, invoiceTreatment: true } },
            trackedSubcategory: { select: { id: true, name: true } },
          },
        },
        payments: {
          orderBy: { createdAt: "desc" },
          include: {
            creditNote: {
              select: {
                id: true,
                creditNoteNumber: true,
                reason: true,
                amount: true,
                amountUsed: true,
                status: true,
              },
            },
          },
        },
        // The web invoice page gates Edit/Send for an order-linked DRAFT until the
        // order is delivered (the "pending mirror"). Surface the order's status here.
        order: { select: { status: true, orderNumber: true } },
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (user?.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || inv.customerId !== customer.id) throw new ForbiddenException();
      // A customer must never see an upsell's base price on their invoice.
      redactUpsellForCustomer(inv);
    }
    // P5-12: VOID payments (manually voided OR bounced checks) must not count
    // toward the paid amount — every other paid-sum already excludes non-VOID.
    const paidAmount = inv.payments
      .filter((p) => p.status !== "VOID")
      .reduce((s, p) => s + Number(p.amount), 0);
    const isSettled =
      inv.status === InvoiceStatus.PAID ||
      inv.status === InvoiceStatus.VOID ||
      inv.status === InvoiceStatus.WRITTEN_OFF;
    const balanceDue = isSettled ? 0 : Math.max(0, Number(inv.total) - paidAmount);
    // RF-202: date-string comparison — invoice due today is NOT overdue.
    const dueDateIso = inv.dueDate
      ? (inv.dueDate instanceof Date ? inv.dueDate : new Date(inv.dueDate))
          .toISOString()
          .slice(0, 10)
      : null;
    const isOverdue =
      !isSettled &&
      balanceDue > 0 &&
      dueDateIso != null &&
      dueDateIso < new Date().toISOString().slice(0, 10);
    const { depositAmount, depositOverdue } = this.computeDepositFields(inv as any, paidAmount);
    return { ...inv, balanceDue, paidAmount, isOverdue, depositAmount, depositOverdue };
  }

  async update(id: string, dto: Partial<CreateInvoiceDto>) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException("Only DRAFT invoices can be edited");
    await this.assertOrderInvoiceUnlocked(inv);

    if (dto.items) {
      // Pre-fetch products for boxes/pieces resolution AND the regulated-category
      // snapshot (so an edited DRAFT re-attributes its regulated lines).
      const productIds = [
        ...new Set(dto.items.filter((i) => i.productId).map((i) => i.productId!)),
      ];
      const products =
        productIds.length > 0
          ? await this.prisma.forTenant().product.findMany({
              where: { id: { in: productIds } },
              select: {
                id: true,
                unitsPerBox: true,
                trackedCategoryId: true,
                trackedSubcategoryId: true,
              },
            })
          : [];
      const productMap = new Map(products.map((p) => [p.id, p]));
      // RF-4: regulated section tax config for the edited lines (mirrors create()).
      const editCatIds = [
        ...new Set(products.map((p) => p.trackedCategoryId).filter(Boolean)),
      ] as string[];
      const categoryMap = new Map<string, any>(
        (editCatIds.length > 0
          ? await this.prisma
              .forTenant()
              .trackedCategory.findMany({ where: { id: { in: editCatIds } } })
          : []
        ).map((c: any) => [c.id, c]),
      );

      let subtotal = 0;
      const itemsData = dto.items.map((item) => {
        const product = item.productId ? productMap.get(item.productId) : undefined;
        let qty = item.qty;
        let boxes: number | null = null;
        let pieces: number | null = null;
        let unitsPerBox: number | undefined;
        if (item.productId && (item.boxes != null || item.pieces != null)) {
          if (product?.unitsPerBox) {
            unitsPerBox = product.unitsPerBox;
            const split = normalizeBoxesPieces({
              boxes: item.boxes,
              pieces: item.pieces,
              unitsPerBox,
            });
            boxes = split.boxes;
            pieces = split.pieces;
            qty = split.qty;
          }
        }
        // BUY_N_GET_M: the line's free-unit snapshot round-trips on the payload
        // (this path REPLACES every line). Dropping it re-prices an agreed
        // 12-boxes-2-free line from $350 to 12 × $35 = $420 on a plain re-save.
        const freeUnits = this.clampLineFreeUnits(item.promoFreeUnits, boxes, qty);
        const beforeDiscount = computeLineSubtotal({
          unitPrice: item.unitPrice,
          qty,
          boxes,
          pieces,
          unitsPerBox,
          freeUnits,
        });
        const lineSub = roundMoney(beforeDiscount - (item.discount ?? 0));
        subtotal += lineSub;
        // RF-4: per-line category tax on the net sale (mirrors create()).
        const category = product?.trackedCategoryId
          ? categoryMap.get(product.trackedCategoryId)
          : null;
        const upbForPieces = Number(product?.unitsPerBox ?? 0);
        const pieceQty = boxes != null ? qty : upbForPieces > 1 ? qty * upbForPieces : qty;
        const categoryTaxAmount = category
          ? computeCategoryTax({
              taxType: category.taxType as CategoryTaxType,
              rate: Number(category.rate),
              unitBasisQty: pieceQty,
              lineSubtotal: lineSub,
              priceIncludesTax: category.priceIncludesTax,
            })
          : 0;
        return {
          description: item.description,
          productId: item.productId,
          qty,
          unitPrice: item.unitPrice,
          discount: item.discount ?? 0,
          taxRate: item.taxRate ?? 0,
          subtotal: lineSub,
          boxes,
          pieces,
          // Snapshot the box size for a box-split line so later recompute is stable.
          unitsPerBox: boxes != null && unitsPerBox ? unitsPerBox : null,
          // BUY_N_GET_M snapshot — preserved across the delete-and-recreate.
          promoFreeUnits: freeUnits > 0 ? freeUnits : null,
          // Re-snapshot the regulated category/subcategory from the (current) product,
          // consistent with create(); the ledger re-sync below reconciles the change.
          trackedCategoryId: product?.trackedCategoryId ?? null,
          trackedSubcategoryId: product?.trackedSubcategoryId ?? null,
          // RF-4: per-line category tax snapshot (folded into taxTotal below).
          categoryTaxAmount,
          // Preserve per-line notes across the delete-and-recreate edit — dropping
          // this silently wipes notes the order carried onto the invoice.
          notes: item.notes ?? null,
          // MSRP snapshot — set below by applyMsrpSnapshots (null when flag.msrp is off).
          msrp: null as number | null,
          tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
        };
      });
      subtotal = roundMoney(subtotal);
      await this.applyMsrpSnapshots(this.prisma.forTenant(), inv.customerId, itemsData);
      const customerForTax = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { id: inv.customerId }, select: { isTaxExempt: true } });
      // Tax from each line's stored post-discount subtotal (same basis as the line).
      const isTaxExempt = !!(customerForTax as any)?.isTaxExempt;
      const regularTax = isTaxExempt
        ? 0
        : roundMoney(itemsData.reduce((s, it) => s + it.subtotal * (it.taxRate ?? 0), 0));
      // RF-4: fold the regulated category tax (exempt → 0 for both + zeroed snapshots).
      const categoryTaxTotal = this.foldCategoryTax(itemsData, isTaxExempt);
      const taxTotal = roundMoney(regularTax + categoryTaxTotal);
      const invDiscount = dto.discount ?? Number(inv.discount);
      const shipping = dto.shippingFee ?? Number(inv.shippingFee);
      const total = roundMoney(subtotal - invDiscount + shipping + taxTotal);
      // Rebuild the items AND re-sync the W5 ledger atomically: the delete-and-recreate
      // rotates invoiceItemIds and can change qty/price or add/remove a regulated line,
      // so the invoice's prior SALE rows must be reversed and re-written from the new
      // items (a no-op when neither the old nor new invoice carries a regulated line).
      const updated = await this.prisma.tenantTransaction(async (tx: any) => {
        await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
        const u = await tx.invoice.update({
          where: { id },
          data: {
            subtotal,
            taxAmount: taxTotal,
            discount: invDiscount,
            shippingFee: shipping,
            total,
            dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
            issueDate: dto.issueDate ? new Date(dto.issueDate) : undefined,
            notes: dto.notes,
            terms: dto.terms,
            // "" from the composer's Terms dropdown means "no term" (the operator
            // hand-typed a due date) — store null, never an empty label.
            paymentTermsLabel: dto.paymentTermsLabel === "" ? null : dto.paymentTermsLabel,
            // Same "" → null convention: a blanked reference / subject is a
            // deliberate clear, not "leave unchanged".
            ...(dto.referenceNumber !== undefined && {
              referenceNumber: dto.referenceNumber || null,
            }),
            ...(dto.subject !== undefined && { subject: dto.subject || null }),
            ...(dto.depositPercent !== undefined && { depositPercent: dto.depositPercent }),
            ...(dto.depositDueDate !== undefined && {
              depositDueDate: dto.depositDueDate ? new Date(dto.depositDueDate) : null,
            }),
            pdfUrl: null,
            items: { create: itemsData },
          },
          include: {
            customer: { select: { id: true, businessName: true } },
            items: true,
            payments: true,
          },
        });
        await this.resyncInvoiceLedger(id, inv.orderId ?? null, u.items ?? [], tx);
        return u;
      });
      // Backward sync: keep the linked order in step with the edited invoice.
      if (inv.orderId) await this.recomputeOrderFromInvoices(inv.orderId);
      return updated;
    }

    // RF-012: if discount or shippingFee changed, recompute total from existing items.
    const needsRecalc = dto.discount !== undefined || dto.shippingFee !== undefined;
    let recalcData: Record<string, unknown> = {};
    if (needsRecalc) {
      const existingItems = await this.prisma
        .forTenant()
        .invoiceItem.findMany({ where: { invoiceId: id } });
      const subtotal = roundMoney(
        existingItems.reduce((s: number, i: any) => s + Number(i.subtotal), 0),
      );
      const taxTotal = roundMoney(
        existingItems.reduce(
          (s: number, i: any) => s + Number(i.subtotal) * Number(i.taxRate ?? 0),
          0,
        ),
      );
      const invDiscount = dto.discount !== undefined ? dto.discount : Number(inv.discount);
      const shipping = dto.shippingFee !== undefined ? dto.shippingFee : Number(inv.shippingFee);
      recalcData = {
        subtotal,
        taxAmount: taxTotal,
        discount: invDiscount,
        shippingFee: shipping,
        total: roundMoney(subtotal - invDiscount + shipping + taxTotal),
      };
    }

    const updated = await this.prisma.forTenant().invoice.update({
      where: { id },
      data: {
        ...(dto.dueDate && { dueDate: new Date(dto.dueDate) }),
        ...(dto.issueDate && { issueDate: new Date(dto.issueDate) }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.terms !== undefined && { terms: dto.terms }),
        // "" clears the label (the composer sends it when the operator hand-typed a
        // due date and the term no longer applies) — same convention as the supplier
        // and customer default-terms fields.
        ...(dto.paymentTermsLabel !== undefined && {
          paymentTermsLabel: dto.paymentTermsLabel || null,
        }),
        ...(dto.referenceNumber !== undefined && {
          referenceNumber: dto.referenceNumber || null,
        }),
        ...(dto.subject !== undefined && { subject: dto.subject || null }),
        ...(dto.depositPercent !== undefined && { depositPercent: dto.depositPercent }),
        ...(dto.depositDueDate !== undefined && {
          depositDueDate: dto.depositDueDate ? new Date(dto.depositDueDate) : null,
        }),
        ...recalcData,
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: true,
      },
    });
    // Backward sync: discount/shipping changes alter the order total too.
    if (inv.orderId && needsRecalc) await this.recomputeOrderFromInvoices(inv.orderId);
    return updated;
  }

  /**
   * Set or clear carrier shipment tracking on an invoice. Unlike line-item edits
   * (DRAFT-only), this is allowed on any non-void invoice because goods are
   * usually shipped AFTER the invoice is sent. Clearing the tracking number also
   * clears `shippedAt`; the first time a number is set we stamp `shippedAt`.
   */
  async updateInvoiceShipment(id: string, dto: UpdateShipmentDto) {
    const inv = await this.prisma
      .forTenant()
      .invoice.findFirst({ where: { id }, select: { id: true, status: true, shippedAt: true } });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status === InvoiceStatus.VOID)
      throw new BadRequestException("Cannot update tracking on a voided invoice");

    const carrier = dto.shippingCarrier?.trim() || null;
    const tracking = dto.shippingTrackingNumber?.trim() || null;
    const shippedAt = tracking ? (inv.shippedAt ?? new Date()) : null;

    return this.prisma.forTenant().invoice.update({
      where: { id },
      data: { shippingCarrier: carrier, shippingTrackingNumber: tracking, shippedAt },
    });
  }

  /**
   * WP3: narrow post-issue correction for exactly `{ dueDate?, paymentTermsLabel?,
   * referenceNumber?, subject? }` — NEVER items/discount/shipping/deposit, which
   * still require a credit note (money already sent to the customer) or a DRAFT
   * edit. Allowed on any status EXCEPT VOID/WRITTEN_OFF — unlike
   * applyPriceAdjustment, which also blocks PAID; a paid invoice's label/reference
   * can still be corrected without touching its money.
   *
   * A dueDate change can flip SENT↔OVERDUE, so recomputeStatus re-runs on every
   * call (a no-op when dueDate is unchanged) — the SAME status contract used
   * everywhere else in this file, byte-identical, never re-derived here.
   *
   * Deliberately does NOT call recomputeOrderFromInvoices: this edit never
   * changes subtotal/tax/fee (the order's total is defined off those), so there
   * is nothing for the linked order to resync — pinned by a spec.
   *
   * Audit trail: an internalNotes breadcrumb (mirrors applyPriceAdjustment's
   * convention) is the only audit record. Wiring the global AuditService was
   * considered and IS mechanically easy — it needs no InvoicesModule change
   * (AuditModule is @Global(), exports AuditService) — but every existing
   * `audit.log()` call site in this codebase attributes to a real caller
   * (`userId: user.sub`, never null), and this method's signature is fixed by
   * the plan at exactly (id, dto) with no user/JwtPayload parameter to supply
   * one. Logging with a null actor would be a new, weaker kind of audit entry
   * that breaks that house convention rather than extending it, and the
   * signature isn't mine to change (the controller — WP3, a different file —
   * calls exactly this shape). The internalNotes breadcrumb alone is the
   * reported choice; see this package's report for the full reasoning.
   */
  async updateTerms(
    id: string,
    dto: {
      dueDate?: string;
      paymentTermsLabel?: string;
      referenceNumber?: string;
      subject?: string;
    },
  ) {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: { payments: true },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status === InvoiceStatus.VOID || inv.status === InvoiceStatus.WRITTEN_OFF) {
      throw new BadRequestException(`Cannot edit terms on a ${inv.status} invoice.`);
    }

    const asDate = (d: unknown): Date | null =>
      d == null ? null : d instanceof Date ? d : new Date(d as string);
    const oldDueDate = asDate(inv.dueDate);
    const oldDueDateStr = oldDueDate ? oldDueDate.toISOString().slice(0, 10) : "none";
    const newDueDate = dto.dueDate ? new Date(dto.dueDate) : oldDueDate;
    const newDueDateStr = newDueDate ? newDueDate.toISOString().slice(0, 10) : "none";

    // Same non-VOID payment sum every other status computation in this file uses.
    const totalPaid = inv.payments
      .filter((p: any) => p.status !== "VOID")
      .reduce((s: number, p: any) => s + Number(p.amount), 0);
    const newStatus = this.recomputeStatus(totalPaid, Number(inv.total), newDueDate, inv.status);

    const auditLine = `[${new Date().toLocaleDateString()} — Terms updated: ${oldDueDateStr} → ${newDueDateStr}]`;
    const existingInternal = (inv as any).internalNotes ?? "";

    return this.prisma.forTenant().invoice.update({
      where: { id },
      data: {
        ...(dto.dueDate !== undefined && { dueDate: newDueDate }),
        // "" is how the Edit Terms modal CLEARS a field (an operator who blanks
        // a mislabeled "Net 45" or a stale PO number) — store null, never an
        // empty string; same convention as `update()` above and the customer /
        // supplier default-terms fields. Absent (undefined) still means
        // "leave unchanged".
        ...(dto.paymentTermsLabel !== undefined && {
          paymentTermsLabel: dto.paymentTermsLabel || null,
        }),
        ...(dto.referenceNumber !== undefined && {
          referenceNumber: dto.referenceNumber || null,
        }),
        ...(dto.subject !== undefined && { subject: dto.subject || null }),
        status: newStatus,
        internalNotes: existingInternal ? `${existingInternal}\n${auditLine}` : auditLine,
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: true,
      },
    });
  }

  /**
   * Enforce "invoice after delivery": an order-linked DRAFT that is the order's
   * pending mirror (no deliveryBatchId) cannot be sent or hand-edited until the
   * order has been delivered. Pre-delivery the invoice mirrors the order — staff
   * edit the order, not the invoice. Van sales (delivered now) and standalone
   * no-order invoices are unaffected.
   */
  private async assertOrderInvoiceUnlocked(inv: {
    orderId: string | null;
    status: InvoiceStatus;
    deliveryBatchId: string | null;
  }): Promise<void> {
    if (!inv.orderId || inv.status !== InvoiceStatus.DRAFT || inv.deliveryBatchId != null) return;
    const order = await this.prisma.forTenant().order.findFirst({
      where: { id: inv.orderId },
      select: { status: true, orderNumber: true },
    });
    if (order && order.status !== "DELIVERED" && order.status !== "PARTIALLY_DELIVERED") {
      throw new BadRequestException(
        `This invoice mirrors order #${order.orderNumber ?? ""} and can't be sent or edited until the order is delivered. Edit the order instead — the invoice updates automatically.`,
      );
    }
  }

  async send(id: string) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status === InvoiceStatus.VOID)
      throw new BadRequestException("Cannot send a voided invoice");
    await this.assertOrderInvoiceUnlocked(inv);
    // P5-13: SENT flip + oldest-first credit auto-apply are ONE atomic operation.
    // Idempotent on re-send. If the tx throws, the send fails — money first.
    const { updated, auto } = await this.prisma.tenantTransaction(
      async (tx) => {
        // P5-13: only flip DRAFT → SENT. Re-sending an invoice that credit auto-apply
        // already made PAID/PARTIAL must NOT downgrade it (auto-apply returns early on a
        // zero balance and won't restore the status), which would leave paidAt stale.
        const nextStatus = inv.status === InvoiceStatus.DRAFT ? InvoiceStatus.SENT : inv.status;
        const updated = await tx.invoice.update({
          where: { id },
          data: { status: nextStatus, sentAt: new Date() },
        });
        // An operator's EXPLICIT-amount order selection must not be overridden by the
        // oldest-first sweep; null-amount intents are already settled and clamp to 0.
        const explicitIds = updated.orderId
          ? (
              await tx.orderCreditNote.findMany({
                where: { orderId: updated.orderId, amount: { not: null } },
                select: { creditNoteId: true },
              })
            ).map((r: any) => r.creditNoteId)
          : [];
        const auto = await this.creditNotes.autoApplyOldestCreditsInTx(tx, id, updated.customerId, {
          excludeCreditNoteIds: explicitIds,
        });
        // A credit pre-applied at order time can already cover this invoice. Auto-apply
        // returns {applied:0, invoiceStatus:null} on a zero balance, which used to leave
        // a fully-credited invoice stuck SENT — recompute from the payments it has.
        if (!auto.invoiceStatus) {
          const fresh = await tx.invoice.findUnique({ where: { id }, include: { payments: true } });
          if (fresh) {
            const paid = roundMoney(
              (fresh.payments ?? [])
                .filter((p: any) => p.status !== "VOID")
                .reduce((s: number, p: any) => s + Number(p.amount), 0),
            );
            const st = this.recomputeStatus(paid, Number(fresh.total), fresh.dueDate, fresh.status);
            if (st !== fresh.status) {
              await tx.invoice.update({
                where: { id },
                data: { status: st, paidAt: st === InvoiceStatus.PAID ? new Date() : null },
              });
              auto.invoiceStatus = st;
            }
          }
        }
        // Sales agents & commissions (flag-gated, no-op when off): the invoice
        // just flipped DRAFT→SENT (or was re-sent) — accrue/re-sync commission.
        await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
        return { updated, auto };
      },
      { isolationLevel: "Serializable" },
    );
    this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      customerId: updated.customerId,
      status: auto.invoiceStatus ?? updated.status,
      total: Number(updated.total),
    });
    // P6-5: INVOICE_SENT (EMAIL/PORTAL only — G12 blocks WA/SMS in the engine).
    // Once, on the DRAFT→SENT flip; a re-send doesn't re-notify. System sender.
    if (inv.status === InvoiceStatus.DRAFT) {
      this.messaging
        .notifyEvent(NotificationEvent.INVOICE_SENT, {
          customerId: updated.customerId,
          senderId: null,
          vars: {
            invoiceNumber: updated.invoiceNumber,
            invoiceTotal: formatMoney(updated.total),
            dueDate: formatDate(updated.dueDate),
          },
        })
        .catch(() => {});
    }
    if (auto.applied > 0 || auto.invoiceStatus != null) {
      const final = await this.prisma.forTenant().invoice.findUnique({ where: { id } });
      if (final) return final;
    }
    return updated;
  }

  /** Send the invoice as an actual email and mark as SENT. */
  async sendEmail(id: string, overrideEmail?: string, variant?: "draft" | "final") {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true, email: true } },
        items: true,
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status === InvoiceStatus.VOID)
      throw new BadRequestException("Cannot send a voided invoice");
    await this.assertOrderInvoiceUnlocked(inv);

    // Import sentinels (`@imported.local` / `@placeholder.local`) are non-routable —
    // filter them from BOTH the override (older clients echo the on-file address into
    // the request body) and the customer record, so a sentinel behaves exactly like
    // "no email on file" instead of a doomed send.
    const requestedEmail = isInternalEmail(overrideEmail) ? null : overrideEmail;
    const onFileEmail = isInternalEmail(inv.customer?.email) ? null : inv.customer?.email;
    const recipientEmail = requestedEmail || onFileEmail;
    if (!recipientEmail)
      throw new BadRequestException(
        "No email address on file for this customer. Provide an email address.",
      );

    // R5: fail FAST when no email transport is configured — don't generate a PDF, don't
    // mark the invoice SENT, and (critically) don't tell the operator it was emailed when
    // it wasn't. Guide them to configure it. The "configured but the send failed" case is
    // caught after the attempt below.
    if (!(await this.emailService.isEmailConfigured())) {
      throw new BadRequestException({
        code: "EMAIL_NOT_CONFIGURED",
        message:
          "Email isn't set up yet, so the invoice wasn't emailed. Configure your email/SMTP settings under Settings → Email, then try again.",
      });
    }

    // Get PDF URL (non-blocking — include in email if available). `variant`
    // controls whether the DRAFT proforma or the FINAL invoice is attached.
    let pdfUrl: string | undefined;
    try {
      pdfUrl = await this.pdfService.getOrGenerate(id, { variant });
    } catch {
      this.logger.warn(
        `Could not generate PDF for invoice ${id} — email will be sent without PDF link`,
      );
    }

    const sendResult = await this.emailService.sendInvoice({
      to: recipientEmail,
      customerName: inv.customer?.businessName ?? "Customer",
      invoiceNumber: inv.invoiceNumber,
      invoiceId: inv.id,
      issueDate: formatDate(inv.issueDate),
      dueDate: formatDate(inv.dueDate),
      paymentTermsLabel: inv.paymentTermsLabel ?? undefined,
      total: Number(inv.total),
      items: inv.items.map((it: any) => ({
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        subtotal: Number(it.subtotal),
        msrp: it.msrp != null ? Number(it.msrp) : null,
      })),
      pdfUrl,
      isReminder: false,
    });

    // R5: the email server was configured but the actual send did NOT succeed
    // (bad SMTP credentials, Resend rejected the domain/key, etc.). Do NOT mark the
    // invoice SENT or return success — surface the real failure so the operator can fix
    // it in Settings → Email rather than believing the customer received the invoice.
    if (!sendResult.delivered) {
      throw new BadRequestException({
        code: "EMAIL_SEND_FAILED",
        message: `The invoice couldn't be emailed${sendResult.error ? ` (${sendResult.error})` : ""}. Check your email settings under Settings → Email and try again.`,
      });
    }

    // Mark as SENT. P5-13: SENT flip + oldest-first credit auto-apply are ONE atomic
    // operation. PDF/email I/O above stays OUTSIDE the tx.
    const { updated, auto } = await this.prisma.tenantTransaction(
      async (tx) => {
        // P5-13: only flip DRAFT → SENT. Re-sending an invoice that credit auto-apply
        // already made PAID/PARTIAL must NOT downgrade it (auto-apply returns early on a
        // zero balance and won't restore the status), which would leave paidAt stale.
        const nextStatus = inv.status === InvoiceStatus.DRAFT ? InvoiceStatus.SENT : inv.status;
        const updated = await tx.invoice.update({
          where: { id },
          data: { status: nextStatus, sentAt: new Date() },
        });
        // An operator's EXPLICIT-amount order selection must not be overridden by the
        // oldest-first sweep; null-amount intents are already settled and clamp to 0.
        const explicitIds = updated.orderId
          ? (
              await tx.orderCreditNote.findMany({
                where: { orderId: updated.orderId, amount: { not: null } },
                select: { creditNoteId: true },
              })
            ).map((r: any) => r.creditNoteId)
          : [];
        const auto = await this.creditNotes.autoApplyOldestCreditsInTx(tx, id, updated.customerId, {
          excludeCreditNoteIds: explicitIds,
        });
        // A credit pre-applied at order time can already cover this invoice. Auto-apply
        // returns {applied:0, invoiceStatus:null} on a zero balance, which used to leave
        // a fully-credited invoice stuck SENT — recompute from the payments it has.
        if (!auto.invoiceStatus) {
          const fresh = await tx.invoice.findUnique({ where: { id }, include: { payments: true } });
          if (fresh) {
            const paid = roundMoney(
              (fresh.payments ?? [])
                .filter((p: any) => p.status !== "VOID")
                .reduce((s: number, p: any) => s + Number(p.amount), 0),
            );
            const st = this.recomputeStatus(paid, Number(fresh.total), fresh.dueDate, fresh.status);
            if (st !== fresh.status) {
              await tx.invoice.update({
                where: { id },
                data: { status: st, paidAt: st === InvoiceStatus.PAID ? new Date() : null },
              });
              auto.invoiceStatus = st;
            }
          }
        }
        // Sales agents & commissions (flag-gated, no-op when off): the invoice
        // just flipped DRAFT→SENT (or was re-sent) — accrue/re-sync commission.
        await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
        return { updated, auto };
      },
      { isolationLevel: "Serializable" },
    );
    this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      customerId: updated.customerId,
      status: auto.invoiceStatus ?? updated.status,
      total: Number(updated.total),
    });
    // P6-5: INVOICE_SENT (EMAIL/PORTAL only — G12 blocks WA/SMS in the engine).
    // Once, on the DRAFT→SENT flip; a re-send doesn't re-notify. System sender.
    if (inv.status === InvoiceStatus.DRAFT) {
      this.messaging
        .notifyEvent(NotificationEvent.INVOICE_SENT, {
          customerId: updated.customerId,
          senderId: null,
          vars: {
            invoiceNumber: updated.invoiceNumber,
            invoiceTotal: formatMoney(updated.total),
            dueDate: formatDate(updated.dueDate),
            customerName: inv.customer?.businessName ?? "Customer",
          },
        })
        .catch(() => {});
    }
    // Non-blocking: the send succeeded (Resend rescued a failing tenant SMTP attempt),
    // but the operator's own mailbox is still broken and nobody else will tell them —
    // surface it as a warning, not a failure (the invoice really was emailed). The From
    // address silently changed too (tenant mailbox → platform address) — disclose it,
    // not bury it.
    return {
      success: true,
      sentTo: recipientEmail,
      ...(sendResult.smtpFallbackReason ? { warning: sendResult.smtpFallbackReason } : {}),
      ...(sendResult.fromAddress ? { fromAddress: sendResult.fromAddress } : {}),
    };
  }

  /** Send a payment reminder email without changing the invoice status. */
  async sendReminder(id: string, overrideEmail?: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true, email: true } },
        items: true,
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status === InvoiceStatus.VOID || inv.status === InvoiceStatus.PAID)
      throw new BadRequestException("Cannot send reminder for a VOID or PAID invoice");

    // Import sentinels (`@imported.local` / `@placeholder.local`) are non-routable —
    // filter them from BOTH the override (older clients echo the on-file address into
    // the request body) and the customer record, so a sentinel behaves exactly like
    // "no email on file" instead of a doomed send.
    const requestedEmail = isInternalEmail(overrideEmail) ? null : overrideEmail;
    const onFileEmail = isInternalEmail(inv.customer?.email) ? null : inv.customer?.email;
    const recipientEmail = requestedEmail || onFileEmail;
    if (!recipientEmail)
      throw new BadRequestException(
        "No email address on file for this customer. Provide an email address.",
      );

    // R5: don't claim a reminder was sent when email isn't set up.
    if (!(await this.emailService.isEmailConfigured())) {
      throw new BadRequestException({
        code: "EMAIL_NOT_CONFIGURED",
        message:
          "Email isn't set up yet, so the reminder wasn't sent. Configure your email/SMTP settings under Settings → Email, then try again.",
      });
    }

    let pdfUrl: string | undefined;
    try {
      pdfUrl = await this.pdfService.getOrGenerate(id);
    } catch {
      /* non-critical */
    }

    const sendResult = await this.emailService.sendInvoice({
      to: recipientEmail,
      customerName: inv.customer?.businessName ?? "Customer",
      invoiceNumber: inv.invoiceNumber,
      invoiceId: inv.id,
      issueDate: formatDate(inv.issueDate),
      dueDate: formatDate(inv.dueDate),
      paymentTermsLabel: inv.paymentTermsLabel ?? undefined,
      total: Number(inv.total),
      items: inv.items.map((it: any) => ({
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        subtotal: Number(it.subtotal),
        msrp: it.msrp != null ? Number(it.msrp) : null,
      })),
      pdfUrl,
      isReminder: true,
    });

    if (!sendResult.delivered) {
      throw new BadRequestException({
        code: "EMAIL_SEND_FAILED",
        message: `The reminder couldn't be emailed${sendResult.error ? ` (${sendResult.error})` : ""}. Check your email settings under Settings → Email and try again.`,
      });
    }

    // Non-blocking: see the matching comment in sendEmail() above — Resend rescued a
    // failing tenant SMTP attempt, so tell the operator without blocking the reminder.
    return {
      success: true,
      sentTo: recipientEmail,
      ...(sendResult.smtpFallbackReason ? { warning: sendResult.smtpFallbackReason } : {}),
      ...(sendResult.fromAddress ? { fromAddress: sendResult.fromAddress } : {}),
    };
  }

  /**
   * Money on an invoice comes in two flavours and they unwind differently:
   *
   *  - **Wallet money** (CREDIT_NOTE, ADVANCE) came from a balance this system
   *    owns, so voiding can simply put it back — and MUST, or the customer's
   *    credit is silently consumed by an invoice that no longer exists.
   *  - **External money** (cash, check, card) left the customer's hands. Software
   *    cannot un-take it, so it still blocks the void until a human refunds or
   *    reverses it.
   *
   * Returns the external total so callers can decide whether to block.
   */
  private externalPaidOn(payments: Array<{ method?: unknown; amount: unknown; status?: string }>) {
    return roundMoney(
      payments
        .filter(
          (p) =>
            p.status !== "VOID" &&
            (p.method as any) !== "CREDIT_NOTE" &&
            (p.method as any) !== "ADVANCE",
        )
        .reduce((s, p) => s + Number(p.amount), 0),
    );
  }

  /**
   * Hand an invoice's wallet-funded payments back to the balances they came from:
   * credit notes via the credit-note restore primitive, advances by re-crediting
   * `AdvancePayment.balance` (mirroring voidPayment's inverse). Returns what moved
   * so the caller can report it.
   */
  async releaseWalletPaymentsInTx(tx: any, invoiceId: string) {
    const credits = await this.creditNotes.releaseInvoiceCreditsInTx(tx, invoiceId);

    const advancePays = await tx.invoicePayment.findMany({
      where: {
        invoiceId,
        method: "ADVANCE" as any,
        status: { not: "VOID" },
        advancePaymentId: { not: null },
      },
    });
    let advances = 0;
    for (const p of advancePays) {
      const amt = roundMoney(Number(p.amount));
      await tx.advancePayment.update({
        where: { id: p.advancePaymentId },
        data: { balance: { increment: amt } },
      });
      await tx.invoicePayment.delete({ where: { id: p.id } });
      advances = roundMoney(advances + amt);
    }
    return { credits, advances };
  }

  /** The void itself, inside a caller's tx: flip to VOID, release the billed qty
   *  back to the order, and reverse the regulated ledger rows. No guards — the
   *  caller owns those (see voidInvoice) — and no credit handling, so callers that
   *  want the money back must call releaseWalletPaymentsInTx first. */
  async voidInvoiceInTx(tx: any, id: string, orderId: string | null) {
    const voided = await tx.invoice.update({
      where: { id },
      data: { status: InvoiceStatus.VOID },
    });
    await this.adjustInvoicedQtyForInvoice(tx, id, orderId, -1);
    await this.ledger.reverseInvoiceEntries({ invoiceId: id, db: tx });
    // Sales agents & commissions: a voided invoice targets zero — this
    // emits the compensating CLAWBACK adjustment when commission was claimed.
    await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
    return voided;
  }

  async voidInvoice(id: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: { payments: true },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    const external = this.externalPaidOn(inv.payments ?? []);
    if (external > 0.001)
      throw new BadRequestException(
        `Cannot void an invoice with ${formatMoney(external)} in cash/check/card payments. Reverse or refund those payments first.`,
      );

    // Wrap in a transaction so the void + invoicedQty decrements are atomic.
    // We need to free up the qty on the source order so the operator can
    // re-split into multiple invoices after void — the user's "after delivering
    // an order, it should be possible to split it into multiple invoices"
    // scenario. The auto-create-on-DELIVERED captured all remaining qty; voiding
    // releases it so a fresh split can run.
    return this.prisma.tenantTransaction(async (tx) => {
      // Wallet money first: a credit applied to this invoice goes back to its note
      // (spendable again) instead of being stranded on a dead invoice.
      await this.releaseWalletPaymentsInTx(tx, id);
      return this.voidInvoiceInTx(tx, id, inv.orderId);
    });
  }

  /**
   * Adjust OrderItem.invoicedQty for every line on an invoice that came from an
   * order, by `direction` × the invoice line's qty:
   *   - direction -1 (void/delete): RELEASE the qty so `qty - invoicedQty` reflects
   *     what's still billable and the operator can re-split.
   *   - direction +1 (unvoid): RE-CLAIM the qty the invoice bills again, so a later
   *     invoice can't double-bill it. Capped at the order line's qty.
   *
   * Match is by the invoice line's `orderItemId` provenance — precise even when an
   * order has multiple lines for the same product. Legacy invoice rows that predate
   * the provenance column fall back to first-match-by-productId (the old behaviour).
   */
  private async adjustInvoicedQtyForInvoice(
    tx: any,
    invoiceId: string,
    orderId: string | null,
    direction: -1 | 1,
  ): Promise<void> {
    if (!orderId) return; // standalone invoice — nothing to adjust
    const items = await tx.invoiceItem.findMany({
      where: { invoiceId },
      select: { productId: true, qty: true, orderItemId: true },
    });
    if (items.length === 0) return;

    // Precise path: adjust the exact source order line by this invoice line's qty.
    const byOrderItem = new Map<string, number>();
    // Legacy path: invoice lines with no provenance, aggregated by product.
    const byProduct = new Map<string, number>();
    for (const it of items) {
      if (it.orderItemId) {
        byOrderItem.set(it.orderItemId, (byOrderItem.get(it.orderItemId) ?? 0) + Number(it.qty));
      } else if (it.productId) {
        byProduct.set(it.productId, (byProduct.get(it.productId) ?? 0) + Number(it.qty));
      }
    }
    if (byOrderItem.size === 0 && byProduct.size === 0) return;

    const orderItems = await tx.orderItem.findMany({
      where: { orderId },
      select: { id: true, productId: true, qty: true, invoicedQty: true },
    });
    const adjust = async (oi: any, qtyDelta: number) => {
      // Clamp into [0, line qty]: never negative, never claim more than the line has.
      const next = Math.min(
        Number(oi.qty ?? 0),
        Math.max(0, Number(oi.invoicedQty ?? 0) + direction * qtyDelta),
      );
      await tx.orderItem.update({ where: { id: oi.id }, data: { invoicedQty: next } });
    };

    for (const [orderItemId, qty] of byOrderItem) {
      const target = orderItems.find((oi: any) => oi.id === orderItemId);
      if (target) await adjust(target, qty);
    }
    for (const [productId, qty] of byProduct) {
      const target = orderItems.find((oi: any) => oi.productId === productId);
      if (target) await adjust(target, qty);
    }
  }

  async revertInvoiceToDraft(id: string) {
    const inv = await this.findOneOrThrow(id);
    const revertableStatuses = [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE];
    if (!revertableStatuses.includes(inv.status as any)) {
      throw new BadRequestException(
        `Only SENT, VIEWED, or OVERDUE invoices with no payments can be reverted to Draft. Current status: ${inv.status}`,
      );
    }
    // Block if there are any payments
    const paymentCount = await this.prisma
      .forTenant()
      .invoicePayment.count({ where: { invoiceId: id } });
    if (paymentCount > 0) {
      throw new BadRequestException(
        "Cannot revert to Draft: this invoice has payments recorded. Void it instead.",
      );
    }
    // Sales agents & commissions: revert + resync are one atomic unit — a
    // DRAFT invoice targets zero commission.
    return this.prisma.tenantTransaction(async (tx) => {
      const reverted = await tx.invoice.update({
        where: { id },
        data: { status: InvoiceStatus.DRAFT, sentAt: null, pdfUrl: null },
      });
      await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
      return reverted;
    });
  }

  /**
   * When an order with a SENT (non-draft) pending-mirror invoice is edited, bring
   * that invoice back to DRAFT so the edit re-syncs into it instead of silently
   * diverging (the "edit after send" price-drift class). Only invoices with ZERO
   * payments are auto-reverted; a paid/partly-paid invoice throws instead — money
   * must never silently detach from a sent document. Per-batch delivery invoices
   * (deliveryBatchId != null, only on delivered orders) are never touched. Returns
   * the reverted invoice ids (empty when there's nothing to revert). Call BEFORE
   * mutating the order, so a payment-block aborts the whole edit cleanly.
   */
  async revertLinkedInvoicesForOrderEdit(orderId: string, tx?: any): Promise<string[]> {
    const db = tx ?? this.prisma.forTenant();
    const linked = await db.invoice.findMany({
      where: {
        orderId,
        deliveryBatchId: null,
        status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE] },
      },
      select: { id: true, invoiceNumber: true, internalNotes: true },
    });
    if (linked.length === 0) return [];

    const reverted: string[] = [];
    for (const inv of linked) {
      const paymentCount = await db.invoicePayment.count({ where: { invoiceId: inv.id } });
      if (paymentCount > 0) {
        throw new BadRequestException(
          `This order can't be edited while invoice ${inv.invoiceNumber} has payments recorded. ` +
            `Void the invoice or remove its payments first.`,
        );
      }
      const auditLine = `[${new Date().toLocaleDateString()} — reverted to Draft: source order edited]`;
      await db.invoice.update({
        where: { id: inv.id },
        data: {
          status: InvoiceStatus.DRAFT,
          sentAt: null,
          pdfUrl: null,
          internalNotes: inv.internalNotes ? `${inv.internalNotes}\n${auditLine}` : auditLine,
        },
      });
      reverted.push(inv.id);
    }
    return reverted;
  }

  async unvoidInvoice(id: string) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status !== InvoiceStatus.VOID) {
      throw new BadRequestException(
        `Only VOID invoices can be unvoided. Current status: ${inv.status}`,
      );
    }
    // Voiding RELEASED this invoice's invoicedQty back to the order; bringing it
    // back to DRAFT re-claims that qty so a later invoice can't double-bill the
    // same lines. Atomic with the status flip. (Ledger reversal is not un-done here
    // — regulated-ledger un-reversal on unvoid is a separate follow-up.)
    return this.prisma.tenantTransaction(async (tx) => {
      const restored = await tx.invoice.update({
        where: { id },
        data: { status: InvoiceStatus.DRAFT },
      });
      await this.adjustInvoicedQtyForInvoice(tx, id, inv.orderId, 1);
      return restored;
    });
  }

  async reopenInvoice(id: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status !== InvoiceStatus.PAID)
      throw new BadRequestException("Only PAID invoices can be reopened");

    // Sales agents & commissions: PAID→DRAFT is the nastiest clawback path —
    // if commission was already claimed, sync emits the negative adjustment
    // atomically with the status flip.
    return this.prisma.tenantTransaction(async (tx) => {
      const reopened = await tx.invoice.update({
        where: { id },
        data: { status: InvoiceStatus.DRAFT, paidAt: null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
      return reopened;
    });
  }

  async duplicate(id: string) {
    const inv = await this.prisma
      .forTenant()
      .invoice.findUnique({ where: { id }, include: { items: true } });
    if (!inv) throw new NotFoundException("Invoice not found");
    // RF-011: order-linked invoices must not be duplicated — the order is the
    // canonical billing source and a second copy would double-bill the customer.
    if (inv.orderId !== null) {
      throw new BadRequestException(
        "Cannot duplicate an order-linked invoice. Create a new invoice or issue a credit note instead.",
      );
    }

    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { id: inv.customerId }, select: { isTaxExempt: true } });

    // Duplicate carries each line's already-correct stored subtotal + boxes/pieces
    // split verbatim (recomputing qty*unitPrice would over-charge boxed lines).
    const itemsData = inv.items.map((i) => ({
      description: i.description,
      productId: i.productId,
      qty: i.qty,
      unitPrice: i.unitPrice,
      discount: i.discount,
      taxRate: i.taxRate,
      boxes: (i as any).boxes ?? null,
      pieces: (i as any).pieces ?? null,
      // BUY_N_GET_M snapshot travels with the copy — the subtotal is verbatim, and
      // without the snapshot the copy's first edit would re-price the line to full.
      promoFreeUnits: (i as any).promoFreeUnits ?? null,
      // MSRP is copied VERBATIM, not re-resolved — a duplicate must show what the
      // source line showed, never a live re-read of the (possibly since-changed)
      // product/customer MSRP.
      msrp: (i as any).msrp != null ? Number((i as any).msrp) : null,
      subtotal: roundMoney(Number(i.subtotal)),
      // RF-4: carry each line's category tax + regulated snapshots onto the copy.
      trackedCategoryId: (i as any).trackedCategoryId ?? null,
      trackedSubcategoryId: (i as any).trackedSubcategoryId ?? null,
      categoryTaxAmount: roundMoney(Number((i as any).categoryTaxAmount ?? 0)),
      tenantId: this.prisma.getTenantId(),
    }));
    const subtotal = roundMoney(itemsData.reduce((s, i) => s + Number(i.subtotal), 0));
    const isTaxExempt = !!(customer as any)?.isTaxExempt;
    const regularTax = isTaxExempt
      ? 0
      : roundMoney(itemsData.reduce((s, i) => s + Number(i.subtotal) * Number(i.taxRate ?? 0), 0));
    // RF-4: fold category tax (exempt → 0 both + zeroed snapshots).
    const categoryTaxTotal = this.foldCategoryTax(itemsData, isTaxExempt);
    const taxTotal = roundMoney(regularTax + categoryTaxTotal);
    const invDiscount = Number(inv.discount ?? 0);
    const shipping = Number(inv.shippingFee ?? 0);
    const total = roundMoney(subtotal - invDiscount + shipping + taxTotal);

    return this.prisma.forTenant().invoice.create({
      data: {
        invoiceNumber: await this.nextInvoiceNumber(),
        customerId: inv.customerId,
        status: InvoiceStatus.DRAFT,
        subtotal,
        taxAmount: taxTotal,
        discount: invDiscount,
        shippingFee: shipping,
        total,
        notes: inv.notes,
        terms: inv.terms,
        // Copy the "Net 30"-style label verbatim — it still describes this line-item
        // set. Deposit fields do NOT travel: a duplicate is a fresh invoice with its
        // own (unstarted) payment story, not a continuation of the source's deposit
        // schedule (out of scope: no InvoiceInstallment / deposit-aware statuses).
        paymentTermsLabel: (inv as any).paymentTermsLabel ?? null,
        referenceNumber: (inv as any).referenceNumber ?? null,
        subject: (inv as any).subject ?? null,
        items: { create: itemsData },
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: true,
      },
    });
  }

  // ─── List all payments (across all invoices) ─────────────────────────────

  async listAllPayments(query: {
    page?: number;
    limit?: number;
    customerId?: string;
    method?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    sortBy?: string;
    sortDir?: string;
  }) {
    const {
      page = 1,
      customerId,
      method,
      status,
      dateFrom,
      dateTo,
      search,
      sortBy,
      sortDir,
    } = query;
    // Raw query-string limit (no DTO on this route) — clamp so a single request
    // can't force an unbounded scan (security F9-002).
    const limit = clampLimit(query.limit, 25);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (customerId) where.invoice = { customerId };
    if (method) where.method = method;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.paidAt = {};
      if (dateFrom) where.paidAt.gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        where.paidAt.lte = end;
      }
    }
    if (search) {
      where.OR = [
        { paymentNumber: { contains: search, mode: "insensitive" } },
        { reference: { contains: search, mode: "insensitive" } },
        { invoice: { customer: { businessName: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const validSortFields: Record<string, any> = {
      paidAt: { paidAt: sortDir === "asc" ? "asc" : "desc" },
      settledAt: { settledAt: sortDir === "asc" ? "asc" : "desc" },
      amount: { amount: sortDir === "asc" ? "asc" : "desc" },
      createdAt: { createdAt: sortDir === "asc" ? "asc" : "desc" },
      paymentNumber: { paymentNumber: sortDir === "asc" ? "asc" : "desc" },
    };
    const orderBy = validSortFields[sortBy ?? ""] ?? { paidAt: "desc" };

    const include = {
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          customerId: true,
          customer: { select: { id: true, businessName: true } },
        },
      },
    };

    const [data, total] = await Promise.all([
      this.prisma
        .forTenant()
        .invoicePayment.findMany({ where, skip, take: limit, orderBy, include }),
      this.prisma.forTenant().invoicePayment.count({ where }),
    ]);

    // Summary: total received (PAID only) and advance balance
    const summaryWhere = { ...where, status: "PAID" };
    const paidPayments = await this.prisma.forTenant().invoicePayment.findMany({
      where: summaryWhere,
      select: { amount: true },
    });
    const totalReceived = paidPayments.reduce((s, p) => s + Number(p.amount), 0);

    const advanceWhere: any = customerId ? { customerId } : {};
    const advances = await this.prisma.forTenant().advancePayment.findMany({
      where: advanceWhere,
      select: { balance: true },
    });
    const advanceBalance = advances.reduce((s, a) => s + Number(a.balance), 0);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      summary: { totalReceived, count: paidPayments.length, advanceBalance },
    };
  }

  async findPaymentById(paymentId: string) {
    const payment = await this.prisma.forTenant().invoicePayment.findUnique({
      where: { id: paymentId },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            customerId: true,
            customer: { select: { id: true, businessName: true } },
          },
        },
      },
    });
    if (!payment) throw new NotFoundException("Payment not found");
    return payment;
  }

  private async findPaymentOrThrow(paymentId: string) {
    const payment = await this.prisma
      .forTenant()
      .invoicePayment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException("Payment not found");
    return payment;
  }

  /**
   * Attach a receipt/slip/check photo to a payment EVENT. Uses `compressDocument`
   * (NOT `compressImage`) — like the expense-receipt endpoint, this route has no
   * controller MIME allowlist and mobile file pickers routinely send
   * `application/octet-stream`/empty content-type; `compressDocument` byte-sniffs
   * via sharp (any real image → JPEG) and tolerates a PDF, so a real receipt/check
   * photo never 500s on a generic content-type.
   */
  async uploadPaymentImage(
    paymentId: string,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
  ): Promise<{ url: string }> {
    const payment = await this.findPaymentOrThrow(paymentId);
    let compressed;
    try {
      compressed = await compressDocument(buffer, mimeType);
    } catch {
      throw new BadRequestException("File is not a decodable image or PDF");
    }
    // One object per payment EVENT: a grouped standalone payment (several rows
    // sharing paymentGroupId) anchors on the group id so the same photo is
    // reachable from every allocation row.
    const anchor = payment.paymentGroupId ?? payment.id;
    const key = `payments/${anchor}/image.${compressed.ext}`;
    await this.storage.upload(key, compressed.buffer, compressed.mimeType);
    const data = {
      imageKey: key,
      imageOriginalName: originalName,
      imageMimeType: compressed.mimeType,
    };
    if (payment.paymentGroupId) {
      await this.prisma
        .forTenant()
        .invoicePayment.updateMany({ where: { paymentGroupId: payment.paymentGroupId }, data });
    } else {
      await this.prisma.forTenant().invoicePayment.update({ where: { id: paymentId }, data });
    }
    return { url: await this.storage.presignedUrl(key) };
  }

  async getPaymentImageUrl(paymentId: string): Promise<{ url: string }> {
    const payment = await this.findPaymentOrThrow(paymentId);
    if (!payment.imageKey) throw new NotFoundException("No image attached to this payment");
    return { url: await this.storage.presignedUrl(payment.imageKey) };
  }

  async deletePaymentImage(paymentId: string): Promise<{ success: boolean }> {
    const payment = await this.findPaymentOrThrow(paymentId);
    if (!payment.imageKey) throw new NotFoundException("No image to delete");
    const clear = { imageKey: null, imageOriginalName: null, imageMimeType: null };
    if (payment.paymentGroupId) {
      await this.prisma.forTenant().invoicePayment.updateMany({
        where: { paymentGroupId: payment.paymentGroupId },
        data: clear,
      });
    } else {
      await this.prisma
        .forTenant()
        .invoicePayment.update({ where: { id: paymentId }, data: clear });
    }
    await this.storage.delete(payment.imageKey);
    return { success: true };
  }

  // ─── Payment recording ────────────────────────────────────────────────────

  async recordPayment(id: string, dto: RecordInvoicePaymentDto) {
    if ((dto.method as any) === "CREDIT_NOTE" || (dto.method as any) === "ADVANCE") {
      throw new BadRequestException(
        "Use the dedicated 'Apply Credit Note' or 'Apply Advance Payment' actions for these methods so the source balance is properly debited.",
      );
    }
    return this.prisma.tenantTransaction(async (tx) => {
      // Lock the invoice row so concurrent payment requests serialize here
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;

      const inv = await tx.invoice.findUnique({
        where: { id },
        include: { payments: { where: { status: { not: "VOID" as any } } } },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot record payment on voided invoice");

      const alreadyPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      const remaining = total - alreadyPaid;
      const paymentStatus = dto.status ?? "PAID";

      if (paymentStatus === "PAID") {
        if (remaining <= 0) throw new BadRequestException("Invoice is already fully paid");
        if (dto.amount > remaining + 0.001)
          throw new BadRequestException(
            `Payment exceeds remaining balance of ${remaining.toFixed(2)}`,
          );
      }

      // Auto-generate payment number — use tenantId as the counter row key so
      // each tenant has its own independent sequence. Include a short tenant hash
      // in the payment number to avoid global @unique collisions across tenants.
      const counterKey = this.prisma.getTenantId() ?? "singleton";
      const tenantShort = counterKey.slice(0, 6).toUpperCase();
      const counter = await tx.paymentCounter.upsert({
        where: { id: counterKey },
        update: { next: { increment: 1 } },
        create: { id: counterKey, next: 2 },
      });
      const paymentNumber = `PAY-${tenantShort}-${String(counter.next - 1).padStart(4, "0")}`;

      const createdPayment = await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          // Never clamped: a post-dated check settles in the future.
          settledAt: dto.settledAt ? new Date(dto.settledAt) : null,
          bankCharges: dto.bankCharges,
          status: paymentStatus as any,
          paymentNumber,
          checkStatus: dto.method === "CHECK" ? CheckStatus.RECORDED : null,
        },
      });

      const newPaid = paymentStatus === "PAID" ? alreadyPaid + dto.amount : alreadyPaid;
      const newStatus =
        paymentStatus === "PAID"
          ? this.recomputeStatus(newPaid, total, inv.dueDate, inv.status)
          : inv.status;

      const paid = await tx.invoice.update({
        where: { id },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId: paid.id,
        invoiceNumber: paid.invoiceNumber,
        customerId: paid.customerId,
        status: newStatus,
        total: Number(paid.total),
      });
      await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
      return { ...paid, createdPaymentId: createdPayment.id };
    });
  }

  /**
   * Record a driver-collected payment at stop completion, resolving the target
   * invoice(s) SERVER-side from the delivered orders. The mobile client cannot
   * supply an invoiceId (Order has no invoiceId scalar and the run/stop payload
   * never carries one), which is why every at-door payment silently vanished.
   * Runs INSIDE the caller's transaction so it is atomic with stop completion.
   *
   * Per delivered order: ensure a finalized invoice exists — reconcile an open
   * DRAFT "pending mirror" (full-order basis, as changeStatus→DELIVERED does),
   * else create one from the order. Then apply the lump-sum across the orders'
   * non-VOID invoices OLDEST-first (base invoice before any regulated `-R#`
   * split siblings), capped at each invoice's remaining. Each application
   * finalizes a DRAFT→SENT (recomputeStatus treats DRAFT as terminal, so a
   * payment on a still-DRAFT invoice would never move it off DRAFT) and is
   * recorded the canonical way — an InvoicePayment row + recomputeStatus over
   * the non-VOID payment sum, NEVER the (non-existent) `balance` scalar the old
   * completeWithPayment code tried to decrement.
   *
   * @param reconcileOrderIds the subset of `orderIds` actually delivered in this
   *          completion — only these have their DRAFT rebuilt on the delivered
   *          quantity (and only when single-invoice). Defaults to all `orderIds`.
   * @returns the amount actually applied (< amount only when the orders'
   *          invoices were already covered — the caller should log any residual).
   */
  async recordDeliveryPaymentInTx(
    tx: any,
    orderIds: string[],
    amount: number,
    method: string,
    reconcileOrderIds?: string[],
  ): Promise<{ applied: number; invoiceIds: string[]; paymentIds: string[] }> {
    if (!(amount > 0) || orderIds.length === 0)
      return { applied: 0, invoiceIds: [], paymentIds: [] };
    // CREDIT_NOTE/ADVANCE must debit a source balance (see recordPayment); a driver
    // at-door collection is never one of these (On-account sends amount 0), so
    // refuse to book a phantom payment rather than bypass the source debit.
    if (method === "CREDIT_NOTE" || method === "ADVANCE")
      return { applied: 0, invoiceIds: [], paymentIds: [] };

    // Payable statuses — exclude terminal VOID/WRITTEN_OFF: a written-off bad debt
    // must not swallow the cash (recomputeStatus can't advance it), which would also
    // starve a live sibling since we apply oldest-first.
    const PAYABLE = [
      InvoiceStatus.DRAFT,
      InvoiceStatus.SENT,
      InvoiceStatus.PARTIAL,
      InvoiceStatus.OVERDUE,
    ];

    // Only orders actually delivered in THIS completion may be rebuilt on the
    // delivered basis. Default to all orderIds for callers that don't distinguish
    // (there are none today) — but the driver path passes the real subset so an
    // order merely linked to the stop yet not delivered here (deliveredQty 0) is
    // never zeroed.
    const reconcileSet = new Set(reconcileOrderIds ?? orderIds);

    // 1. Ensure each delivered order has a DRAFT invoice, then reconcile it to the
    //    DELIVERED quantities so short/refused lines bill what was delivered, not
    //    the full order. createInvoiceFromOrder makes a DRAFT when the order has no
    //    live invoice yet; reconcileOrderDraftInvoice(basis:"delivered") rebuilds it
    //    on OrderItem.deliveredQty and telescopes invoicedQty (idempotent with the
    //    office from-order flow — a later re-delivery bills only the remainder).
    for (const orderId of orderIds) {
      let draft = await this.findOpenOrderDraft(orderId, tx);
      if (!draft) {
        const existing = await tx.invoice.findFirst({
          where: { orderId, status: { in: PAYABLE } },
          select: { id: true },
        });
        // Create a fresh DRAFT only when the order has no live invoice at all; if a
        // non-DRAFT invoice already exists (e.g. the office already sent one), leave
        // it and just pay it below.
        if (!existing) {
          await this.createInvoiceFromOrder(orderId, tx);
          draft = await this.findOpenOrderDraft(orderId, tx);
        }
      }
      if (draft && reconcileSet.has(orderId)) {
        // Rebuild the order's open DRAFT(s) on the delivered qty, SIBLING-AWARE: a
        // regulated SEPARATE_INVOICE order (base + -R#) has each draft rebuilt from
        // ONLY its own lines, so a short/refused line bills its delivered qty on its
        // own sibling and is never folded onto the base (no double-bill). A
        // single-group order is byte-identical to the group-unaware delivered
        // reconcile. (Replaces the old invoiceCount<=1 skip that left split orders
        // billing the full ordered qty.)
        await this.reconcileOrderDeliveredInvoices(orderId, tx);
      }
    }

    // 2. The orders' payable invoices, oldest-first.
    const invoices = await tx.invoice.findMany({
      where: { orderId: { in: orderIds }, status: { in: PAYABLE } },
      orderBy: [{ createdAt: "asc" }, { invoiceNumber: "asc" }],
      select: {
        id: true,
        total: true,
        status: true,
        dueDate: true,
        invoiceNumber: true,
        customerId: true,
      },
    });
    if (invoices.length === 0) return { applied: 0, invoiceIds: [], paymentIds: [] };

    // 3. Spread the lump-sum oldest-first, capped at each invoice's remaining.
    let remaining = roundMoney(amount);
    const invoiceIds: string[] = [];
    const paymentIds: string[] = [];
    for (const inv of invoices) {
      if (remaining <= 0.001) break;
      // Row-lock (like recordPayment) then read paid FRESH, so a concurrent
      // back-office payment on the same invoice can't also read 0 and over-collect.
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${inv.id} FOR UPDATE`;
      const priorPayments = await tx.invoicePayment.findMany({
        where: { invoiceId: inv.id, status: { not: "VOID" as any } },
        select: { amount: true },
      });
      const total = Number(inv.total);
      const alreadyPaid = priorPayments.reduce((s: number, p: any) => s + Number(p.amount), 0);
      const invRemaining = roundMoney(total - alreadyPaid);
      if (invRemaining <= 0.001) continue;
      const applyHere = roundMoney(Math.min(remaining, invRemaining));

      // A delivered+paid order's invoice is genuinely issued; finalize a DRAFT
      // pending-mirror so recomputeStatus (DRAFT is terminal) can advance it.
      const wasDraft = inv.status === InvoiceStatus.DRAFT;
      const baseStatus = wasDraft ? InvoiceStatus.SENT : inv.status;

      const paymentNumber = await this.nextPaymentNumberInTx(tx);
      const pay = await tx.invoicePayment.create({
        data: {
          invoiceId: inv.id,
          amount: applyHere,
          method: method as any,
          paidAt: new Date(),
          status: "PAID" as any,
          paymentNumber,
          checkStatus: method === "CHECK" ? CheckStatus.RECORDED : null,
        },
      });

      const newStatus = this.recomputeStatus(
        alreadyPaid + applyHere,
        total,
        inv.dueDate,
        baseStatus,
      );
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null,
          ...(wasDraft ? { sentAt: new Date() } : {}),
        },
      });
      await this.commissionEngine.syncInvoiceCommissionSafe(inv.id, tx);
      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerId: inv.customerId,
        status: newStatus,
        total,
      });

      invoiceIds.push(inv.id);
      paymentIds.push(pay.id);
      remaining = roundMoney(remaining - applyHere);
    }
    return { applied: roundMoney(amount - remaining), invoiceIds, paymentIds };
  }

  /** Tenant-scoped `PAY-XXXX-####` sequence — mirrors recordPayment's counter. */
  private async nextPaymentNumberInTx(tx: any): Promise<string> {
    const counterKey = this.prisma.getTenantId() ?? "singleton";
    const tenantShort = counterKey.slice(0, 6).toUpperCase();
    const counter = await tx.paymentCounter.upsert({
      where: { id: counterKey },
      update: { next: { increment: 1 } },
      create: { id: counterKey, next: 2 },
    });
    return `PAY-${tenantShort}-${String(counter.next - 1).padStart(4, "0")}`;
  }

  async updatePayment(invoiceId: string, paymentId: string, dto: UpdatePaymentDto) {
    if ((dto.method as any) === "CREDIT_NOTE" || (dto.method as any) === "ADVANCE") {
      throw new BadRequestException(
        "Cannot edit a payment to method CREDIT_NOTE or ADVANCE. Void this payment and apply the credit note / advance via the dedicated action.",
      );
    }
    return this.prisma.tenantTransaction(async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot edit payment on voided invoice");

      const payment = inv.payments.find((p) => p.id === paymentId);
      if (!payment) throw new NotFoundException("Payment not found");

      const newPaymentStatus = dto.status ?? payment.status ?? "PAID";

      // When voiding: treat the payment as $0 for balance checks
      const effectiveAmount = newPaymentStatus === "VOID" ? 0 : dto.amount;

      // Sum all other non-void payments plus the effective new amount
      const othersTotal = inv.payments
        .filter((p) => p.id !== paymentId && p.status !== "VOID")
        .reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      if (newPaymentStatus !== "VOID" && dto.amount > total - othersTotal + 0.001) {
        throw new BadRequestException(`Payment amount exceeds remaining balance`);
      }

      await tx.invoicePayment.update({
        where: { id: paymentId },
        data: {
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
          ...(dto.paidAt && { paidAt: new Date(dto.paidAt) }),
          // Key present = set or (null) clear; key absent = keep what is stored.
          ...(dto.settledAt !== undefined && {
            settledAt: dto.settledAt ? new Date(dto.settledAt) : null,
          }),
          ...(dto.bankCharges !== undefined && { bankCharges: dto.bankCharges }),
          status: newPaymentStatus,
        },
      });

      const newPaid = othersTotal + effectiveAmount;
      const newStatus = this.recomputeStatus(newPaid, total, inv.dueDate, inv.status);
      const updated = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId: updated.id,
        invoiceNumber: updated.invoiceNumber,
        customerId: updated.customerId,
        status: newStatus,
        total: Number(updated.total),
      });
      await this.commissionEngine.syncInvoiceCommissionSafe(invoiceId, tx);
      return updated;
    });
  }

  async deletePayment(invoiceId: string, paymentId: string) {
    let imageKey: string | null = null;
    const updated = await this.prisma.tenantTransaction(async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot delete payment on voided invoice");

      const payment = inv.payments.find((p) => p.id === paymentId);
      if (!payment) throw new NotFoundException("Payment not found");
      imageKey = payment.imageKey;
      if ((payment.method as any) === "CREDIT_NOTE") {
        throw new BadRequestException(
          "This payment is an applied credit note. Un-apply it from the credit note instead (POST /credit-notes/:id/unapply) so the credit's balance is restored.",
        );
      }

      // ADVANCE applications debited AdvancePayment.balance when applied
      // (customers.service.applyAdvancePaymentToInvoice). Deleting the
      // application returns those dollars to the customer's advance wallet —
      // advances have no status machinery, so a balance increment is the complete
      // inverse. Without this the wallet is silently understated (the bug credit
      // notes had before their unapply primitive). Skip when the payment is already
      // VOID: voidPayment already restored the balance, so re-crediting on delete
      // would double-credit the wallet.
      if (
        (payment.method as any) === "ADVANCE" &&
        (payment as any).advancePaymentId &&
        payment.status !== "VOID"
      ) {
        await tx.advancePayment.update({
          where: { id: (payment as any).advancePaymentId },
          data: { balance: { increment: roundMoney(Number(payment.amount)) } },
        });
      }

      await tx.invoicePayment.delete({ where: { id: paymentId } });

      // Exclude the deleted payment AND any VOID (bounced) payment — otherwise a voided
      // payment left on the invoice would be counted as paid and mis-recompute the status.
      const remaining = inv.payments
        .filter((p) => p.id !== paymentId && p.status !== "VOID")
        .reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(inv.total);
      const newStatus = this.recomputeStatus(remaining, total, inv.dueDate, inv.status);
      const updated = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId: updated.id,
        invoiceNumber: updated.invoiceNumber,
        customerId: updated.customerId,
        status: newStatus,
        total: Number(updated.total),
      });
      await this.commissionEngine.syncInvoiceCommissionSafe(invoiceId, tx);
      return updated;
    });
    // Best-effort storage cleanup AFTER the money tx commits — never do storage
    // I/O inside the tx, and never let a storage hiccup fail the delete. Only
    // remove the object once no sibling row (grouped standalone payment) still
    // references it.
    if (imageKey) {
      const stillRef = await this.prisma.forTenant().invoicePayment.count({ where: { imageKey } });
      if (stillRef === 0) await this.storage.delete(imageKey).catch(() => {});
    }
    return updated;
  }

  // ─── Write-off ────────────────────────────────────────────────────────────

  async writeOff(id: string, dto: WriteOffDto) {
    const inv = await this.findOneOrThrow(id);
    const allowedStatuses: InvoiceStatus[] = [
      InvoiceStatus.SENT,
      InvoiceStatus.VIEWED,
      InvoiceStatus.PARTIAL,
      InvoiceStatus.OVERDUE,
    ];
    if (!allowedStatuses.includes(inv.status)) {
      throw new BadRequestException(`Cannot write off an invoice with status ${inv.status}`);
    }
    // Sales agents & commissions: materially a no-op for money (payable
    // derives from payments, and WRITTEN_OFF releases nothing beyond cash
    // already collected) but wrapped atomically to refresh the accrual's
    // display status alongside the write-off.
    return this.prisma.tenantTransaction(async (tx) => {
      const written = await tx.invoice.update({
        where: { id },
        data: {
          status: InvoiceStatus.WRITTEN_OFF,
          writeOffReason: dto.reason,
          writtenOffAt: new Date(),
        },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
      return written;
    });
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  async deleteInvoice(id: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");

      if (inv.payments.length > 0) {
        throw new BadRequestException(
          "Cannot delete an invoice that has recorded payments. Remove all payments first, or void the invoice.",
        );
      }

      // Free up invoicedQty on the source order BEFORE deleting the invoice
      // items (we read them inside the helper). Otherwise a delete leaves the
      // source order's lines flagged as fully invoiced with no surviving
      // record of why — operator can never split again.
      await this.adjustInvoicedQtyForInvoice(tx, id, inv.orderId, -1);

      // W5: reverse this invoice's regulated ledger rows before the invoice + its
      // items are deleted (the ledger keeps its own snapshot; append-only, no FK).
      await this.ledger.reverseInvoiceEntries({ invoiceId: id, db: tx });

      // Unlink credit notes that were generated for this invoice
      await tx.creditNote.updateMany({
        where: { invoiceId: id },
        data: { invoiceId: null },
      });

      // Delete line items
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });

      // Sales agents & commissions: throws ConflictException (409) if any
      // accrual on this invoice has claimedAmount > 0 — a zero-payment SENT
      // invoice can still carry claimed commission, so the delete must be
      // guarded, not silently strand/destroy the accrual.
      await this.commissionEngine.removeInvoiceCommission(id, tx);

      // Delete the invoice (also detaches orderId reference)
      await tx.invoice.delete({ where: { id } });

      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId: id,
        invoiceNumber: inv.invoiceNumber,
        customerId: inv.customerId,
        status: "DELETED" as any,
        total: Number(inv.total),
      });

      return { id, message: "Invoice deleted successfully" };
    });
  }

  // ─── Standalone (bulk-allocation) payment ────────────────────────────────

  async recordStandalonePayment(
    dto: StandalonePaymentDto,
    opts?: {
      /**
       * Reject any allocation exceeding the invoice's live balance, computed
       * inside the transaction. Buyer-initiated payments compute their
       * oldest-first allocation BEFORE this call, outside the row locks, so a
       * concurrent operator payment can stale the preview — without this check
       * the stale allocation would overpay an invoice. Operator flows keep the
       * historical behavior (deliberate overpayment is allowed there).
       */
      assertAllocationsWithinBalance?: boolean;
    },
  ) {
    const paymentGroupId = randomUUID();
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    // One bank date for the whole allocation group — the money landed once.
    const settledAt = dto.settledAt ? new Date(dto.settledAt) : null;
    const status = dto.status ?? "PAID";

    return this.prisma.tenantTransaction(async (tx) => {
      // Generate a block of sequential payment numbers (tenant-scoped counter)
      const counterKey = this.prisma.getTenantId() ?? "singleton";
      const counter = await tx.paymentCounter.upsert({
        where: { id: counterKey },
        update: { next: { increment: dto.allocations.length } },
        create: { id: counterKey, next: dto.allocations.length + 1 },
      });

      const payments: any[] = [];
      for (let i = 0; i < dto.allocations.length; i++) {
        const alloc = dto.allocations[i];
        const paymentNumber = `PAY-${String(counter.next - dto.allocations.length + i).padStart(4, "0")}`;

        // Validate invoice belongs to customer and is not voided
        const invoice = await tx.invoice.findFirst({
          where: { id: alloc.invoiceId, customerId: dto.customerId },
          include: { payments: { where: { status: { not: "VOID" as any } } } },
        });
        if (!invoice)
          throw new NotFoundException(`Invoice ${alloc.invoiceId} not found for customer`);
        if (invoice.status === "VOID")
          throw new BadRequestException(`Invoice ${alloc.invoiceId} is voided`);
        if (opts?.assertAllocationsWithinBalance) {
          const alreadyPaid = invoice.payments.reduce((s, p) => s + Number(p.amount), 0);
          const balance = roundMoney(Number(invoice.total) - alreadyPaid);
          if (alloc.amount > balance + 0.001) {
            // Rolls back the whole group; the caller recomputes and retries.
            throw new ConflictException(
              `Payments on invoice ${invoice.invoiceNumber} changed while this payment was being prepared — please retry.`,
            );
          }
        }

        const payment = await tx.invoicePayment.create({
          data: {
            invoiceId: alloc.invoiceId,
            amount: alloc.amount,
            method: dto.method as any,
            paidAt,
            settledAt,
            bankCharges: dto.bankCharges,
            reference: dto.reference,
            notes: dto.notes,
            status: status as any,
            paymentNumber,
            paymentGroupId,
            checkStatus: dto.method === "CHECK" ? CheckStatus.RECORDED : null,
          },
        });
        payments.push(payment);

        if (status === "PAID") {
          const allPayments = await tx.invoicePayment.findMany({
            where: { invoiceId: alloc.invoiceId, status: { not: "VOID" as any } },
          });
          const totalPaid = allPayments.reduce((s, p) => s + Number(p.amount), 0);
          const newStatus = this.recomputeStatus(
            totalPaid,
            Number(invoice.total),
            invoice.dueDate,
            invoice.status,
          );
          await tx.invoice.update({
            where: { id: alloc.invoiceId },
            data: {
              status: newStatus,
              paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null,
            },
          });
        }
      }

      // Commission hook: the payments-modal / buyer-allocation path creates PAID
      // payments across many invoices — each one's payable must move with the
      // cash in the SAME tx (otherwise it lags until the reconciliation cron).
      for (const alloc of dto.allocations) {
        await this.commissionEngine.syncInvoiceCommissionSafe(alloc.invoiceId, tx);
      }

      // Handle excess amount → create AdvancePayment
      const allocatedTotal = dto.allocations.reduce((s, a) => s + a.amount, 0);
      const excess = dto.totalAmount - allocatedTotal;
      if (excess > 0.001) {
        await tx.advancePayment.create({
          data: {
            customerId: dto.customerId,
            amount: excess,
            balance: excess,
            method: dto.method as any,
            reference: dto.reference,
            notes: dto.notes,
            receivedAt: paidAt,
          },
        });
      }

      return { payments, paymentGroupId, excess: Math.max(0, excess) };
    });
  }

  // ─── Void a single payment ────────────────────────────────────────────────

  async voidPayment(invoiceId: string, paymentId: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      const payment = await tx.invoicePayment.findFirst({
        where: { id: paymentId, invoiceId },
      });
      if (!payment) throw new NotFoundException("Payment not found");
      if (payment.status === "VOID") throw new BadRequestException("Payment already voided");
      if ((payment.method as any) === "CREDIT_NOTE") {
        throw new BadRequestException(
          "This payment is an applied credit note. Un-apply it from the credit note instead (POST /credit-notes/:id/unapply) so the credit's balance is restored.",
        );
      }

      // ADVANCE applications debited AdvancePayment.balance when applied
      // (customers.service.applyAdvancePaymentToInvoice). Voiding the
      // application returns those dollars to the customer's advance wallet —
      // advances have no status machinery, so a balance increment is the complete
      // inverse. Without this the wallet is silently understated (the bug credit
      // notes had before their unapply primitive).
      if ((payment.method as any) === "ADVANCE" && (payment as any).advancePaymentId) {
        await tx.advancePayment.update({
          where: { id: (payment as any).advancePaymentId },
          data: { balance: { increment: roundMoney(Number(payment.amount)) } },
        });
      }

      await tx.invoicePayment.update({
        where: { id: paymentId },
        data: { status: "VOID" as any },
      });

      // Recompute invoice status treating this payment as $0
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: { where: { status: { not: "VOID" as any } } } },
      });
      if (!invoice) throw new NotFoundException("Invoice not found");

      const totalPaid = invoice.payments
        .filter((p) => p.id !== paymentId)
        .reduce((s, p) => s + Number(p.amount), 0);
      const newStatus = this.recomputeStatus(
        totalPaid,
        Number(invoice.total),
        invoice.dueDate,
        invoice.status,
      );
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? invoice.paidAt : null,
        },
      });

      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        status: newStatus,
        total: Number(invoice.total),
      });
      await this.commissionEngine.syncInvoiceCommissionSafe(invoiceId, tx);
      return { success: true };
    });
  }

  // ─── P5-12: check lifecycle (Recorded→Deposited→Cleared→Bounced) ──────────

  /**
   * Advance a CHECK payment through its lifecycle.
   *
   * DEPOSITED / CLEARED are bookkeeping-only: the payment stays PAID and no
   * balance changes. BOUNCED (NSF) is modeled on voidPayment(): the payment
   * flips to PaymentStatus VOID so every existing non-VOID paid-sum /
   * status:PAID aggregation (P&L, AR aging, cash flow, statements) excludes it
   * automatically — then the invoice status is recomputed, re-opening the
   * balance. When an NSF fee is given, the customer genuinely owes it: a
   * non-taxable ad-hoc InvoiceItem line is appended AND the STORED
   * Invoice.subtotal/total are bumped by roundMoney(fee) in the same
   * transaction (all balance readers use the stored total).
   */
  async setCheckStatus(invoiceId: string, paymentId: string, dto: SetCheckStatusDto) {
    return this.prisma.tenantTransaction(async (tx) => {
      const payment = await tx.invoicePayment.findFirst({
        where: { id: paymentId, invoiceId },
      });
      if (!payment) throw new NotFoundException("Payment not found");
      if (payment.method !== "CHECK")
        throw new BadRequestException("Check status can only be set on CHECK payments");
      if (payment.status === "VOID")
        throw new BadRequestException("Payment is voided — its check status can no longer change");

      const current: CheckStatus = payment.checkStatus ?? "RECORDED";
      if (!CHECK_TRANSITIONS[current].includes(dto.status)) {
        throw new BadRequestException(`Cannot move check from ${current} to ${dto.status}`);
      }

      const now = new Date();
      // clearedAt is the CHECK-lifecycle audit mark — when the transition happened —
      // so it may default to the clock. settledAt is operator-supplied truth about
      // the bank and must NEVER be inferred from when someone clicked: cash-basis
      // reporting windows on `settledAt ?? paidAt`, so stamping it here would move a
      // historical payment into the current period and restate a closed one. Absent
      // an explicit date the column stays as it is (NULL rows keep falling back to
      // paidAt); an explicit date is authoritative and drives both fields.
      const explicitSettledAt = dto.settledAt ? new Date(dto.settledAt) : null;

      if (dto.status === "DEPOSITED" || dto.status === "CLEARED") {
        await tx.invoicePayment.update({
          where: { id: paymentId },
          data: {
            checkStatus: dto.status,
            ...(dto.status === "DEPOSITED"
              ? { depositedAt: now }
              : {
                  clearedAt: explicitSettledAt ?? now,
                  ...(explicitSettledAt ? { settledAt: explicitSettledAt } : {}),
                }),
          },
        });
        const invoice = await tx.invoice.findFirst({
          where: { id: invoiceId },
          select: { invoiceNumber: true, customerId: true, status: true, total: true },
        });
        if (!invoice) throw new NotFoundException("Invoice not found");
        this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
          invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          status: invoice.status,
          total: Number(invoice.total),
        });
        return { success: true, checkStatus: dto.status };
      }

      // ── BOUNCED (NSF) — mirror voidPayment()'s recompute exactly ──────────
      const fee = roundMoney(dto.nsfFeeAmount ?? 0);
      // Compare-and-swap guard against a concurrent double-bounce: two
      // overlapping requests both read the payment as PAID above, but only the
      // first flips it to VOID. The loser's updateMany matches 0 rows (the row
      // is now VOID) and we abort BEFORE billing the NSF fee / bumping the
      // stored total a second time. The `findFirst` guard alone is not enough —
      // it reads a stale snapshot under READ COMMITTED.
      const bounced = await tx.invoicePayment.updateMany({
        where: { id: paymentId, status: { not: "VOID" as any } },
        data: {
          checkStatus: "BOUNCED",
          bouncedAt: now,
          nsfFeeAmount: fee,
          status: "VOID" as any,
        },
      });
      if (bounced.count === 0) {
        throw new BadRequestException("Payment is voided — its check status can no longer change");
      }

      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: { where: { status: { not: "VOID" as any } } } },
      });
      if (!invoice) throw new NotFoundException("Invoice not found");

      let newSubtotal = Number(invoice.subtotal);
      let newTotal = Number(invoice.total);
      if (fee > 0) {
        await tx.invoiceItem.create({
          data: {
            invoiceId,
            description: `${NSF_FEE_DESCRIPTION_PREFIX}${
              payment.paymentNumber
                ? ` ${payment.paymentNumber}`
                : payment.reference
                  ? ` ${payment.reference}`
                  : ""
            }`,
            qty: 1,
            unitPrice: fee,
            discount: 0,
            taxRate: 0,
            subtotal: fee,
          },
        });
        newSubtotal = roundMoney(newSubtotal + fee);
        newTotal = roundMoney(newTotal + fee);
      }

      const totalPaid = invoice.payments
        .filter((p) => p.id !== paymentId)
        .reduce((s, p) => s + Number(p.amount), 0);
      const newStatus = this.recomputeStatus(totalPaid, newTotal, invoice.dueDate, invoice.status);
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? invoice.paidAt : null,
          ...(fee > 0 ? { subtotal: newSubtotal, total: newTotal } : {}),
        },
      });
      // Sales agents & commissions: BOUNCED flips the payment to VOID, which
      // drops the collection ratio — sync releases less (or no) payable. The
      // DEPOSITED/CLEARED branches above change no balances, so no hook there.
      await this.commissionEngine.syncInvoiceCommissionSafe(invoiceId, tx);

      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        status: newStatus,
        total: newTotal,
      });
      return { success: true, checkStatus: "BOUNCED" as CheckStatus };
    });
  }

  // ─── Export payments as CSV ───────────────────────────────────────────────

  async exportPayments(params: {
    customerId?: string;
    method?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    sortBy?: string;
    sortDir?: string;
  }): Promise<string> {
    const { customerId, method, status, dateFrom, dateTo, search, sortBy, sortDir } = params;

    const where: any = {};
    if (customerId) where.invoice = { customerId };
    if (method) where.method = method;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.paidAt = {};
      if (dateFrom) where.paidAt.gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        where.paidAt.lte = end;
      }
    }
    if (search) {
      where.OR = [
        { paymentNumber: { contains: search, mode: "insensitive" } },
        { reference: { contains: search, mode: "insensitive" } },
        { invoice: { customer: { businessName: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const validSortFields: Record<string, any> = {
      paidAt: { paidAt: sortDir === "asc" ? "asc" : "desc" },
      settledAt: { settledAt: sortDir === "asc" ? "asc" : "desc" },
      amount: { amount: sortDir === "asc" ? "asc" : "desc" },
      createdAt: { createdAt: sortDir === "asc" ? "asc" : "desc" },
      paymentNumber: { paymentNumber: sortDir === "asc" ? "asc" : "desc" },
    };
    const orderBy = validSortFields[sortBy ?? ""] ?? { paidAt: "desc" };

    const rows = await this.prisma.forTenant().invoicePayment.findMany({
      where,
      orderBy,
      include: {
        invoice: {
          select: {
            invoiceNumber: true,
            customer: { select: { businessName: true } },
          },
        },
      },
    });

    const escape = (v: any) => {
      const s = v == null ? "" : String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const header =
      "Payment#,Date,Bank Date,Customer,Invoice#,Method,Reference,Bank Charges,Amount,Status";
    const lines = rows.map((r: any) =>
      [
        escape(r.paymentNumber ?? ""),
        escape(r.paidAt ? new Date(r.paidAt).toISOString().split("T")[0] : ""),
        escape(r.settledAt ? new Date(r.settledAt).toISOString().split("T")[0] : ""),
        escape(r.invoice?.customer?.businessName ?? ""),
        escape(r.invoice?.invoiceNumber ?? ""),
        escape(r.method ?? ""),
        escape(r.reference ?? ""),
        escape(r.bankCharges != null ? Number(r.bankCharges).toFixed(2) : ""),
        escape(Number(r.amount).toFixed(2)),
        escape(r.status ?? ""),
      ].join(","),
    );

    return [header, ...lines].join("\n");
  }

  // ─── Cron ─────────────────────────────────────────────────────────────────

  async markOverdue() {
    const now = new Date();
    await this.prisma.forTenant().invoice.updateMany({
      where: {
        status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIAL] },
        dueDate: { lt: now },
      },
      data: { status: InvoiceStatus.OVERDUE },
    });
  }

  // ─── Retroactive Price Adjustment ─────────────────────────────────────────

  async applyPriceAdjustment(
    id: string,
    dto: { items: { itemId: string; newUnitPrice: number }[]; scope: string; sinceDate?: string },
  ) {
    const invoice = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");

    // Block adjustments on fully PAID invoices — create a credit note instead
    if (
      invoice.status === InvoiceStatus.PAID ||
      invoice.status === InvoiceStatus.WRITTEN_OFF ||
      invoice.status === InvoiceStatus.VOID
    ) {
      throw new BadRequestException(
        `Cannot adjust prices on a ${invoice.status} invoice. Issue a credit note instead.`,
      );
    }

    // Build a map of itemId → newUnitPrice for quick lookup
    const priceMap = new Map(dto.items.map((i) => [i.itemId, i.newUnitPrice]));

    // Build a map of itemId → productId from this invoice's items (used for bulk scope)
    const productIdMap = new Map(invoice.items.map((li) => [li.id, li.productId]));

    // Helper: update items on a single invoice and recalculate totals
    const applyToInvoice = async (inv: typeof invoice, localPriceMap: Map<string, number>) => {
      const auditLine = `[${new Date().toLocaleDateString()} — Price adjusted by operator]`;

      for (const item of inv.items) {
        const newPrice = localPriceMap.get(item.id);
        if (newPrice == null) continue;
        // Recover the line's selling-unit multiplier (box-equivalent for boxed
        // lines, plain qty otherwise) from the existing line so re-pricing keeps
        // boxed proration without needing unitsPerBox here:
        //   beforeDiscount = subtotal + discount = oldUnitPrice * multiplier.
        const oldUnitPrice = Number(item.unitPrice);
        const oldDiscount = Number(item.discount ?? 0);
        const multiplier =
          oldUnitPrice > 0
            ? (Number(item.subtotal) + oldDiscount) / oldUnitPrice
            : Number(item.qty);
        const newSubtotal = roundMoney(newPrice * multiplier - oldDiscount);
        await this.prisma.forTenant().invoiceItem.update({
          where: { id: item.id },
          data: { unitPrice: newPrice, subtotal: newSubtotal },
        });
      }

      // Recalculate invoice totals from fresh item data
      const updatedItems = await this.prisma
        .forTenant()
        .invoiceItem.findMany({ where: { invoiceId: inv.id } });
      const subtotal = roundMoney(updatedItems.reduce((s, li) => s + Number(li.subtotal), 0));
      const regularTax = roundMoney(
        updatedItems.reduce((s, li) => s + Number(li.subtotal) * Number(li.taxRate ?? 0), 0),
      );
      // Category (regulated/excise) tax is persisted per line and is NOT part of
      // taxRate. Every other recompute in this file folds it in; omitting it here
      // silently under-bills excise and propagates the shortfall to the linked
      // order via recomputeOrderFromInvoices below. No exemption re-derivation is
      // needed: categoryTaxAmount is already zeroed at creation for exempt
      // customers, and a price adjustment never changes exemption.
      const categoryTaxTotal = roundMoney(
        updatedItems.reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0),
      );
      const taxAmount = roundMoney(regularTax + categoryTaxTotal);
      const total = roundMoney(
        subtotal - Number(inv.discount ?? 0) + Number(inv.shippingFee ?? 0) + taxAmount,
      );

      const existingInternal = (inv as any).internalNotes ?? "";
      await this.prisma.forTenant().invoice.update({
        where: { id: inv.id },
        data: {
          subtotal,
          taxAmount,
          total,
          internalNotes: existingInternal ? `${existingInternal}\n${auditLine}` : auditLine,
        },
      });
      // Sales agents & commissions: this method is pre-existingly non-atomic
      // (no surrounding tenantTransaction) — do NOT refactor that here. Pass
      // no tx; the Safe wrapper opens its own transaction, and the hourly
      // reconciliation cron heals the gap if the process dies mid-loop.
      await this.commissionEngine.syncInvoiceCommissionSafe(inv.id);
      // Backward sync: a re-priced invoice updates its linked order's totals.
      if ((inv as any).orderId) await this.recomputeOrderFromInvoices((inv as any).orderId);
    };

    if (dto.scope === "SINGLE") {
      await applyToInvoice(invoice, priceMap);
    } else {
      // ALL_CUSTOMER_SINCE: find all invoices for the same customer on or after sinceDate
      if (!dto.sinceDate) throw new BadRequestException("sinceDate is required for bulk scope");

      // Build productId → newUnitPrice map from this invoice (to apply same price to same product elsewhere)
      const productPriceMap = new Map<string, number>();
      for (const [itemId, newPrice] of priceMap.entries()) {
        const productId = productIdMap.get(itemId);
        if (productId) productPriceMap.set(productId, newPrice);
      }

      const targetInvoices = await this.prisma.forTenant().invoice.findMany({
        where: {
          customerId: invoice.customerId,
          createdAt: { gte: new Date(dto.sinceDate) },
          status: {
            notIn: [InvoiceStatus.PAID, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF],
          },
        },
        include: { items: true },
      });

      for (const inv of targetInvoices) {
        // Build itemId → newUnitPrice for items whose productId matches
        const localMap = new Map<string, number>();
        for (const item of inv.items) {
          if (item.productId && productPriceMap.has(item.productId)) {
            localMap.set(item.id, productPriceMap.get(item.productId)!);
          }
        }
        if (localMap.size > 0) {
          await applyToInvoice(inv, localMap);
        }
      }
    }

    return this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: { items: true, customer: { select: { id: true, businessName: true } } },
    });
  }
}
