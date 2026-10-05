import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { syncOrderLineCompositions } from "../orders/order-composition";
import { invoiceCompositionFields } from "./invoice-line-composition";
import { applyComposedLineEdits } from "./invoice-composed-edit";
import { FeatureConfigService } from "../billing/feature-config.service";
import * as unitAware from "../orders/unit-aware-guard";
import {
  assertInvoiceTotalsSane,
  assertNoNegativeLineSubtotal,
  storedInvoiceTotals,
} from "../common/money-invariants.util";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { recomputeInvoiceStatus } from "./invoice-status";
import { tenantTimeZone } from "../common/tenant-time-zone";
import { StorageService } from "../storage/storage.service";
import {
  deletePaymentImage,
  getPaymentImageUrl,
  uploadPaymentImage,
  type PaymentImageDeps,
} from "./payment-image";
import {
  computeLineSubtotal,
  roundMoney,
  normalizeBoxesPieces,
  remainingCapacity,
  inferredGoodsFlatRate,
} from "@routeflow/pricing";
import { computeDepositFields } from "./deposit-fields";
import { deriveInvoiceDetailFields } from "./invoice-detail-read";
import { withComponentViews } from "../orders/component-view";
import { orderLineShape, orderLineUnchanged } from "./order-backsync-lines";
import {
  buildEditedLines,
  editInvoiceTotals,
  loadEditCatalog,
  orderSyncLines,
  inPlacePatch,
  matchEditLines,
} from "./invoice-edit-plan";
import { redactUpsellForCustomer } from "../common/upsell-redaction";
import {
  CONFIRMED_PAYMENT,
  CREDIT_NOTE_METHOD,
  RECEIVED_METHOD_FILTER,
  splitConfirmed,
  sumConfirmed,
} from "./payment-predicates";
import { PAYABLE } from "./invoice-status-sets";
import { reconcileDeliveredOrdersInTx as reconcileDeliveredOrdersInTxImpl } from "./delivered-reconcile";
import { packAtSaleByProduct, priorUnitsPerBoxMap, toSaleLedgerLines } from "./pack-at-sale";
import { assertIntegerPieces, billPackOf } from "./unit-line-bill-guard";
import { clampLimit } from "../common/pagination";
import { isInternalEmail } from "../common/internal-email";
import { stampMsrpSnapshots } from "./msrp-snapshots";
import { effectiveTaxRateFromTotals } from "../common/tax-rate";
import {
  checkOrderCoverage,
  finalizeOrderRecompute,
  resolveProductMatches,
  withOrderRecomputeLock,
} from "./finalize-order-recompute";
import {
  billableQtyFromBasis,
  deliveredBasisByLine,
  deliveredQtyFromBasis,
} from "./delivered-basis-by-line";
import { assertOrderItemIdsBelongToOrder, logSkippedMatches } from "./order-item-provenance";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { buildPaymentsCsv } from "./payments-csv";
import { settledAtShipment } from "../orders/order-status-invoicing";
import { resolvePendingMirror } from "./pending-mirror";
import {
  CheckStatus,
  CreditNoteStatus,
  InvoiceStatus,
  NotificationEvent,
  Prisma,
  UserRole,
} from "@prisma/client";
import type { InvoiceKpiSummary } from "@routeflow/types";
import { computeInvoiceKpiSummary } from "./invoice-kpi-summary";
import { CHECK_TRANSITIONS } from "../common/check-transitions";
import {
  CreateInvoiceDto,
  RecordInvoicePaymentDto,
  SetCheckStatusDto,
  StandalonePaymentDto,
  UpdatePaymentDto,
  WriteOffDto,
} from "./dto/create-invoice.dto";
import { CreatePartialInvoiceDto } from "./dto/create-partial-invoice.dto";
import type { UpdateInvoiceDto } from "./dto/update-invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";
import {
  applyInvoiceSearchAndDateFilters,
  applyInvoiceStatusFilters,
  invoiceListOrderBy,
} from "./invoice-list-query";
import { UpdateShipmentDto } from "../orders/dto/update-shipment.dto";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { isTxTimeout, splitInvoiceRetry } from "./split-invoice-retry";
import { InvoicePdfService } from "./invoice-pdf.service";
import { invoiceItemQtyFields } from "./invoice-pdf-item";
import { buildInvoiceEmailAttachment, InvoiceEmailAttachment } from "./invoice-attachment";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import {
  applyBulkPriceAdjustment,
  assertAdjustedTotalsSane,
  buildPriceAdjustmentUpdates,
  commitPriceAdjustment,
  loadPriceAdjustmentReference,
  lockInvoiceForPriceAdjustment,
  preflightBulkPriceAdjustment,
} from "./price-adjustment-ledger";
import { assertNsfLinesUntaxed } from "./nsf-line-tax-guard";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import {
  assertNoUnspentSourcedCredits,
  unlinkSourcedCredits,
} from "../credit-notes/sourced-credit-guard";
import { MessagingService } from "../messaging/messaging.service";
import { formatDate, formatMoney } from "../messaging/messaging.helpers";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NSF_FEE_DESCRIPTION_PREFIX } from "../sales-agents/commission-math";
import { InvoiceItemSystemKind, isNsfLine, notNsfLineWhere } from "./nsf-line";
import { preservedNsfLines } from "./nsf-preserve";
import { partitionInvoiceLines, planResyncPairs, RESYNC_ITEM_SELECT } from "./resync-plan";
import {
  issueDateStamp,
  overdueCutoff,
  addCalendarDays,
  startOfCalendarDay,
  endOfCalendarDay,
} from "../common/calendar-date";
import { calendarFieldStamp, dueDateStamps, dueStamp } from "./invoice-due-dates";
import { lockRowsNoWait } from "../common/db-locks";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { requireRestrictionTenantId } from "../selling-restrictions/restriction-tenant";
import { flagSplitRestrictedLines } from "../selling-restrictions/restricted-lines-flag";
import {
  addedRestrictionLines,
  assertEditStillJudged,
  catalogRestrictionLines,
} from "./invoice-restriction-lines";
import { buildManualInvoiceLines, type ManualLineItem } from "./manual-invoice-lines";
import { foldCategoryTax, loadManualLineContext } from "./manual-invoice-context";
import { resolveLineUnits } from "../products/line-units";
import { assertUnitLineSplit } from "../orders/unit-line-split";
import { prepareUnitLadders, requestsUnit } from "../orders/unit-line-build";
import { standaloneAllocationTotals } from "./standalone-payment-totals";
import { calendarDayOf } from "./settled-date-filter";
import { retryOnTxConflict } from "../common/tx-retry";
import { AfterCommit, gatewayFor, withAfterCommit } from "../common/after-commit";
import {
  lockInvoiceRow,
  lockInvoicesForPayment,
  nextSentStatus,
  paymentRefusal,
  sendRefusal,
  voidRefusal,
  externalPaidOn,
  writeOffRefusal,
} from "./invoice-send-guard";
import { selectEditRevertedInvoices } from "./order-edit-revert-set";
import { assertPartialRequestShape, bumpInvoicedQtyCas } from "./partial-invoice-cas";

const TERM_DAYS: Record<string, number> = {
  "Due on Receipt": 0,
  "Net 15": 15,
  "Net 30": 30,
  "Net 45": 45,
  "Net 60": 60,
};

/** #2293: round a nullable money field; `null` (clear) and `undefined` (leave as is) pass through. */
const roundMoneyOrNull = (v: number | null | undefined) => (v == null ? v : roundMoney(v));

export { addCalendarDays } from "../common/calendar-date";

// P5-12 / post-dated check payments PR-1: `CHECK_TRANSITIONS` (legal FORWARD transitions for
// the check lifecycle) now comes from `../common/check-transitions` — an API-local mirror of the
// ONE canonical copy at `packages/types/api/checks.ts` (`@routeflow/types`), also shared with web
// (`invoices/[id]/page.tsx`) and mobile (`payments-logic.ts`), which used to each hand-maintain
// an identical local const. The API can't import `@routeflow/types` directly (see
// `no-runtime-workspace-imports.spec.ts`), so it keeps a local copy instead — pinned value-equal
// to the canonical export by `check-transitions-parity.spec.ts`. See that file's own doc for the
// V1-only rule (no `CHECK_TRANSITIONS_V2` here — a later PR owns that).

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
    private readonly numbering: NumberingService,
    private readonly sellingRestrictions: SellingRestrictionsService,
    // #2198/SA-397: flag.msrp asks the same evaluation point as the route guard.
    private readonly authority: EntitlementAuthority,
    @Optional() private readonly featureConfig?: FeatureConfigService,
  ) {}

  /** Extracted to msrp-snapshots.ts (size ratchet); stamps each line's MSRP at creation time. */
  private applyMsrpSnapshots(db: any, customerId: string, itemsData: any[]): Promise<void> {
    return stampMsrpSnapshots(this.prisma, this.authority, db, customerId, itemsData);
  }

  /**
   * Resolve the effective default invoice terms and corresponding due-days offset.
   *
   * A per-customer `defaultPaymentTerms` override ("this customer is always Net
   * 60") wins over the tenant SystemConfig default when one is set; otherwise
   * falls back to the existing tenant-only behavior. Callers that generate an
   * invoice FROM an order should pass the order's customerId so the customer's
   * override is honored.
   *
   * Also carries back the customer's `defaultDepositPercent` (or null) from the
   * SAME customer row — order-generation callers use it to auto-apply the
   * customer's "50% upfront" deposit default without a second query.
   *
   * Also resolves `effectiveDepositPercent`: the tenant-wide deposit default
   * (`invoice.depositDefaultPercent`, WP-D1) folded against the customer's own
   * override. The customer ALWAYS wins when it's explicitly set — a positive
   * value is their percent, an explicit 0 is an opt-out — and only a customer
   * with NO override (null/undefined) inherits the tenant default. Callers that
   * generate an invoice FROM an order use this (not customerDepositPercent) to
   * decide the deposit that actually applies.
   */
  async resolveDefaultTerms(customerId?: string): Promise<{
    terms: string;
    dueDays: number;
    customerDepositPercent: number | null;
    effectiveDepositPercent: number | null;
  }> {
    let customerDepositPercent: number | null = null;
    let terms: string;
    let dueDays: number;
    if (customerId) {
      const customer = await this.prisma.forTenant().customer.findFirst({
        where: { id: customerId },
        select: { defaultPaymentTerms: true, defaultDepositPercent: true },
      });
      customerDepositPercent =
        customer?.defaultDepositPercent != null ? Number(customer.defaultDepositPercent) : null;
      if (customer?.defaultPaymentTerms) {
        terms = customer.defaultPaymentTerms;
        dueDays = TERM_DAYS[terms] ?? 30;
      } else {
        const stored = await this.systemConfig.get("invoice.defaultTerms");
        terms = stored || "Net 30";
        dueDays = TERM_DAYS[terms] ?? 30;
      }
    } else {
      const stored = await this.systemConfig.get("invoice.defaultTerms");
      terms = stored || "Net 30";
      dueDays = TERM_DAYS[terms] ?? 30;
    }
    // Customer wins when SET: >0 = their percent, 0 = explicit opt-out.
    // null/undefined = inherit the tenant default (if any).
    const tenantDepositRaw = await this.systemConfig.get("invoice.depositDefaultPercent");
    const tenantDepositPercent = tenantDepositRaw ? Number(tenantDepositRaw) : null;
    const effectiveDepositPercent =
      customerDepositPercent != null
        ? customerDepositPercent > 0
          ? customerDepositPercent
          : null
        : tenantDepositPercent && tenantDepositPercent > 0
          ? tenantDepositPercent
          : null;
    return { terms, dueDays, customerDepositPercent, effectiveDepositPercent };
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

  /**
   * The real tenant-local midnight instant that BEGINS the calendar day
   * `dateStr` (a `YYYY-MM-DD` value, e.g. a `dateFrom` query param) encodes —
   * the paidAt/settledAt-window counterpart to `endOfCalendarDay` (B89,
   * L-047: paidAt is a real instant, so its day bounds must be evaluated in
   * the TENANT's own timezone, never the host clock's). Composed from the
   * shared `endOfCalendarDay` helper rather than re-deriving the UTC-offset
   * math a second time (L-047/L-072): the instant 1ms after the PREVIOUS
   * calendar day's tenant-local end is exactly this day's tenant-local start.
   */
  private tenantCalendarDayStart(dateStr: string, timeZone: string | null): Date {
    const prevDay = new Date(`${calendarDayOf(dateStr, "dateFrom")}T00:00:00.000Z`);
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    return new Date(endOfCalendarDay(prevDay, timeZone).getTime() + 1);
  }

  /**
   * The real tenant-local instant that ENDS the calendar day `dateStr` encodes
   * — the `dateTo` counterpart to `tenantCalendarDayStart`. The param is
   * normalised through `calendarDayOf` FIRST so an unparsable value is
   * rejected with a 400 instead of reaching Prisma as an `Invalid Date` bound,
   * and a full ISO datetime resolves to the same window as its date-only form.
   */
  private tenantCalendarDayEnd(dateStr: string, timeZone: string | null): Date {
    return endOfCalendarDay(
      new Date(`${calendarDayOf(dateStr, "dateTo")}T00:00:00.000Z`),
      timeZone,
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async nextInvoiceNumber(): Promise<string> {
    return this.generateInvoiceNumber();
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
  /** SA-135: an internal caller's line may carry `packSnapshot` (ManualLineItem); the HTTP DTO never can. */
  async create(dto: Omit<CreateInvoiceDto, "items"> & { items: ManualLineItem[] }) {
    const issueDateInput = dto.issueDate ? issueDateStamp(dto.issueDate) : null; // #2197: 400 first
    const due = dueDateStamps(dto); // #2256: the due dates too, refused before any read or write
    assertNsfLinesUntaxed(dto.items); // #2656: an NSF-described line is never taxed (400)
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: dto.customerId } });
    // REG-B131: a removed (soft-deleted) customer cannot be invoiced; same 404 as a missing one. Checked
    // on the row just read (L-081), so restoreCustomer() re-enables it with no other write.
    if (!customer || customer.deletedAt) throw new NotFoundException("Customer not found");
    // F-05 (#2093): a manual invoice SELLS its lines — a banned product refuses (409) before anything is read.
    await this.sellingRestrictions.assertLinesSellable({
      tenantId: requireRestrictionTenantId(this.prisma.getTenantId()),
      customerId: dto.customerId,
      lines: dto.items.flatMap((it) => (it.productId ? [{ productId: it.productId }] : [])),
      channel: "STAFF",
    });

    // Products (box size + regulated snapshot), the unit ladders and the regulated tax config of every
    // line: see manual-invoice-context.ts (B659: shared with EstimatesService.convertToInvoice).
    const { productMap, categoryMap, unitsByProduct } = await loadManualLineContext(dto.items, {
      prisma: this.prisma,
      entitlements: this.entitlements,
    });
    const resolved = dto.items.map((it) =>
      resolveLineUnits(
        productMap.get(it.productId ?? "") ?? {},
        unitsByProduct.get(it.productId ?? "") ?? [],
        it,
      ),
    );

    // Manual-invoice line builder: see manual-invoice-lines.ts (verbatim move; units_v1 4c-1 prefactor).
    const { itemsData, subtotal: linesSubtotal } = buildManualInvoiceLines(dto.items, {
      productMap,
      categoryMap,
      tenantId: this.prisma.getTenantId(),
      clampFreeUnits: (free, boxes, qty) => this.clampLineFreeUnits(free, boxes, qty),
      resolved,
    });
    let subtotal = linesSubtotal;
    subtotal = roundMoney(subtotal);
    // A regulated line makes this a filable sale — the SALE ledger rows are written below.
    const hasRegulated = itemsData.some((it: any) => it.trackedCategoryId != null);
    await this.applyMsrpSnapshots(this.prisma.forTenant(), dto.customerId, itemsData);

    // Validate no line item has a negative subtotal (discount > line total) — B659: extracted to
    // money-invariants.util.ts, shared with EstimatesService.convertToInvoice's pre-flight.
    assertNoNegativeLineSubtotal(itemsData);

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

    // Validate invoice-level discount doesn't exceed subtotal and total is non-negative — B1030:
    // shared with update(), which runs the same two checks on both of its paths.
    assertInvoiceTotalsSane({ discount: invDiscount, subtotal, total });

    const tenantDefaults = await this.resolveTenantInvoiceDefaults();
    // B100/F16b: reserved BEFORE the transaction below opens (fix-round-2.md D1).
    // reserveNext runs its own short transaction and commits it, so this one never
    // holds the NumberingSequence row lock — the lock that inverted lock order against
    // the driver stop-completion tx and serialized every concurrent mint behind a whole
    // invoice body. It must not be called from INSIDE the transaction either: that
    // needs a second pooled connection while this one is held, which starves the pool
    // under concurrent mints (proved by REG-B100-C, 7/10 rejected). The trade is
    // explicit and accepted: a failure below leaves a gap in the series.
    const invoiceNumber = await this.nextInvoiceNumber();
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
            dueDate: due.dueDate,
            // #2197: the literal calendar day the client named, never a raw instant.
            issueDate: issueDateInput ?? startOfCalendarDay(new Date(), tenantDefaults.timezone),
            notes: dto.notes ?? tenantDefaults.notes,
            terms: dto.terms ?? tenantDefaults.terms,
            paymentTermsLabel: dto.paymentTermsLabel ?? null,
            depositPercent: dto.depositPercent ?? null,
            depositDueDate: due.depositDueDate,
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
        if (hasRegulated) await this.writeCreatedInvoiceLedger(tx, created);
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
    overrides?: {
      dueDate?: string;
      terms?: string;
      paymentTermsLabel?: string;
      /** Explicit per-invoice deposit — wins over the customer's defaultDepositPercent. */
      depositPercent?: number;
      depositDueDate?: string;
    },
  ) {
    const db = txClient ?? this.prisma;

    // Fetch order with non-cancelled line items
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            components: { orderBy: { position: "asc" } },
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

    // B760/SA-113(ii): remaining = min(qty, delivered basis) - invoicedQty via the ONE shared
    // evidence-keyed basis; no evidence keeps qty (today's qty - invoicedQty). Nothing left to
    // bill (fully invoiced) ⇒ return the existing invoice(s).
    const deliveredBasis = await deliveredBasisByLine(db, orderId);
    const remainingItems = order.lineItems
      .map((li: any) => ({
        li,
        remainingQty: billableQtyFromBasis(li, deliveredBasis) - Number(li.invoicedQty ?? 0),
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
    // Also resolves effectiveDepositPercent — the customer's own deposit default when
    // set, else the tenant-wide deposit default (WP-D1) — off the same call.
    const {
      terms: defaultTerms,
      dueDays,
      effectiveDepositPercent,
    } = await this.resolveDefaultTerms(order.customerId);
    // Customer-facing invoice Notes and T&C from tenant settings
    const tenantDefaults = await this.resolveTenantInvoiceDefaults();
    // A backdated order bills on its business date, and the payment term runs from
    // that date — not from when the invoice happened to be generated.
    const issueDate = order.orderDate ?? startOfCalendarDay(new Date(), tenantDefaults.timezone);
    let dueDate: Date;
    if (overrides?.dueDate) {
      dueDate = calendarFieldStamp(overrides.dueDate, "dueDate"); // #2256
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
    // Deposit default ("X% upfront, remainder on terms"): applies ONLY when this
    // invoice doesn't already carry an explicit deposit — an explicit caller-supplied
    // deposit (overrides.depositPercent, e.g. a future "New sale" deposit field)
    // always wins and is never clobbered. Otherwise falls back to
    // effectiveDepositPercent (WP-D1: customer override when set, else the
    // tenant-wide default) — already null-or-positive, so no extra >0 guard is
    // needed here. The deposit is due immediately (depositDueDate = issueDate); the
    // remainder still rides the terms-label dueDate resolved above.
    // computeDepositFields does all the read-time math — nothing derived is stored
    // here. No effective deposit leaves these keys OUT of extraInvoiceData entirely,
    // so the create payload is byte-identical to before this change.
    const depositFields: Record<string, any> =
      overrides?.depositPercent != null
        ? {
            depositPercent: overrides.depositPercent,
            depositDueDate: overrides.depositDueDate
              ? calendarFieldStamp(overrides.depositDueDate, "depositDueDate")
              : issueDate,
          }
        : effectiveDepositPercent != null
          ? { depositPercent: effectiveDepositPercent, depositDueDate: issueDate }
          : {};

    const extraInvoiceData: Record<string, any> = {
      dueDate,
      terms: overrideTerms ?? tenantDefaults.terms ?? defaultTerms,
      paymentTermsLabel,
      issueDate,
      notes: tenantDefaults.notes ?? (order.orderNumber ? `Order #${order.orderNumber}` : null),
      ...depositFields,
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
    const created = await this.createSplitInvoices({
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

    // Issuance at order placement (WP-D1): when the tenant collects a deposit at
    // order placement, the mirror invoice(s) just created above are issued (SENT)
    // right here instead of staying a DRAFT — so the deposit can be recorded right
    // away — while the ORDER stays fully editable until delivery
    // (reconcileOrderDraftInvoice is widened to keep a SENT deposit mirror in
    // lockstep with those edits). Gated on ALL of: this invoice actually carries a
    // deposit (depositFields is only non-empty when one applies — a plain
    // operator-issued invoice is NEVER auto-sent by this), the order hasn't already
    // been delivered (the van/immediate-sale path issues via its own explicit
    // send() in orders.service — this is the deliver-later path only), and the
    // tenant has the collect-at-order flag on. Every row in `created` is a FRESH
    // DRAFT straight out of createSplitInvoices above, so this only ever runs on
    // the create path — a reconcile/rebuild updates existing rows in place and
    // never reaches this code. `send()` (not sendEmail()) flips DRAFT → SENT
    // without emailing anyone — the same "issue without notifying" precedent the
    // van-sale flow already relies on.
    //
    // S6 — `!txClient`: this method also runs INSIDE a caller's transaction (the
    // `txClient` param, e.g. recordDeliveryPaymentInTx's delivery tx). `send()` runs
    // on `this.prisma.forTenant()` and opens its OWN transaction — a SEPARATE
    // connection that cannot see the caller's uncommitted rows, so sending the
    // invoice we just created inside that tx would either 404 (findOneOrThrow) or
    // block until the outer tx times out. Issuance is therefore create-path-only
    // (no caller tx); every in-transaction caller is a delivery-time path, where the
    // order is DELIVERED and the gate below excludes it anyway.
    //
    // S1 — `created.length === 1`: a regulated SEPARATE_INVOICE order splits into
    // base + -R# siblings, and every sibling-aware rebuild path
    // (reconcileSplitOrderDrafts / reconcileOrderDeliveredInvoices) only ever
    // rebuilds open DRAFTs. Issuing the siblings here would freeze them against
    // later order edits. DELIBERATE LIMITATION: a split order keeps DRAFT mirrors
    // and collects its deposit the normal way (after delivery); only a
    // single-invoice order gets deposit-at-placement issuance.
    if (
      !txClient &&
      created.length === 1 &&
      depositFields.depositPercent != null &&
      order.status !== "DELIVERED" &&
      (await this.systemConfig.get("invoice.depositCollectAtOrder")) === "true"
    ) {
      const issued: any[] = [];
      for (const inv of created) {
        // assertOrderInvoiceUnlocked normally refuses to send an order-linked DRAFT
        // before its order is delivered (the pending-mirror lock) — allowPreDelivery
        // is the narrow, send()-only escape hatch for exactly this feature: a
        // deposit mirror is MEANT to be sendable pre-delivery. It does not relax
        // update()'s separate "only DRAFT invoices can be edited" rule, so hand-editing
        // stays blocked — the order remains the only edit surface, as designed.
        issued.push(await this.send(inv.id, { allowPreDelivery: true }));
      }
      return issued;
    }

    return created;
  }

  /** RF-4: see foldCategoryTax in manual-invoice-context.ts (shared with estimate conversion, B659). */
  private foldCategoryTax(
    itemsData: Array<{ categoryTaxAmount?: number }>,
    isTaxExempt: boolean,
  ): number {
    return foldCategoryTax(itemsData, isTaxExempt);
  }

  /**
   * B294: the REGULAR (non-category) tax rate to stamp on order-derived invoice
   * lines. The order never carries a per-line/category rate for regular tax — it
   * applies one tenant-wide flat rate (orders.service.getTaxRate(), sourced from
   * `settings.taxRate`) to its whole subtotal (`order.tax = subtotal * rate`), so
   * `order.tax / order.subtotal` recovers that same rate exactly (0 for an
   * exempt customer, mirroring foldCategoryTax's contract). Every order-derived
   * InvoiceItem.taxRate must carry this value: `applyPriceAdjustment` recomputes
   * an invoice's regular tax as `Σ li.subtotal * li.taxRate`, and a line built
   * with `taxRate: 0` silently zeroes the tax on the very next adjustment even
   * though the invoice was issued with the correct total.
   */
  private orderDerivedTaxRate(
    order: { tax?: unknown; subtotal?: unknown },
    isTaxExempt: boolean,
  ): number {
    return effectiveTaxRateFromTotals(order?.tax, order?.subtotal, isTaxExempt);
  }

  /** Stamps `orderDerivedTaxRate` onto every built line in place (mirrors foldCategoryTax's shape). */
  private applyOrderDerivedTaxRate(
    itemsData: Array<{ taxRate?: number }>,
    order: { tax?: unknown; subtotal?: unknown },
    isTaxExempt: boolean,
  ): void {
    const rate = this.orderDerivedTaxRate(order, isTaxExempt);
    for (const it of itemsData) it.taxRate = rate;
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
    opts?: { priorBilledQty?: number; priorPack?: number | null },
  ) {
    const orderQty = Number(li.qty) || 0;
    const storedSubtotal = li.subtotal != null ? Number(li.subtotal) : null;
    const unitPrice = Number(li.unitPrice);
    const unitsPerBox = billPackOf(li, opts?.priorPack, li.product?.unitsPerBox); // a unit line's OWN pack wins (SA-178)
    const isBoxSplit = li.boxes != null; // stored WITH a box/piece split
    assertIntegerPieces(li, billQty, unitsPerBox); // B652: no fractional pieces on a boxed line

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
      // F04/REG-B50 oracle-cap check (this lane): CAP each point at basisQty.
      // With freeUnitSize > 1 the floored free-unit allocation (freeUnitsThrough)
      // lands only near 100% delivered, so an uncapped billedThrough can exceed
      // basisQty for a cumQty still short of orderQty — e.g. 2 free boxes of 8
      // (unitsPerBox 6): at cumQty = 47 of 48, freeUnitsThrough floors to 1 (not
      // yet 2), so billedThrough = 47 − 6 = 41 > basisQty 36, and an uncapped
      // partial would bill 41/36 of the line — MORE than its whole agreed
      // subtotal. `prorateLineSubtotal` in the web/mobile pricing.ts mirrors
      // already carry this cap (F04); the reference oracle here did not.
      // Unreachable at freeUnitSize 1 (billedThrough ≤ cumQty ≤ orderQty =
      // basisQty then); a full bill (prior 0, billQty orderQty) still copies the
      // stored subtotal back verbatim since billedThrough(orderQty) === basisQty.
      subtotal = roundMoney(
        roundMoney(
          (storedSubtotal * Math.min(billedThrough(prior + billQty), basisQty)) / basisQty,
        ) - roundMoney((storedSubtotal * Math.min(billedThrough(prior), basisQty)) / basisQty),
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

    // #2230: the fields name the line and its id in the 409 / the Sentry report; the call is unchanged.
    const named = { id: li.id, orderItemId: li.id, description: li.product?.name ?? li.name };
    assertUnitLineSplit(
      { ...split, unitLabel: li.unitLabel, unitsPerBox, productId: li.productId, ...named },
      "buildInvoiceItemData",
    );
    return {
      // Catalog lines use the product name; unlisted lines carry a free-text `name`.
      description: li.product?.name ?? li.name ?? `Product`,
      productId: li.productId,
      // Provenance back to the source order line (null for freeform lines).
      orderItemId: li.id ?? null,
      unitLabel: li.unitLabel ?? null, // units_v1: the unit travels with the line
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
      // B294: placeholder — this builder has no order-level context (isTaxExempt,
      // order.tax/order.subtotal), so every caller MUST overwrite this via
      // `applyOrderDerivedTaxRate(itemsData, order, isTaxExempt)` right after
      // calling buildInvoiceItemData. Leaving it at 0 here (as before B294) let
      // applyPriceAdjustment's `Σ li.subtotal * li.taxRate` recompute silently
      // zero the regular tax on any order-derived invoice.
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
      categoryTaxType: li.categoryTaxType ?? null, // B297: COPY verbatim, never a live fallback.
      categoryTaxRate: li.categoryTaxRate != null ? Number(li.categoryTaxRate) : null,
      categoryPriceIncludesTax: li.categoryPriceIncludesTax ?? null,
      ...(tenantId ? { tenantId } : {}),
      // #2717 M3: FIXED provenance + frozen component rows for THIS bill; {} on a plain line.
      ...invoiceCompositionFields(li, billQty, prior, subtotal, tenantId),
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

    // F-05 #2093: flag (never block) + ONE audit row outside any tx; children inherit the flags.
    const flagged = await flagSplitRestrictedLines(
      this.sellingRestrictions,
      this.prisma,
      this.logger,
      {
        ...{ tenantId, order, remainingItems },
      },
    );
    const orderSubtotal = Number(order.subtotal) || 1;
    const orderTax = Number(order.tax) || 0;

    const groupData = groups.map((g) => {
      const pids = new Set(g.items.map(({ li }: any) => li.productId));
      const itemsData = g.items.map(({ li, remainingQty }: any) =>
        // B760: remainingQty = min(qty, delivered basis) − invoicedQty, so prior + bill
        // reaches the billable qty; for an undelivered/fully delivered line that is the full
        // line and the stored subtotal is copied exactly (telescoping rounding in
        // buildInvoiceItemData).
        this.buildInvoiceItemData(li, remainingQty, tenantId, {
          priorBilledQty: Number(li.invoicedQty ?? 0),
        }),
      );
      // B294: stamp the order's effective regular-tax rate onto every line so a
      // later applyPriceAdjustment recompute (Σ li.subtotal * li.taxRate) reproduces
      // this group's regular tax instead of the previous hardcoded 0.
      this.applyOrderDerivedTaxRate(itemsData, order, isTaxExempt);
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
        discount: 0,
        taxAmount: 0,
        shippingFee: 0,
        total: 0,
        restrictedLines: flagged.filter((f) => pids.has(f.productId)),
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
    // Order-level discount: allocate proportionally by subtotal — SAME shape as
    // the regular-tax allocator above (never invent a new scheme) — so a fully
    // discounted order zeroes its invoice(s) and a split order's sibling
    // discounts sum to the order's discountAmount exactly. Largest-subtotal
    // group absorbs the rounding remainder, same recipient rule as the tax
    // remainder. A zero/null discountAmount leaves every group at 0, so the
    // create payload stays byte-identical to before this allocator existed.
    const orderDiscount = roundMoney(Number((order as any).discountAmount ?? 0));
    if (orderDiscount > 0 && groupData.length > 0) {
      // The remainder is measured against the discount owed on the portion being
      // BILLED (totalSubtotal / orderSubtotal), exactly like totalRegularTax above —
      // never against the full order discount. A second-pass generation bills only
      // `qty − invoicedQty`, so an unscaled target would force the entire order
      // discount onto that invoice (double-counted across siblings, and a total
      // that can go negative).
      const totalDiscount = roundMoney(orderDiscount * (totalSubtotal / orderSubtotal));
      let allocatedDiscount = 0;
      groupData.forEach((gd) => {
        gd.discount = roundMoney(orderDiscount * (gd.subtotal / orderSubtotal));
        allocatedDiscount = roundMoney(allocatedDiscount + gd.discount);
      });
      const discountRemainder = roundMoney(totalDiscount - allocatedDiscount);
      if (discountRemainder !== 0) {
        let maxDiscountIdx = 0;
        for (let i = 1; i < groupData.length; i++)
          if (groupData[i].subtotal > groupData[maxDiscountIdx].subtotal) maxDiscountIdx = i;
        groupData[maxDiscountIdx].discount = roundMoney(
          groupData[maxDiscountIdx].discount + discountRemainder,
        );
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
      // subtotal + taxes − discount, same composition as the single-invoice
      // and reconcileOrderDraftInvoice totals.
      gd.total = roundMoney(gd.subtotal + gd.taxAmount + gd.shippingFee - gd.discount);
    });

    const multi = groupData.length > 1;
    const invoiceGroupId = multi ? randomUUID() : null;

    // Create every sibling invoice + its ledger rows + the invoicedQty bumps
    // ATOMICALLY. A mid-batch failure (e.g. a ledger write on invoice 2) must not
    // leave invoice 1 committed while invoicedQty stays un-bumped — a retry would
    // then double-invoice. When a caller already passed a tx (txClient) we run
    // inline (already inside their transaction); otherwise we open one.
    // B100/F16b: ONE base number for the whole group. WHERE it is reserved depends on
    // whether a caller already handed us their transaction (fix-round-2b.md D7):
    //  - office paths (`db === this.prisma`, incl. the fire-and-forget one): reserved
    //    HERE, before `tenantTransaction` opens below, in reserveNext's own short
    //    transaction — so this file's transaction never holds the NumberingSequence
    //    row lock and never needs a second pooled connection while holding one
    //    (fix-round-2.md D1). A failure below leaves a gap in the series.
    //  - delivery path (`db` IS the caller's tx — routes stop completion →
    //    recordDeliveryPaymentInTx → createInvoiceFromOrder(orderId, tx)): reserved
    //    INSIDE runCreation, on that same client. Hoisting a standalone reservation
    //    there would open a second transaction while the routes tx holds OrderItem
    //    locks (pool starvation, REG-B100-C); reserving on `db` instead opens nothing
    //    and merely holds the counter row until the routes tx commits — no cycle,
    //    because the office paths above hold no other lock while holding the counter.
    // tenantId is passed explicitly: the fire-and-forget path
    // (createInvoiceFromOrderWithTenant) has no request-context tenant.
    const callerTx = db === this.prisma ? null : db;
    const hoistedBaseNumber = callerTx
      ? null
      : await this.generateInvoiceNumber(tenantId ?? undefined);
    const runCreation = async (tx: any): Promise<any[]> => {
      // Right before the first insert — never above the caller's transaction.
      const baseNumber =
        hoistedBaseNumber ?? (await this.generateInvoiceNumber(tenantId ?? undefined, tx));
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
            discount: gd.discount,
            shippingFee: gd.shippingFee,
            total: gd.total,
            ...(invoiceGroupId ? { invoiceGroupId } : {}),
            ...extraInvoiceData,
            items: { create: gd.itemsData },
            ...(tenantId ? { tenantId } : {}),
          },
          include,
        });
        if (!inv) throw splitInvoiceRetry(); // #2662: stop before anything reads or flags it
        (inv as any).restrictedLines = gd.restrictedLines; // F-05 #2093: children inherit the flag
        out.push(inv);
        // W5: write the regulated-sales ledger from this invoice's regulated lines
        // (built off the created items, so invoiceItemId is real). orderItemId
        // provenance now flows through from the invoice item's stored order-line link.
        const packMap = await packAtSaleByProduct(tx, inv.items ?? []);
        await this.ledger.writeSaleEntries({
          tenantId,
          orderId: order.id,
          invoiceId: inv.id,
          soldAt: inv.issueDate ?? new Date(),
          lines: toSaleLedgerLines(inv.items ?? [], packMap),
          db: tx,
        });
      }
      // Bump invoicedQty once per order item (each belongs to exactly one group). #2612 / SA-523:
      // a CAS on the values read, so a concurrent split or partial is a 409, never an over-bill.
      await bumpInvoicedQtyCas(
        tx,
        remainingItems.map(({ li, remainingQty }) => ({ orderItemId: li.id, qty: remainingQty })),
        new Map(remainingItems.map(({ li }) => [li.id, li])),
      );
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
      if (isTxTimeout(err)) throw splitInvoiceRetry(); // #2662: rolled back — a retryable 503
      throw err;
    }
  }

  /**
   * B306: reverse every `RUN:<runId>:STOP:<stopId>`-tagged AdvancePayment for a
   * stop, INSIDE the caller's own transaction. Extracted from voidPayment's
   * reversal loop so reopenStop (routes.service.ts) can reverse a
   * zero-payable-invoice completion's advance too — that path books the WHOLE
   * at-door amount as an AdvancePayment with no InvoicePayment row at all, so
   * voidPayment (which reverses only when a confirmed InvoicePayment is
   * voided) never runs for it. Throws BadRequestException (message matches
   * /advance.*applied/i) if any matching advance was already applied
   * elsewhere (balance != amount) — same guard voidPayment always had.
   * Returns the number of advances reversed.
   */
  async reverseRunAdvancesInTx(
    tx: any,
    args: { runId: string | null | undefined; stopId: string; reason: string },
  ): Promise<number> {
    const { runId, stopId, reason } = args;
    // An order with a null routeRunId must not build a `RUN:null:…` reference
    // and query for it.
    if (!runId) return 0;

    const advances = await tx.advancePayment.findMany({
      where: { reference: `RUN:${runId}:STOP:${stopId}` },
    });
    for (const a of advances) {
      if (Number(a.balance) !== Number(a.amount)) {
        throw new BadRequestException(
          `The at-door over-collection advance ${a.id} has already been applied — release its applications before voiding this payment`,
        );
      }
      await tx.advancePayment.update({
        where: { id: a.id },
        data: {
          balance: 0,
          reference: `${a.reference}:REVERSED`,
          notes: `${a.notes ?? ""}\nREVERSED ${new Date().toISOString()}: ${reason}`,
        },
      });
    }
    return advances.length;
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
   *  - basis "delivered" → bill only the delivered quantity per line, from the
   *    evidence-keyed basis (SA-113a, delivered-basis-by-line.ts deliveredQtyFromBasis:
   *    a line's own rows win; a line with none falls back to the legacy
   *    OrderItem.deliveredQty column, SA-345a) — so it's idempotent across batches and
   *    excludes refused/zero lines.
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
   *
   * WP-D1 widening: a plain pending mirror is always an open DRAFT, but a
   * deposit-collect-at-order mirror is issued (SENT) at placement — it has no open
   * draft to find, yet the ORDER is still its edit surface (update() refuses to
   * hand-edit a non-DRAFT invoice), so an order edit needs this reconcile just the
   * same. When there's no open draft, ALSO reconcile an order-linked invoice that is
   * the order's ONLY non-void invoice, carries a deposit (`depositPercent != null` —
   * a plain operator-issued SENT invoice is NEVER touched by this), is in a status a
   * deposit mirror can realistically be in (SENT/VIEWED/PARTIAL/OVERDUE), and whose
   * order hasn't reached DELIVERED/CANCELLED (post-delivery edits are
   * resyncOrderInvoicesForEdit's job instead). Requiring it to be the order's sole
   * invoice keeps this OUT of split/partial territory — never fold every order line
   * onto just one of several sibling/partial invoices.
   */
  async reconcileOrderDraftInvoice(
    orderId: string,
    opts: { basis: "order" | "delivered"; tx?: any; after?: AfterCommit },
  ) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    const db = opts.tx ?? this.prisma.forTenant();
    const split = await this.reconcileSplitOrderDrafts(orderId, opts.basis, db);
    if (split) return split;

    let draft = await this.findOpenOrderDraft(orderId, db);
    let isDepositMirror = false;
    if (!draft) {
      const orderGate = await db.order.findFirst({
        where: { id: orderId },
        select: { status: true },
      });
      if (orderGate && orderGate.status !== "DELIVERED" && orderGate.status !== "CANCELLED") {
        const nonVoid = await db.invoice.findMany({
          where: { orderId, status: { not: InvoiceStatus.VOID } },
          include: { payments: true },
        });
        const DEPOSIT_MIRROR_STATUSES: InvoiceStatus[] = [
          InvoiceStatus.SENT,
          InvoiceStatus.VIEWED,
          InvoiceStatus.PARTIAL,
          InvoiceStatus.OVERDUE,
        ];
        if (
          nonVoid.length === 1 &&
          nonVoid[0].deliveryBatchId == null &&
          nonVoid[0].depositPercent != null &&
          DEPOSIT_MIRROR_STATUSES.includes(nonVoid[0].status)
        ) {
          draft = nonVoid[0];
          isDepositMirror = true;
        }
      }
    }
    if (!draft) return null;
    const priorItems = await db.invoiceItem.findMany({
      where: { invoiceId: draft.id },
      select: { orderItemId: true, unitsPerBox: true },
    });
    const priorPackByLine = priorUnitsPerBoxMap(priorItems);
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            components: { orderBy: { position: "asc" } },
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
    // SA-113a/B785: "delivered" bills the evidence-keyed basis (DeliveryMutation rows); a line
    // with no row of its own reads the legacy column (SA-345a, deliveredQtyFromBasis's doc).
    const evidenceBasis =
      opts.basis === "delivered" ? await deliveredBasisByLine(db, orderId) : null;
    const billable = order.lineItems
      .map((li: any) => ({
        li,
        billQty: evidenceBasis ? deliveredQtyFromBasis(li, evidenceBasis) : Number(li.qty),
      }))
      .filter((x: any) => x.billQty > 0.001);

    const itemsData = billable.map(({ li, billQty }: any) =>
      this.buildInvoiceItemData(li, billQty, tenantId, { priorPack: priorPackByLine.get(li.id) }),
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
    // B294: stamp the order's effective regular-tax rate onto every line so a
    // later applyPriceAdjustment recompute reproduces `regularTax` instead of 0.
    this.applyOrderDerivedTaxRate(itemsData, order, isTaxExempt);
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
    const nsf = await preservedNsfLines(db, draft.id); // #2242: NSF fee lines survive, untaxed
    const invSubtotal = roundMoney(subtotal + nsf.feeTotal);
    const total = roundMoney(invSubtotal - Number(draft.discount ?? 0) + draftFee + taxAmount);

    // WP-D1: a plain pending-mirror DRAFT keeps forcing DRAFT (byte-identical to
    // before). A deposit mirror already ISSUED (SENT/VIEWED/PARTIAL/OVERDUE) instead
    // re-runs the existing status recompute against its UNTOUCHED payments and the
    // NEW total — so an edit that shrinks the order can correctly land PARTIAL or
    // PAID. If the edit drops the total below what's already been paid,
    // recomputeStatus lands PAID and the balanceDue math (findAll/findOne) floors at
    // 0 — the overpayment itself is surfaced by the existing credit-note workflow,
    // not by this reconcile. depositDueDate/dueDate are never part of this update —
    // they anchor to placement/terms, not to edits, so they're preserved verbatim.
    // F03/R1: CONFIRMED (PAID) payments only.
    const nextStatus = isDepositMirror
      ? recomputeInvoiceStatus(
          roundMoney(sumConfirmed((draft as any).payments)),
          total,
          (draft as any).dueDate ?? null,
          draft.status,
          tz,
        )
      : InvoiceStatus.DRAFT;

    await db.invoiceItem.deleteMany({ where: { invoiceId: draft.id, id: { notIn: nsf.keepIds } } });
    const updated = await db.invoice.update({
      where: { id: draft.id },
      data: {
        subtotal: invSubtotal,
        taxAmount,
        shippingFee: draftFee,
        total,
        status: nextStatus,
        pdfUrl: null,
        items: { create: itemsData },
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: true,
      },
    });

    // S2: an ISSUED deposit mirror just had its MONEY rewritten, so it must re-sync
    // commission and tell the UI — exactly what rebuildSiblingDrafts does for a
    // preserveStatus rebuild (`nextStatus !== DRAFT` → syncInvoiceCommissionSafe).
    // Without this the agent's accrual keeps pointing at the pre-edit total. A plain
    // pending-mirror DRAFT targets zero commission and emits nothing, exactly as
    // before — this whole block is deposit-mirror-only.
    if (isDepositMirror && nextStatus !== InvoiceStatus.DRAFT) {
      await this.commissionEngine.syncInvoiceCommissionSafe(draft.id, db);
      const gateway = gatewayFor(opts.tx, opts.after, this.gateway, "reconcileOrderDraftInvoice");
      gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId: updated.id,
        invoiceNumber: updated.invoiceNumber,
        customerId: updated.customerId,
        status: nextStatus,
        total,
      });
    }

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
   * refused line (delivered 0) bills 0.
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
        items: { select: { orderItemId: true, unitsPerBox: true } },
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
            components: { orderBy: { position: "asc" } },
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
   * B2 / WP-D1 — the delivered-basis rebuild for a deposit mirror that was ISSUED at
   * order placement. Every other delivered-basis path keys off an open DRAFT
   * (findOpenOrderDraft / reconcileOrderDeliveredInvoices), and a deposit mirror has
   * none: it is SENT from the moment the order was placed. Without this, a short or
   * refused delivery left the mirror billing the FULL pre-delivery order — the
   * customer is charged for goods they never received.
   *
   * Fence (mirrors reconcileOrderDraftInvoice's widened branch): the order's SOLE
   * non-void invoice, no deliveryBatchId, `depositPercent != null` (a plain
   * operator-issued invoice is never touched), and a status a live deposit mirror can
   * be in. PAID is included on purpose — a fully-prepaid order that is short-delivered
   * must still be restated to what was delivered; the overpayment is then surfaced by
   * the existing credit-note workflow, exactly as the widened reconcile documents.
   * DRAFT can't reach here (findOpenOrderDraft would have caught it) and WRITTEN_OFF /
   * VOID stay terminal.
   *
   * Being the order's only invoice makes the (invoice → all its order lines) partition
   * trivially clean, so this reuses `rebuildSiblingDrafts` with `preserveStatus: true`
   * — the SAME mechanism resyncOrderInvoicesForEdit uses for an already-issued
   * invoice: payments are untouched, status/balance recompute from them against the
   * new delivered total, the regulated ledger re-syncs, and commission re-syncs.
   * Returns null (no-op) whenever the fence doesn't hold.
   */
  private async rebuildIssuedDepositMirrorOnDelivery(
    orderId: string,
    db: any,
  ): Promise<any[] | null> {
    const nonVoid = await db.invoice.findMany({
      where: { orderId, status: { not: InvoiceStatus.VOID } },
      select: {
        id: true,
        status: true,
        deliveryBatchId: true,
        depositPercent: true,
        discount: true,
        shippingFee: true,
        dueDate: true,
        items: { select: { orderItemId: true, unitsPerBox: true } },
        payments: { select: { amount: true, status: true } },
      },
    });
    if (nonVoid.length !== 1) return null;
    const mirror = nonVoid[0];
    const REBUILDABLE: InvoiceStatus[] = [
      InvoiceStatus.SENT,
      InvoiceStatus.VIEWED,
      InvoiceStatus.PARTIAL,
      InvoiceStatus.OVERDUE,
      InvoiceStatus.PAID,
    ];
    if (
      mirror.deliveryBatchId != null ||
      mirror.depositPercent == null ||
      !REBUILDABLE.includes(mirror.status)
    ) {
      return null;
    }

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            components: { orderBy: { position: "asc" } },
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
    // Keyed on the BILLING MOMENT: an order settled at SHIPMENT (and really shipped) is not restated at DELIVERED.
    if (await settledAtShipment(this.featureConfig, this.prisma.getTenantId(), order)) return null;

    return this.rebuildSiblingDrafts(
      order,
      [{ draft: mirror, lines: order.lineItems }],
      "delivered",
      db,
      { preserveStatus: true },
    );
  }

  /** SALE ledger rows for a just-created manual invoice; create() and duplicate() share this one path. */
  private async writeCreatedInvoiceLedger(tx: any, created: any): Promise<void> {
    const packMap = await packAtSaleByProduct(tx, created.items ?? []);
    await this.ledger.writeSaleEntries({
      tenantId: this.prisma.getTenantId(),
      orderId: null,
      invoiceId: created.id,
      soldAt: created.issueDate ?? new Date(),
      lines: toSaleLedgerLines(created.items ?? [], packMap),
      db: tx,
    });
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
    const packMap = await packAtSaleByProduct(db, items ?? []);
    await this.ledger.writeSaleEntries({
      tenantId: this.prisma.getTenantId(),
      orderId,
      invoiceId,
      soldAt: new Date(),
      lines: toSaleLedgerLines(items ?? [], packMap),
      db,
    });
  }

  /**
   * Shared sibling-aware rebuild core for reconcileOrderDeliveredInvoices and
   * reconcileOrderDraftInvoice's split path. Rebuilds each (draft, lines) pair from ONLY
   * its own lines at `billQty` (basis "order" → li.qty, "delivered" → the evidence basis,
   * SA-113a; a line with no row of its own reads the legacy column, SA-345a),
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
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    const tenantId = this.prisma.getTenantId();
    const customer = await db.customer.findFirst({
      where: { id: order.customerId },
      select: { isTaxExempt: true },
    });
    const isTaxExempt = !!customer?.isTaxExempt;
    const orderSubtotal = Number(order.subtotal) || 1;
    const orderTax = Number(order.tax) || 0;
    // SA-113a/B785: same evidence basis and reader as reconcileOrderDraftInvoice — one
    // derivation. Fetched once per order, not per draft/line.
    const evidenceBasis = basis === "delivered" ? await deliveredBasisByLine(db, order.id) : null;
    const billQtyOf = (li: any) =>
      evidenceBasis ? deliveredQtyFromBasis(li, evidenceBasis) : Number(li.qty);

    const perDraft = pairs.map(({ draft, lines }) => {
      const priorPackByLine = priorUnitsPerBoxMap(draft.items ?? []);
      const billable = lines
        .map((li: any) => ({ li, billQty: billQtyOf(li) }))
        .filter((x: any) => x.billQty > 0.001);
      const itemsData = billable.map(({ li, billQty }: any) =>
        this.buildInvoiceItemData(li, billQty, tenantId, { priorPack: priorPackByLine.get(li.id) }),
      );
      // B294: stamp the order's effective regular-tax rate onto every line so a
      // later applyPriceAdjustment recompute reproduces this draft's regular tax.
      this.applyOrderDerivedTaxRate(itemsData, order, isTaxExempt);
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
        nsf: { keepIds: [] as string[], feeTotal: 0 }, // #2242: set per draft below
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
    for (const pd of perDraft) {
      // RF-4: tax = allocated regular tax + this draft's category tax (both exempt-0).
      pd.taxAmount = roundMoney(pd.regularTax + pd.categoryTax);
      pd.nsf = await preservedNsfLines(db, pd.draft.id); // #2242: kept, added after tax proration
      pd.subtotal = roundMoney(pd.subtotal + pd.nsf.feeTotal);
      pd.total = roundMoney(
        pd.subtotal - Number(pd.draft.discount ?? 0) + pd.shippingFee + pd.taxAmount,
      );
    }

    const updated: any[] = [];
    for (const pd of perDraft) {
      // Status: the sibling-draft callers force DRAFT (open pending mirrors). R1's
      // post-delivery edit resync passes preserveStatus so a finalized/paid invoice
      // KEEPS its lifecycle — recompute it from its retained payments against the new
      // total (recomputeStatus leaves DRAFT/VOID/WRITTEN_OFF terminal, so an open draft
      // still stays DRAFT). This is what surfaces the "new balance" on a paid edit.
      let nextStatus: InvoiceStatus = InvoiceStatus.DRAFT;
      if (opts?.preserveStatus) {
        // F03/R1: CONFIRMED (PAID) payments only — mirrors the balanceDue math in
        // findAll/findOne so the recomputed status agrees. An unconfirmed DRAFT
        // payment must not count toward the balance any more than a VOID one does.
        const paid = sumConfirmed(pd.draft.payments);
        nextStatus = recomputeInvoiceStatus(
          paid,
          pd.total,
          pd.draft.dueDate ?? null,
          pd.draft.status,
          tz,
        );
      }
      await db.invoiceItem.deleteMany({
        where: { invoiceId: pd.draft.id, id: { notIn: pd.nsf.keepIds } },
      });
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
   * invoices, or a non-NSF invoice line with no orderItemId provenance) — in which case it
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
  async resyncOrderInvoicesForEdit(
    orderId: string,
    tx?: any,
    after?: AfterCommit,
  ): Promise<any[] | null> {
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
          items: { select: RESYNC_ITEM_SELECT }, // #2268: + the NSF-line reads
          payments: { select: { amount: true, status: true } },
        },
      });
      if (invoices.length === 0) return null;

      // Partition lines to invoices; null = unclean (untracked or shared line) → bail.
      const invoiceByLine = partitionInvoiceLines(invoices);
      if (!invoiceByLine) return null;

      const order = await db.order.findUnique({
        where: { id: orderId },
        include: {
          lineItems: {
            where: { status: { not: "CANCELLED" } },
            include: {
              components: { orderBy: { position: "asc" } },
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

      const pairs = planResyncPairs(invoices, order.lineItems, invoiceByLine);

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

    const updated = tx ? await run(tx) : await this.prisma.tenantTransaction(run);

    // This rebuild REWRITES the money on every linked invoice but was the one
    // rebuild path that told nobody, so a mounted invoice screen kept showing the
    // pre-edit total until it was manually refetched. Emitted here, at the OUTER
    // tail rather than inside `run`, so it lands POST-COMMIT on the only
    // production call site (orders.service.ts updateOrderItems, which passes no
    // `tx`). #2175: a caller that passes its own `tx` must also pass its
    // AfterCommit queue (gatewayFor refuses otherwise), so the emit is queued and
    // sent only once THAT transaction commits — never from inside it.
    // Exactly once per rebuilt invoice: rebuildSiblingDrafts returns one row per
    // linked invoice (the partition bails on any shared/unprovenanced line).
    if (updated) {
      const tenantId = this.prisma.getTenantId();
      const gateway = gatewayFor(tx, after, this.gateway, "resyncOrderInvoicesForEdit");
      for (const inv of updated) {
        gateway.emitInvoiceUpdated(tenantId, {
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          customerId: inv.customerId,
          status: inv.status,
          total: Number(inv.total),
        });
      }
    }
    return updated;
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
        items: { select: { orderItemId: true, trackedCategoryId: true, unitsPerBox: true } },
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
            components: { orderBy: { position: "asc" } },
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
   * Aggregates billed qty + subtotal per SOURCE ORDER LINE (via the invoice item's `orderItemId`
   * provenance; falls back to productId for legacy invoice rows), copies the billed subtotal
   * verbatim, and PRESERVES each order line's stored box/piece denomination + unitsPerBox
   * snapshot — it never re-splits against the live product (which used to turn selling-unit
   * lines into phantom box splits). Cancels order lines no invoice bills; preserves the order's
   * effective tax rate. No-op when the order has no surviving (non-void) invoices.
   */
  async recomputeOrderFromInvoices(orderId: string, tx?: any) {
    // SA-093 (#1185 round 5, item B) -- see withOrderRecomputeLock's own doc for the deadlock analysis.
    if (!tx) {
      return withOrderRecomputeLock(this.prisma, orderId, (innerTx) =>
        this.recomputeOrderFromInvoices(orderId, innerTx),
      );
    }
    const db = tx;
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
    for (const li of order.lineItems as any[]) existingById.set(li.id, li);
    // #1185 round 5, item 2 -- see resolveProductMatches' own doc.
    const { existingByProduct, ambiguousLineIds } = resolveProductMatches(order.lineItems);
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
      n: number; // contributing invoice lines
      packs: Set<number>; // their packs (0 = none), for the shared-pack re-split rule
      sample: any; // an invoice item, for the box/piece + upb snapshot
    };
    const byTarget = new Map<string, Agg>();
    const freeformSkipped: string[] = []; // SA-093a rd6: no orderItemId, no productId -- warn, never silent
    for (const inv of invoices) {
      for (const it of inv.items as any[]) {
        const line =
          (it.orderItemId && existingById.get(it.orderItemId)) ||
          (it.productId && existingByProduct.get(it.productId)) ||
          null;
        if (!line && !it.productId) {
          freeformSkipped.push(it.id);
          continue;
        }
        const key = line ? `line:${line.id}` : `product:${it.productId}`;
        const prev = byTarget.get(key) ?? {
          line,
          productId: it.productId ?? null,
          qty: 0,
          subtotal: 0,
          categoryTax: 0,
          freeUnits: 0,
          unitPrice: Number(it.unitPrice),
          n: 0,
          packs: new Set<number>(),
          sample: it,
        };
        prev.n += 1;
        prev.packs.add(Number(it.unitsPerBox ?? 0));
        prev.qty += Number(it.qty);
        prev.subtotal += Number(it.subtotal);
        prev.categoryTax += Number(it.categoryTaxAmount ?? 0);
        prev.freeUnits += Math.max(0, Math.trunc(Number(it.promoFreeUnits ?? 0) || 0));
        prev.unitPrice = Number(it.unitPrice); // most-recent line wins for display
        prev.sample = it;
        byTarget.set(key, prev);
      }
    }

    const deliveredBasis = await deliveredBasisByLine(db, orderId); // SA-093a rd6
    // B667: coverage decided BEFORE any line is rewritten — see checkOrderCoverage's doc.
    const coverage = await checkOrderCoverage({
      db,
      orderId,
      order,
      byTarget,
      invoices,
      deliveredBasis,
      ambiguousLineIds,
    });
    logSkippedMatches(this.logger, orderId, freeformSkipped, coverage);
    if (!coverage.fullyCovered) return coverage.totals;

    let subtotal = 0;
    let categoryTaxSum = 0;
    for (const [key, agg] of byTarget) {
      const existing = agg.line;
      const lineSubtotal = roundMoney(agg.subtotal);
      const lineCategoryTax = roundMoney(agg.categoryTax);
      // BUY_N_GET_M: mirror the BILLED free units back too, so the order line's
      // snapshot can never contradict the subtotal it just took from the invoice.
      const lineFreeUnits = Math.max(0, Math.trunc(agg.freeUnits) || 0);
      subtotal += lineSubtotal;
      categoryTaxSum += lineCategoryTax;
      const shape = orderLineShape(existing, agg);
      if (existing) {
        // An order line that would be rewritten to exactly what it holds is not written at all.
        if (!orderLineUnchanged(existing, shape, agg))
          await db.orderItem.update({
            where: { id: existing.id },
            data: {
              qty: shape.qty,
              boxes: shape.boxes,
              pieces: shape.pieces,
              unitsPerBox: shape.unitsPerBox,
              ...(shape.unitLabel !== undefined ? { unitLabel: shape.unitLabel } : {}),
              unitPrice: agg.unitPrice,
              subtotal: lineSubtotal,
              // RF-4: mirror the billed category tax back onto the order line.
              categoryTaxAmount: lineCategoryTax,
              promoFreeUnits: lineFreeUnits > 0 ? lineFreeUnits : null,
              invoicedQty: shape.qty,
              status: "PENDING",
            },
          });
        existingById.delete(existing.id);
      } else {
        await db.orderItem.create({
          data: {
            orderId,
            productId: agg.productId,
            qty: shape.qty,
            boxes: shape.boxes,
            pieces: shape.pieces,
            unitsPerBox: shape.unitsPerBox,
            ...(shape.unitLabel !== undefined ? { unitLabel: shape.unitLabel } : {}),
            unitPrice: agg.unitPrice,
            subtotal: lineSubtotal,
            // RF-4: mirror the billed category tax back onto the new order line.
            categoryTaxAmount: lineCategoryTax,
            promoFreeUnits: lineFreeUnits > 0 ? lineFreeUnits : null,
            invoicedQty: shape.qty,
            status: "PENDING",
            ...(tenantId ? { tenantId } : {}),
          },
        });
      }
    }

    await syncOrderLineCompositions(db, orderId, tenantId, this.featureConfig);
    // B667: cancelling an orphan and rewriting the order's totals — coverage was already
    // confirmed above, before this loop ran.
    return finalizeOrderRecompute({
      db,
      orderId,
      order,
      deliveredBasis,
      unbilled: existingById,
      subtotal,
      categoryTaxSum,
      invoices,
    });
  }

  /**
   * Fire-and-forget safe variant of createInvoiceFromOrder.
   * Accepts an explicit tenantId so it doesn't depend on AsyncLocalStorage
   * (which is lost when the call is not awaited in the request lifecycle).
   */
  async createInvoiceFromOrderWithTenant(
    orderId: string,
    tenantId: string | null,
    overrides?: {
      dueDate?: string;
      terms?: string;
      paymentTermsLabel?: string;
      /** Explicit per-invoice deposit — wins over the customer's defaultDepositPercent. */
      depositPercent?: number;
      depositDueDate?: string;
    },
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, ...(tenantId ? { tenantId } : {}) },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            components: { orderBy: { position: "asc" } },
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
    // Also carries defaultDepositPercent off the SAME row (no extra query).
    const customerForTax = tenantId
      ? await this.prisma.customer.findFirst({
          where: { id: order.customerId, ...(tenantId ? { tenantId } : {}) },
          select: { isTaxExempt: true, defaultPaymentTerms: true, defaultDepositPercent: true },
        })
      : null;
    const customerDepositPercent =
      (customerForTax as any)?.defaultDepositPercent != null
        ? Number((customerForTax as any).defaultDepositPercent)
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
    const issueDate = order.orderDate ?? startOfCalendarDay(new Date(), tenantTimezone);
    let dueDate: Date;
    if (overrides?.dueDate) {
      dueDate = calendarFieldStamp(overrides.dueDate, "dueDate"); // #2256
    } else {
      dueDate = addCalendarDays(issueDate, dueDays);
    }

    const overrideTerms = overrides?.terms?.trim() || undefined;
    // INVARIANT: see createInvoiceFromOrder — persist whichever string drove the
    // dueDate math (an explicit override label, else the resolved default), and
    // null when an explicit dueDate override means no term string drove it.
    const paymentTermsLabel =
      overrides?.paymentTermsLabel?.trim() || (overrides?.dueDate ? null : defaultTerms);
    // Deposit resolution — the SAME rule as resolveDefaultTerms/createInvoiceFromOrder
    // (customer wins when SET: >0 = their percent, 0 = explicit opt-out; null/undefined
    // inherits the tenant default), adapted for this explicit-tenantId path: there is no
    // AsyncLocalStorage here, so the tenant key is read straight off SystemConfig by
    // tenantId, exactly like invoice.defaultTerms above. Without this the tenant-wide
    // deposit policy would apply ONLY to the awaited "New sale" flow and silently skip
    // every regular order placement (buyer portal + operator create), which is the
    // mainline case.
    let tenantDepositPercent: number | null = null;
    if (tenantId && customerDepositPercent == null) {
      const depCfg = await this.prisma.systemConfig.findFirst({
        where: { tenantId, key: "invoice.depositDefaultPercent" },
        select: { value: true },
      });
      tenantDepositPercent = depCfg?.value ? Number(depCfg.value) : null;
    }
    const effectiveDepositPercent =
      customerDepositPercent != null
        ? customerDepositPercent > 0
          ? customerDepositPercent
          : null
        : tenantDepositPercent && tenantDepositPercent > 0
          ? tenantDepositPercent
          : null;
    // Explicit overrides.depositPercent wins; no effective deposit leaves these keys
    // out entirely (byte-identical to before).
    const depositFields: Record<string, any> =
      overrides?.depositPercent != null
        ? {
            depositPercent: overrides.depositPercent,
            depositDueDate: overrides.depositDueDate
              ? calendarFieldStamp(overrides.depositDueDate, "depositDueDate")
              : issueDate,
          }
        : effectiveDepositPercent != null
          ? { depositPercent: effectiveDepositPercent, depositDueDate: issueDate }
          : {};
    const extraInvoiceData: Record<string, any> = {
      dueDate,
      terms: overrideTerms ?? tenantTerms ?? defaultTerms,
      paymentTermsLabel,
      issueDate,
      notes: tenantNotes ?? (order.orderNumber ? `Order #${order.orderNumber}` : null),
      ...depositFields,
    };

    // W4: split by regulated category (fire-and-forget path). db = unscoped prisma
    // with an explicit tenantId, exactly as this method already used it.
    const created = await this.createSplitInvoices({
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

    // Issuance at order placement for the REGULAR-order path (buyer portal + operator
    // create), gated identically to createInvoiceFromOrder: a deposit actually applies,
    // exactly ONE invoice was created (a SEPARATE_INVOICE split keeps DRAFT mirrors —
    // only open DRAFTs get sibling-aware rebuilds; see createInvoiceFromOrder for the
    // full rationale), the order isn't already delivered, and the tenant flag is on.
    //
    // The flip is done INLINE rather than through send(): send() runs on
    // this.prisma.forTenant(), and this method exists precisely because there is NO
    // request context here (fire-and-forget → AsyncLocalStorage is gone), so it would
    // resolve the wrong tenant or none at all. Status SENT + sentAt is everything
    // payability needs (web/mobile canRecordPayment is status-driven, and
    // recomputeStatus can advance a SENT invoice), so the mirror is fully payable.
    // Deliberately NOT replicated from send(): the INVOICE_SENT notification and the
    // socket emit — placement-issuance on this path is notification-less by design
    // (nothing is emailed; the buyer sees the deposit on the invoice itself), matching
    // the "issue without notifying" precedent the van-sale flow already relies on.
    // Credit auto-apply is likewise skipped: it is send()-scoped and still runs the
    // moment a payment/credit is applied through the normal flows.
    if (created.length === 1 && depositFields.depositPercent != null && tenantId) {
      const collectRaw = await this.prisma.systemConfig.findFirst({
        where: { tenantId, key: "invoice.depositCollectAtOrder" },
        select: { value: true },
      });
      if (collectRaw?.value === "true" && (order as any).status !== "DELIVERED") {
        // Update by primary key of the row this method just created for this tenant —
        // safe without a tenant filter (the id came from our own create), and the
        // unscoped client is the same handle the rest of this method uses.
        const issued = await this.prisma.invoice.update({
          where: { id: created[0].id },
          data: { status: InvoiceStatus.SENT, sentAt: new Date() },
          include: {
            customer: {
              select: { id: true, businessName: true, email: true, phone: true, mobile: true },
            },
            items: true,
            payments: true,
          },
        });
        return [issued];
      }
    }

    return created;
  }

  /**
   * Create one of N partial invoices for an order. Operator picks which order items
   * (and how many of each) go on this invoice + a due date. Each call increments
   * OrderItem.invoicedQty so we never over-bill.
   */
  async createPartialFromOrder(
    orderId: string,
    dto: CreatePartialInvoiceDto,
    overrides?: {
      dueDate?: string;
      terms?: string;
      paymentTermsLabel?: string;
      /** Explicit per-invoice deposit — wins over the customer's defaultDepositPercent. */
      depositPercent?: number;
      depositDueDate?: string;
    },
  ) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            components: { orderBy: { position: "asc" } },
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
    assertPartialRequestShape(dto.items); // #2070 / SA-523: no duplicate lines, qty > 0
    // B760/SA-106/SA-113(ii): same evidence-keyed basis as createInvoiceFromOrder — see its
    // own comment. One derivation, shared; read only after the request shape is valid.
    const deliveredBasis = await deliveredBasisByLine(this.prisma.forTenant(), orderId);
    const itemsData: any[] = [];
    let subtotal = 0;
    for (const req of dto.items) {
      const li: any = itemById.get(req.orderItemId);
      if (!li) {
        throw new BadRequestException(
          `Order item ${req.orderItemId} not found on order ${orderId}`,
        );
      }
      const billable = billableQtyFromBasis(li, deliveredBasis);
      const remaining = billable - Number(li.invoicedQty ?? 0);
      if (req.qty > remaining + 0.001) {
        // SA-106: when the delivered basis is what caps the line, say so.
        const delivered = billable < Number(li.qty) ? ` (delivered ${billable})` : "";
        throw new BadRequestException(
          `Requested qty ${req.qty} exceeds remaining ${Math.max(0, remaining)} for ${li.product?.name ?? li.productId}${delivered}`,
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
    // B294: stamp the order's effective regular-tax rate onto every line so a
    // later applyPriceAdjustment recompute reproduces this partial's regular tax.
    this.applyOrderDerivedTaxRate(itemsData, order, isTaxExempt);
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
    // Also carries the customer's defaultDepositPercent off the SAME row (no extra query).
    const {
      terms: defaultTerms,
      dueDays,
      effectiveDepositPercent,
    } = await this.resolveDefaultTerms(order.customerId);
    const tenantDefaults = await this.resolveTenantInvoiceDefaults();
    // A backdated order bills on its business date, and the payment term runs from
    // that date — not from when the invoice happened to be generated.
    const issueDate = order.orderDate ?? startOfCalendarDay(new Date(), tenantDefaults.timezone);
    let dueDate: Date;
    if (dto.dueDate) {
      dueDate = calendarFieldStamp(dto.dueDate, "dueDate"); // #2256
    } else if (overrides?.dueDate) {
      dueDate = calendarFieldStamp(overrides.dueDate, "dueDate"); // #2256
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
    // Deposit default — see createInvoiceFromOrder for the full rationale. An explicit
    // deposit (dto.depositPercent, or a caller override) wins and is never clobbered;
    // otherwise the EFFECTIVE percent applies (customer override when set, else the
    // tenant-wide default), so a partial is consistent with the mirror it splits out
    // of. No effective deposit leaves these keys out entirely (byte-identical to
    // before). NO issuance here: partials are cut at delivery time, never at placement.
    const explicitDepositPercent = (dto as any)?.depositPercent ?? overrides?.depositPercent;
    const explicitDepositDueDate = (dto as any)?.depositDueDate ?? overrides?.depositDueDate;
    const depositFields: Record<string, any> =
      explicitDepositPercent != null
        ? {
            depositPercent: explicitDepositPercent,
            depositDueDate: dueStamp(explicitDepositDueDate, "depositDueDate") ?? issueDate,
          }
        : effectiveDepositPercent != null
          ? { depositPercent: effectiveDepositPercent, depositDueDate: issueDate }
          : {};
    const tenantId = this.prisma.getTenantId();

    // F03/R7/T-B85: the create + invoicedQty bump + credit-note settle run inside
    // ONE tenantTransaction — mirrors createSplitInvoices's runCreation(tx) shape.
    // Previously this ran with no transaction at all AND never settled the
    // order's explicit-amount OrderCreditNote selections, so a leftover selection
    // was neither auto-applied (send()'s explicitIds exclusion assumes settle
    // already ran) nor settled here — stranding it. B100/F16b: the number is reserved
    // BEFORE this transaction opens, in reserveNext's own short transaction
    // (fix-round-2.md D1) — a failure below leaves a gap in the series. This method
    // never receives a caller tx; if it ever does, it must reserve INSIDE it with
    // `generateInvoiceNumber(tenantId, tx)`, the createSplitInvoices rule
    // (fix-round-2b.md D7) — a hoisted reservation under a caller's tx is the
    // pool-starving nested open.
    const invoiceNumber = await this.generateInvoiceNumber(tenantId ?? undefined);
    const runCreation = async (tx: any) => {
      let created: any;
      try {
        created = await tx.invoice.create({
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
            ...depositFields,
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

      // #2070 / SA-523: each line's bump is a CAS on what was read; any miss rolls back the partial.
      await bumpInvoicedQtyCas(tx, dto.items, itemById);

      await this.creditNotes.settleOrderCreditsInTx(tx, order.id, tenantId);
      return created;
    };

    const invoice = await this.prisma.tenantTransaction(runCreation);

    if (dto.send) {
      return this.send(invoice.id);
    }
    return invoice;
  }

  /**
   * Generate the next invoice number via `NumberingService.reserveNext` — replaces
   * the former unscoped `prisma.invoice.findFirst` scan (B100/F16b, cause-ruling.md
   * §2 D2: that scan was both cross-tenant, :2778 `where` carried no `tenantId`, and
   * lexicographically wrong past 9999, :2779 `orderBy` sorted TEXT).
   *
   * `tx` is threaded in ONLY by a caller that is already inside a transaction (the
   * delivery path — routes stop completion → `recordDeliveryPaymentInTx` →
   * `createInvoiceFromOrder(orderId, tx)`): `reserveNext` then reserves on THAT
   * client, opening nothing, because a nested `$transaction` would need a second
   * pooled connection while this one is held and starves the pool under concurrent
   * mints (REG-B100-C). Such a caller holds the counter row lock until its own
   * commit — safe, since the office paths below reserve standalone and never hold
   * another row lock while holding the counter, so no lock-order cycle exists
   * (fix-round-2b.md D7).
   *
   * Omitted (every office path), `reserveNext` reserves in its OWN short transaction
   * and commits it before returning, so the caller's later transaction never holds
   * the `NumberingSequence` row lock (fix-round-2.md D1). The trade is explicit: a
   * rollback after this call leaves a gap in the series.
   *
   * `tenantId` is passed explicitly only on the fire-and-forget path that has no
   * request-context tenant (`createInvoiceFromOrderWithTenant`) — every other caller
   * relies on `NumberingService` resolving it from the request context as before.
   */
  private async generateInvoiceNumber(tenantId?: string, tx?: any): Promise<string> {
    const year = new Date().getFullYear();
    return this.numbering.reserveNext("INVOICE", { year, tenantId, ...(tx ? { tx } : {}) });
  }

  async findAll(query: ListInvoicesDto, user?: JwtPayload) {
    const { customerId, sortBy, sortOrder, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};
    // SA-488: the isOverdue filter ends the due day in the tenant's zone (read only when used).
    const tz = query.isOverdue ? (await this.resolveTenantInvoiceDefaults()).timezone : null;
    applyInvoiceStatusFilters(where, query, tz);
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
    applyInvoiceSearchAndDateFilters(where, query);
    const orderBy = invoiceListOrderBy(sortBy, sortOrder);

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
      // F03/R1/T-B11s: CONFIRMED (PAID) payments only. An unconfirmed DRAFT
      // payment (e.g. a bulk bank-reconciliation entry an operator hasn't
      // confirmed yet) must not be folded into the list's own balance-due number
      // any more than a VOID (bounced check, P5-12) one is — both must match
      // findOne's paidAmount/balanceDue.
      //
      // B421: paidAmount is now CASH-ONLY (a CREDIT_NOTE application is not
      // money the tenant received, and rendered/counted as "Paid" it looked
      // like one) — creditApplied/advanceApplied are separate fields. The
      // customer's OBLIGATION is still reduced by any confirmed method, so
      // balanceDue and the deposit check both use the full confirmed total.
      const { cash: paidAmount, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
      const totalConfirmed = paidAmount + creditApplied + advanceApplied;
      const isSettled =
        inv.status === InvoiceStatus.PAID ||
        inv.status === InvoiceStatus.VOID ||
        inv.status === InvoiceStatus.WRITTEN_OFF;
      // B421 (review F3): roundMoney BEFORE the > 0 comparison/coloring below —
      // totalConfirmed sums three separately-computed floats (cash + credit +
      // advance), so an invoice fully settled by a mix of methods can leave a
      // sub-cent float remnant (e.g. -2.8e-14) that Math.max(0, ...) doesn't
      // catch, rendering a red "Balance Due $0.00" on an otherwise-settled
      // invoice. fmt() rounds for DISPLAY but this raw value drives the color/
      // isOverdue logic directly.
      const balanceDue = isSettled
        ? 0
        : Math.max(0, roundMoney(Number(inv.total) - totalConfirmed));
      const dueDateIso = inv.dueDate
        ? (inv.dueDate instanceof Date ? inv.dueDate : new Date(inv.dueDate))
            .toISOString()
            .slice(0, 10)
        : null;
      const isOverdue = !isSettled && balanceDue > 0 && dueDateIso != null && dueDateIso < todayIso;
      const { depositAmount, depositOverdue } = computeDepositFields(
        inv as any,
        totalConfirmed,
        todayIso,
      );
      return {
        ...inv,
        balanceDue,
        paidAmount,
        creditApplied,
        advanceApplied,
        isOverdue,
        depositAmount,
        depositOverdue,
      };
    });

    return {
      data: computedData,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** B12: the invoices page's KPI tiles live in invoice-kpi-summary.ts (size ratchet). */
  async getKpiSummary(viewerToday: string, user: JwtPayload): Promise<InvoiceKpiSummary> {
    const deps = {
      prisma: this.prisma,
      resolveTenantInvoiceDefaults: () => this.resolveTenantInvoiceDefaults(),
    };
    return computeInvoiceKpiSummary(deps, viewerToday, user);
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
            components: { orderBy: { position: "asc" } }, // #2717 M3: frozen sub-lines
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
        order: { select: { status: true, orderNumber: true, fulfillPath: true } },
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
    // Rides the invoice payload (not /settings/invoice, which is operator-only)
    // so CUSTOMER viewers of this same document honor the tenant's
    // hide-original-price preference too.
    const hideOriginalPrice = (await this.systemConfig.get("invoice.hideOriginalPrice")) === "true";
    return {
      ...inv,
      ...deriveInvoiceDetailFields(inv),
      items: withComponentViews(inv.items) as typeof inv.items, // #2717 M3: displayUnitPrice4 as a number
      hideOriginalPrice,
      pendingMirror: await resolvePendingMirror(this.featureConfig, inv.tenantId, inv, inv.order),
    };
  }

  async update(id: string, dto: UpdateInvoiceDto) {
    const inv = await this.findOneOrThrow(id); // a missing invoice is a 404 whatever else is wrong
    // units_v1: a line can be CREATED by a unit (create(), 4c-1) but not yet REWRITTEN by one (4c-2);
    // the shared DTO accepts `unitLabel`, and this path would silently store a PACK line for it.
    if (dto.items?.some(requestsUnit)) {
      throw new BadRequestException("Selling by a unit can't be set on an invoice edit yet.");
    }
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException("Only DRAFT invoices can be edited");
    await this.assertOrderInvoiceUnlocked(inv);

    // #2197: the same literal calendar-day stamp create() writes.
    const issueDate = dto.issueDate ? issueDateStamp(dto.issueDate) : undefined;
    const due = dueDateStamps(dto); // #2256: and the due dates, before either rewrite path runs

    // units_v1: BOTH rewrite paths — the item replace (re-split at the LIVE pack) and the
    // discount/shipping recompute, whose order back-sync writes onto the linked order's lines.
    if (dto.items || dto.discount !== undefined || dto.shippingFee !== undefined) {
      await unitAware.assertInvoiceRewriteAllowed(this.prisma.forTenant(), inv);
    }

    const items = dto.items;
    if (items) {
      // F-05: netted per product (qtyDelta = requested - held); re-checked under the row lock in the tx below.
      const restrictionLines = await addedRestrictionLines(this.prisma.forTenant(), id, items);
      await this.sellingRestrictions.assertLinesSellable({
        tenantId: requireRestrictionTenantId(this.prisma.getTenantId()),
        customerId: inv.customerId,
        lines: restrictionLines,
        channel: "STAFF",
      });
      await assertOrderItemIdsBelongToOrder(this.prisma.forTenant(), inv.orderId, items); // SA-093a rd6
      // Products (pack + regulated snapshot) and section tax config for the edited lines (mirrors create()).
      const { productMap, categoryMap } = await loadEditCatalog(this.prisma.forTenant(), items);

      const { updated } = await this.prisma.tenantTransaction(async (tx: any) => {
        // Serialize concurrent saves of this invoice: rows are read AFTER the lock, so a second save
        // sees the first's rows and totals instead of writing over them (no P2025, total = its lines).
        // Lock order (SA-137/203): the ORDER row first, then the invoice, as the invoice-from-order paths do.
        if (inv.orderId)
          await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${inv.orderId} FOR UPDATE`;
        await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
        await assertEditStillJudged(tx, id, items, restrictionLines); // F-05: under the Invoice row lock
        // SA-184/186: match the payload to THIS invoice's stored rows (by id, tenant-scoped; never by
        // productId), keep untouched rows verbatim and in place, re-price only changed lines. Rules
        // and reasoning: invoice-edit-plan.ts.
        const storedRows = await tx.invoiceItem.findMany({ where: { invoiceId: id } });
        const matches = matchEditLines(items, storedRows);
        assertNsfLinesUntaxed(
          items,
          matches.map((m) => m.row),
        ); // #2656: 400 before any write
        const editLines = buildEditedLines({
          items: items,
          stored: storedRows,
          matches,
          productMap,
          categoryMap,
          clampFreeUnits: (f, b, q) => this.clampLineFreeUnits(f, b, q),
          warn: (m) => this.logger.warn(`update(): invoiceId ${id} ${m}`),
        });
        const itemsData = editLines.map((l) => l.data);
        // B1026: the SAME discount-exceeds-line guard create() runs, over the lines THIS edit writes
        // (changed or new), before any write; a stored line the edit leaves verbatim is not re-judged.
        assertNoNegativeLineSubtotal(
          editLines.filter((l) => !l.untouched).map((l) => l.data as any),
        );
        await this.applyMsrpSnapshots(
          tx,
          inv.customerId,
          editLines.filter((l) => !l.untouched).map((l) => l.data as any),
        );
        const customerForTax = await tx.customer.findFirst({
          where: { id: inv.customerId },
          select: { isTaxExempt: true },
        });
        const isTaxExempt = !!(customerForTax as any)?.isTaxExempt;
        const cur = await tx.invoice.findUnique({
          where: { id },
          select: { discount: true, shippingFee: true, subtotal: true, total: true },
        });
        const invDiscount = dto.discount ?? Number(cur.discount);
        const shipping = dto.shippingFee ?? Number(cur.shippingFee);
        const { subtotal, taxTotal, total } = editInvoiceTotals(
          itemsData,
          isTaxExempt,
          invDiscount,
          shipping,
        );
        assertInvoiceTotalsSane(
          { discount: invDiscount, subtotal, total },
          storedInvoiceTotals(cur),
        ); // B1030 / SA-651: not worse than stored, before any write
        // Rebuild the items AND re-sync the W5 ledger atomically: the delete-and-recreate
        // rotates invoiceItemIds and can change qty/price or add/remove a regulated line,
        // so the invoice's prior SALE rows must be reversed and re-written from the new
        // items (a no-op when neither the old nor new invoice carries a regulated line).
        // Matched rows stay IN PLACE (ledger, credit notes and returns reference their ids); only
        // rows the payload dropped are deleted and only changed rows are written.
        const keptIds = editLines.flatMap((l) => (l.rowId ? [l.rowId] : []));
        await tx.invoiceItem.deleteMany({ where: { invoiceId: id, id: { notIn: keptIds } } });
        for (const l of editLines) {
          const row = l.rowId && storedRows.find((r: any) => r.id === l.rowId);
          const patch = row ? inPlacePatch(l, row) : null;
          if (patch) await tx.invoiceItem.update({ where: { id: l.rowId }, data: patch });
        }
        await applyComposedLineEdits(tx, inv, editLines, storedRows); // #2717 M3: case 18
        // SA-189: history must tell an attested pack (the operator's explicit unitsPerBox) from a recovered one.
        const attested = editLines.flatMap((l) =>
          l.attestedPack ? [{ rowId: l.rowId, unitsPerBox: l.attestedPack }] : [],
        );
        if (attested.length > 0) {
          await tx.auditLog.create({
            data: {
              tenantId: this.prisma.getTenantId(),
              action: "INVOICE_LINE_PACK_ATTESTED",
              entityType: "invoice",
              entityId: id,
              meta: { attested },
            },
          });
        }
        const u = await tx.invoice.update({
          where: { id },
          data: {
            subtotal,
            taxAmount: taxTotal,
            discount: invDiscount,
            shippingFee: shipping,
            total,
            dueDate: due.dueDate ?? undefined,
            issueDate,
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
              depositDueDate: due.depositDueDate,
            }),
            pdfUrl: null,
            items: {
              create: editLines
                .filter((l) => !l.rowId)
                .map((l) => ({ ...l.data, tenantId: this.prisma.getTenantId() })),
            },
          },
          include: {
            customer: { select: { id: true, businessName: true } },
            items: true,
            payments: true,
          },
        });
        const syncLines = orderSyncLines(editLines, storedRows, cur, invDiscount, shipping);
        // A save that changed no line leaves the ledger alone too (no reverse-and-rewrite churn).
        if (syncLines?.length)
          await this.resyncInvoiceLedger(id, inv.orderId ?? null, u.items ?? [], tx);
        return { updated: u };
      });
      // Backward sync: keep the linked order in step with the edited invoice.
      // SA-233/235: ALWAYS the full coverage recompute (no payload-shape gate); identical rows are skipped inside it.
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
      const total = roundMoney(subtotal - invDiscount + shipping + taxTotal);
      assertInvoiceTotalsSane({ discount: invDiscount, subtotal, total }, storedInvoiceTotals(inv)); // B1030 / SA-651
      recalcData = {
        subtotal,
        taxAmount: taxTotal,
        discount: invDiscount,
        shippingFee: shipping,
        total,
      };
    }

    const updated = await this.prisma.forTenant().invoice.update({
      where: { id },
      data: {
        ...(due.dueDate && { dueDate: due.dueDate }),
        ...(issueDate && { issueDate }),
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
          depositDueDate: due.depositDueDate,
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
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
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
    const newDueDate = dto.dueDate ? calendarFieldStamp(dto.dueDate, "dueDate") : oldDueDate; // #2256
    const newDueDateStr = newDueDate ? newDueDate.toISOString().slice(0, 10) : "none";

    // F03/R1: CONFIRMED (PAID) payments only — same predicate every other status
    // computation in this file uses.
    const totalPaid = sumConfirmed(inv.payments);
    const newStatus = recomputeInvoiceStatus(
      totalPaid,
      Number(inv.total),
      newDueDate,
      inv.status,
      tz,
    );

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
   *
   * `opts.allowPreDelivery` (WP-D1) is a narrow escape hatch used ONLY by
   * createInvoiceFromOrder's deposit-collect-at-order issuance: a tenant-configured
   * deposit mirror is DESIGNED to be sendable (SENT, no email) before delivery so the
   * deposit can be paid right away — that is the feature, not a bypass of it. It is
   * never set by the public send()/sendEmail() callers (controller, "New sale"
   * van-sale flow, reminders), so a plain pending mirror keeps refusing to be sent
   * pre-delivery exactly as before.
   */
  private async assertOrderInvoiceUnlocked(
    inv: {
      orderId: string | null;
      status: InvoiceStatus;
      deliveryBatchId: string | null;
    },
    opts?: { allowPreDelivery?: boolean },
  ): Promise<void> {
    if (!inv.orderId || inv.status !== InvoiceStatus.DRAFT || inv.deliveryBatchId != null) return;
    if (opts?.allowPreDelivery) return;
    const order = await this.prisma.forTenant().order.findFirst({
      where: { id: inv.orderId },
      select: { status: true, orderNumber: true, fulfillPath: true },
    });
    if (
      order &&
      (await resolvePendingMirror(this.featureConfig, this.prisma.getTenantId(), inv, order))
    ) {
      throw new BadRequestException(
        `This invoice mirrors order #${order.orderNumber ?? ""} and can't be sent or edited until the order is delivered. Edit the order instead — the invoice updates automatically.`,
      );
    }
  }

  async send(id: string, opts?: { allowPreDelivery?: boolean }) {
    const inv = await this.findOneOrThrow(id);
    const refusal = sendRefusal(inv.status); // #2255: fast pre-tx; markSent re-checks under the lock
    if (refusal) throw new BadRequestException(refusal);
    await this.assertOrderInvoiceUnlocked(inv, opts);
    // P5-13: SENT flip + oldest-first credit auto-apply are ONE atomic operation.
    // Idempotent on re-send. If the tx throws, the send fails — money first.
    const { updated, auto } = await this.markSent(id, inv.orderId);
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

  /**
   * The SENT flip + credit settle/auto-apply shared by send() and sendEmail() — ONE Serializable
   * tx, re-run on a write conflict (#2255, SA-269 retryOnTxConflict). Everything it decides comes
   * from the row it locks and re-reads first (SA-404), so a retry can never write SENT over a
   * VOID committed since the caller's read.
   */
  private async markSent(id: string, orderId: string | null, emailSent = false) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    return retryOnTxConflict(`invoice mark-sent id=${id}`, () =>
      this.prisma.tenantTransaction(
        async (tx) => {
          // #2255 / SA-404: FIRST statement — lock (Order →) Invoice and re-read, then decide from
          // the LOCKED row: a retry runs on a fresh snapshot, never on the caller's pre-tx read.
          const locked = await lockInvoiceRow(tx, id, orderId);
          if (!locked) throw new NotFoundException("Invoice not found");
          const refusal = sendRefusal(locked.status, emailSent);
          if (refusal) throw new BadRequestException(refusal);
          const nextStatus = nextSentStatus(locked.status);
          const updated = await tx.invoice.update({
            where: { id },
            data: { status: nextStatus, sentAt: new Date() },
          });
          // B108: make the "send() catches up" comment above actually true. An
          // operator's explicit-amount OrderCreditNote intents are settled HERE,
          // at their recorded amount, before the oldest-first sweep runs.
          // settleOrderCreditsInTx clamps to the remaining balance, so money can
          // never move twice even if it already ran (e.g. at order-create time).
          // The explicitIds exclusion just below is deliberately KEPT — settling
          // an explicit intent doesn't change that the sweep must still never
          // override it.
          if (updated.orderId) {
            await this.creditNotes.settleOrderCreditsInTx(tx, updated.orderId);
          }
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
          const auto = await this.creditNotes.autoApplyOldestCreditsInTx(
            tx,
            id,
            updated.customerId,
            {
              excludeCreditNoteIds: explicitIds,
            },
          );
          // A credit pre-applied at order time can already cover this invoice. Auto-apply
          // returns {applied:0, invoiceStatus:null} on a zero balance, which used to leave
          // a fully-credited invoice stuck SENT — recompute from the payments it has.
          if (!auto.invoiceStatus) {
            const fresh = await tx.invoice.findUnique({
              where: { id },
              include: { payments: true },
            });
            if (fresh) {
              // F03/R1: CONFIRMED (PAID) payments only.
              const paid = roundMoney(sumConfirmed(fresh.payments));
              const st = recomputeInvoiceStatus(
                paid,
                Number(fresh.total),
                fresh.dueDate,
                fresh.status,
                tz,
              );
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
      ),
    );
  }

  /**
   * SA-404a: sendEmail's pre-send check — a short Serializable tx that locks (Order →) Invoice and
   * runs the send guard, so a VOID committed before the email means NO email and a 400. R5 keeps
   * the SENT flip after delivery; the residual is only the email I/O window (markSent then refuses
   * with VOIDED_DURING_EMAIL).
   */
  private assertSendableUnderLock(id: string, orderId: string | null) {
    return retryOnTxConflict(`invoice send pre-check id=${id}`, () =>
      this.prisma.tenantTransaction(
        async (tx) => {
          const locked = await lockInvoiceRow(tx, id, orderId);
          if (!locked) throw new NotFoundException("Invoice not found");
          const refusal = sendRefusal(locked.status);
          if (refusal) throw new BadRequestException(refusal);
        },
        { isolationLevel: "Serializable" },
      ),
    );
  }

  /** Send the invoice as an actual email and mark as SENT. */
  async sendEmail(id: string, overrideEmail?: string, variant?: "draft" | "final") {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true, email: true } },
        items: true,
        // F03/R8: CONFIRMED (PAID) payments only — feeds totalPaid/balanceDue below.
        // B421: creditNote relation needed for the customer-facing "Credit
        // issued — CN-…" line's number.
        payments: {
          where: CONFIRMED_PAYMENT,
          include: { creditNote: { select: { creditNoteNumber: true } } },
        },
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    const refusal = sendRefusal(inv.status); // #2255: fast pre-tx; markSent re-checks under the lock
    if (refusal) throw new BadRequestException(refusal);
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
        code: API_ERROR_CODES.EMAIL_NOT_CONFIGURED,
        message:
          "Email isn't set up yet, so the invoice wasn't emailed. Configure your email/SMTP settings under Settings → Email, then try again.",
      });
    }

    // Get PDF URL (non-blocking) + its attachment; `variant` picks DRAFT vs FINAL.
    let pdfUrl: string | undefined, attachment: InvoiceEmailAttachment | undefined;
    try {
      pdfUrl = await this.pdfService.getOrGenerate(id, { variant });
      if (pdfUrl) {
        const dl = this.storage.download.bind(this.storage);
        attachment = await buildInvoiceEmailAttachment(dl, this.logger, id, inv.invoiceNumber);
      }
    } catch {
      this.logger.warn(
        `Could not generate PDF for invoice ${id} — email will be sent without PDF link`,
      );
    }

    // F03/R8/T-B102: CONFIRMED (PAID) basis — mirrors the PDF and the invoice
    // detail's own paidAmount/balanceDue math. A DRAFT (unconfirmed) payment must
    // not inflate what the email tells the customer they've already paid.
    // B421: totalPaid is cash-only — a CREDIT_NOTE or ADVANCE application must
    // never render as "Amount Paid" in an email sent to the customer. balanceDue
    // stays on the full confirmed total (sumConfirmed) — a credit note or
    // advance genuinely reduces what's still owed.
    const { cash: totalPaid, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
    const balanceDue = roundMoney(Math.max(0, Number(inv.total) - sumConfirmed(inv.payments)));
    const creditNoteNumbers = Array.from(
      new Set(
        (inv.payments ?? [])
          .filter((p) => p.method === CREDIT_NOTE_METHOD)
          .map((p) => (p as any).creditNote?.creditNoteNumber)
          .filter((n): n is string => !!n),
      ),
    );

    // F03/R9: the SAME tenant setting findOneOrThrow and the PDF read. The email
    // body renders the same item table as the PDF attached to this very message,
    // so it has to honour the hide-original-price preference too — otherwise
    // forwarding the promo scalars below would newly leak the struck pre-promo
    // price a tenant deliberately configured away.
    const hideOriginalPrice = (await this.systemConfig.get("invoice.hideOriginalPrice")) === "true";

    // Built as a variable (not an inline literal) so the extra totalPaid/
    // balanceDue fields don't trip TS's excess-property check ahead of the F03
    // batch's matching email.service.ts `sendInvoice` param-type update (a
    // different file/package in this same campaign batch) — the runtime call
    // carries them either way, which is what email.service.spec.ts and the
    // T-B102 caller-leg assertion here both need.
    const emailPayload = {
      to: recipientEmail,
      customerName: inv.customer?.businessName ?? "Customer",
      invoiceNumber: inv.invoiceNumber,
      invoiceId: inv.id,
      issueDate: formatDate(inv.issueDate),
      dueDate: formatDate(inv.dueDate),
      paymentTermsLabel: inv.paymentTermsLabel ?? undefined,
      total: Number(inv.total),
      totalPaid,
      creditApplied,
      advanceApplied,
      creditNoteNumbers,
      balanceDue,
      items: inv.items.map((it: any) => ({
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        subtotal: Number(it.subtotal),
        msrp: it.msrp != null ? Number(it.msrp) : null,
        // F03/R9: without these, buildInvoiceEmail's strike/"N free" note and a BOGO line's reduced subtotal read as a pricing error.
        originalPrice: it.originalPrice != null ? Number(it.originalPrice) : null,
        priceType: it.priceType ?? null,
        promoFreeUnits: it.promoFreeUnits != null ? Number(it.promoFreeUnits) : null,
        ...invoiceItemQtyFields(it),
      })),
      pdfUrl,
      attachment,
      isReminder: false,
      hideOriginalPrice,
      // Deposit schedule (display-only): derive with the same read-time math the
      // detail endpoint uses; null when the invoice carries no deposit.
      depositAmount: computeDepositFields(inv as any, 0, new Date().toISOString().slice(0, 10))
        .depositAmount,
      depositDueDate: inv.depositDueDate ? formatDate(inv.depositDueDate) : null,
    };
    await this.assertSendableUnderLock(id, inv.orderId); // SA-404a: VOID now ⇒ 400, no email
    const sendResult = await this.emailService.sendInvoice(emailPayload);

    // R5: the email server was configured but the actual send did NOT succeed
    // (bad SMTP credentials, Resend rejected the domain/key, etc.). Do NOT mark the
    // invoice SENT or return success — surface the real failure so the operator can fix
    // it in Settings → Email rather than believing the customer received the invoice.
    if (!sendResult.delivered) {
      throw new BadRequestException({
        code: API_ERROR_CODES.EMAIL_SEND_FAILED,
        message: `The invoice couldn't be emailed${sendResult.error ? ` (${sendResult.error})` : ""}. Check your email settings under Settings → Email and try again.`,
      });
    }

    // Mark as SENT. P5-13: SENT flip + oldest-first credit auto-apply are ONE atomic
    // operation. PDF/email I/O above stays OUTSIDE the tx (a retry never re-sends the email).
    const { updated, auto } = await this.markSent(id, inv.orderId, true);
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
        // F03/R8: CONFIRMED (PAID) payments only — feeds totalPaid/balanceDue below.
        // B421: creditNote relation needed for the customer-facing "Credit
        // issued — CN-…" line's number.
        payments: {
          where: CONFIRMED_PAYMENT,
          include: { creditNote: { select: { creditNoteNumber: true } } },
        },
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
        code: API_ERROR_CODES.EMAIL_NOT_CONFIGURED,
        message:
          "Email isn't set up yet, so the reminder wasn't sent. Configure your email/SMTP settings under Settings → Email, then try again.",
      });
    }

    let pdfUrl: string | undefined;
    let attachment: InvoiceEmailAttachment | undefined;
    try {
      pdfUrl = await this.pdfService.getOrGenerate(id);
      if (pdfUrl) {
        const dl = this.storage.download.bind(this.storage);
        attachment = await buildInvoiceEmailAttachment(dl, this.logger, id, inv.invoiceNumber);
      }
    } catch {
      /* non-critical */
    }

    // F03/R8/T-B102: CONFIRMED (PAID) basis, same as sendEmail — a reminder must
    // demand the true outstanding balance, never the DRAFT-inflated figure a
    // non-VOID sum would give. B421: totalPaid is cash-only, same as sendEmail.
    const { cash: totalPaid, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
    const balanceDue = roundMoney(Math.max(0, Number(inv.total) - sumConfirmed(inv.payments)));
    const creditNoteNumbers = Array.from(
      new Set(
        (inv.payments ?? [])
          .filter((p) => p.method === CREDIT_NOTE_METHOD)
          .map((p) => (p as any).creditNote?.creditNoteNumber)
          .filter((n): n is string => !!n),
      ),
    );

    // F03/R9: see sendEmail's matching comment — the reminder renders the same item
    // table, so it honours the same hide-original-price setting.
    const hideOriginalPrice = (await this.systemConfig.get("invoice.hideOriginalPrice")) === "true";

    // See sendEmail's matching comment: a variable, not an inline literal, so the
    // extra fields don't trip TS's excess-property check ahead of email.service.ts's
    // param-type update landing in this same campaign batch.
    const reminderPayload = {
      to: recipientEmail,
      customerName: inv.customer?.businessName ?? "Customer",
      invoiceNumber: inv.invoiceNumber,
      invoiceId: inv.id,
      issueDate: formatDate(inv.issueDate),
      dueDate: formatDate(inv.dueDate),
      paymentTermsLabel: inv.paymentTermsLabel ?? undefined,
      total: Number(inv.total),
      totalPaid,
      creditApplied,
      advanceApplied,
      creditNoteNumbers,
      balanceDue,
      items: inv.items.map((it: any) => ({
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        subtotal: Number(it.subtotal),
        msrp: it.msrp != null ? Number(it.msrp) : null,
        // F03/R9: see sendEmail's matching comment — a reminder renders the same
        // item table, so it needs the same promo scalars.
        originalPrice: it.originalPrice != null ? Number(it.originalPrice) : null,
        priceType: it.priceType ?? null,
        promoFreeUnits: it.promoFreeUnits != null ? Number(it.promoFreeUnits) : null,
        ...invoiceItemQtyFields(it),
      })),
      pdfUrl,
      attachment,
      isReminder: true,
      hideOriginalPrice,
    };
    const sendResult = await this.emailService.sendInvoice(reminderPayload);

    if (!sendResult.delivered) {
      throw new BadRequestException({
        code: API_ERROR_CODES.EMAIL_SEND_FAILED,
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
   * Hand an invoice's wallet-funded payments back to the balances they came from:
   * credit notes via the credit-note restore primitive, advances by re-crediting
   * `AdvancePayment.balance` (mirroring voidPayment's inverse). Returns what moved
   * so the caller can report it.
   */
  async releaseWalletPaymentsInTx(tx: any, invoiceId: string) {
    const credits = await this.creditNotes.releaseInvoiceCreditsInTx(tx, invoiceId);

    // F03/R1: CONFIRMED (PAID) rows only. Advances have no meaningful DRAFT phase
    // (they're an internal wallet debit applied at record time, never a pending
    // bank entry), so this is a no-op for the common case and simply keeps this
    // site on the same predicate as every other money-summing read in this file.
    const advancePays = await tx.invoicePayment.findMany({
      where: {
        invoiceId,
        method: "ADVANCE" as any,
        ...CONFIRMED_PAYMENT,
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
   *  want the money back must call releaseWalletPaymentsInTx first.
   *
   * F03/R6/T-B84: the flip is an ATOMIC CLAIM — `updateMany` on a status guard,
   * abort on count===0 — mirroring returns.service's receive() claim shape
   * (:244-250). A plain `update()` has no way to express "someone else already
   * voided this row", so a double-click or a retried request let two concurrent
   * voids both "succeed" and both release invoicedQty.
   */
  async voidInvoiceInTx(tx: any, id: string, orderId: string | null) {
    const claimed = await tx.invoice.updateMany({
      where: { id, status: { not: InvoiceStatus.VOID } },
      data: { status: InvoiceStatus.VOID },
    });
    if (claimed.count === 0) {
      throw new ConflictException("Invoice was already voided.");
    }
    await this.adjustInvoicedQtyForInvoice(tx, id, orderId, -1);
    await this.ledger.reverseInvoiceEntries({ invoiceId: id, db: tx });
    // Sales agents & commissions: a voided invoice targets zero — this
    // emits the compensating CLAWBACK adjustment when commission was claimed.
    await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
    // F09/B66: a credit note's headroom dies with the invoice that justified it. Only the
    // UNUSED portion goes — spent credit paid real invoices and clawing it back would
    // corrupt them (R6). CreditNoteStatus enum, never the string literal, so the sibling
    // sweep's single-status `status: { not: "VOID" }` pattern doesn't match this fix.
    const sourced = await tx.creditNote.findMany({
      where: { invoiceId: id, status: { not: CreditNoteStatus.VOID } },
      select: { id: true, amount: true, amountUsed: true, invoiceId: true },
    });
    for (const cn of sourced) {
      // Defense-in-depth scoping: the query above already restricts to this invoice,
      // but the service itself — not only the query — must not touch a note it did
      // not source (T11).
      if (cn.invoiceId !== id) continue;
      const used = Number(cn.amountUsed ?? 0);
      await tx.creditNote.update({
        where: { id: cn.id },
        data:
          used <= 0.001
            ? { status: CreditNoteStatus.VOID }
            : // Capping amount to the used portion leaves zero headroom (amount - amountUsed
              // === 0) — the same "fully consumed" condition applyCreditInTx (:450-461) flips
              // to APPLIED, so a capped note must read APPLIED too, never a stale ISSUED.
              { amount: roundMoney(used), status: CreditNoteStatus.APPLIED },
      });
    }
    // Status already flipped to VOID by the claim above; return the fresh record.
    return tx.invoice.findUnique({ where: { id } });
  }

  async voidInvoice(id: string) {
    const inv = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: { payments: true },
    });
    if (!inv) throw new NotFoundException("Invoice not found");
    // #2255 / SA-404: fast pre-tx refusal; the tx re-checks it on the locked row.
    const refusal = voidRefusal(externalPaidOn(inv.payments ?? []));
    if (refusal) throw new BadRequestException(refusal);

    // Wrap in a transaction so the void + invoicedQty decrements are atomic.
    // We need to free up the qty on the source order so the operator can
    // re-split into multiple invoices after void — the user's "after delivering
    // an order, it should be possible to split it into multiple invoices"
    // scenario. The auto-create-on-DELIVERED captured all remaining qty; voiding
    // releases it so a fresh split can run.
    // #2255: re-run on a write conflict (SA-269); the claim in voidInvoiceInTx keeps it single.
    return retryOnTxConflict(`invoice void id=${id}`, () =>
      this.prisma.tenantTransaction(
        async (tx) => {
          // SA-404: FIRST statement — lock (Order →) Invoice, re-read payments, re-check the guard.
          const locked = await lockInvoiceRow(tx, id, inv.orderId);
          if (!locked) throw new NotFoundException("Invoice not found");
          const lockedRefusal = voidRefusal(externalPaidOn(locked.payments ?? []));
          if (lockedRefusal) throw new BadRequestException(lockedRefusal);
          // Wallet money first: a credit applied to this invoice goes back to its note
          // (spendable again) instead of being stranded on a dead invoice.
          await this.releaseWalletPaymentsInTx(tx, id);
          return this.voidInvoiceInTx(tx, id, inv.orderId);
        },
        // Serializable, matching the orders-side void caller (orders.service.ts ~:2770):
        // the default READ COMMITTED left a window between the cap's findMany/update pair
        // (below, in voidInvoiceInTx) where a concurrent applyToInvoice/settleOrderCreditsInTx
        // on a different invoice could raise a note's amountUsed, so the blind full-column
        // cap write could land at amount < amountUsed (F09 A5).
        { isolationLevel: "Serializable", timeout: 15_000 },
      ),
    );
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
      select: { id: true, productId: true, status: true, qty: true, invoicedQty: true },
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
      // #1185 round 5, item 3: never pick a CANCELLED line as the fallback target.
      const target = orderItems.find(
        (oi: any) => oi.productId === productId && oi.status !== "CANCELLED",
      );
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
    // Block if there are any LIVE payments. B314: a VOID (bounced) payment carries no money —
    // counting it here made a bounced check permanently block the revert with no way out.
    // This is an EXISTENCE check ("is any payment record still live?"), not a money sum — a
    // DRAFT payment must still block: it's an unconfirmed but real payment record sitting on
    // the invoice, and reverting out from under it would orphan it once it's later confirmed.
    // CONFIRMED_PAYMENT (status: "PAID" only) would be WRONG here — it would let an invoice
    // with an outstanding DRAFT payment revert.
    const paymentCount = await this.prisma
      .forTenant()
      // scan-ok: draft-payment-not-void — existence check, not a money sum; see comment above.
      .invoicePayment.count({ where: { invoiceId: id, status: { not: "VOID" } } });
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
   *
   * WP-D1 EXEMPTION (B1): a deposit mirror issued at ORDER PLACEMENT is SENT on
   * purpose and must survive an edit. Reverting it would be IRREVERSIBLE — a
   * pre-delivery order-linked DRAFT can never be re-sent (assertOrderInvoiceUnlocked
   * refuses without the create-path-only `allowPreDelivery` hatch), so the deposit
   * the customer was asked to pay would silently un-issue. It doesn't need reverting
   * either: reconcileOrderDraftInvoice's widened branch keeps exactly this invoice in
   * lockstep with the edit while it stays SENT. The exemption therefore mirrors that
   * branch's fence EXACTLY — deposit-carrying, the order's SOLE non-void invoice, and
   * the order not yet DELIVERED/CANCELLED — so an invoice is skipped here only when
   * the reconcile provably picks it up. Anything outside the fence (split/partial
   * siblings, a delivered order) keeps the legacy revert, including its
   * throw-on-payments guard.
   *
   * `opts.lockRows` takes the SAME Invoice row lock `recordPayment` holds before counting that
   * invoice's payments, so a payment cannot commit between the count and the DRAFT flip. It is
   * opt-in because only a caller already inside a transaction can hold it usefully, and because
   * the row is then held for the rest of that tx — the caller owns keeping Invoice last in the
   * lock order (`lockRowsNoWait`). Contention surfaces as a retryable 409 (NOWAIT), not a wait.
   */
  async revertLinkedInvoicesForOrderEdit(
    orderId: string,
    tx?: any,
    opts?: { lockRows?: boolean },
  ): Promise<string[]> {
    const db = tx ?? this.prisma.forTenant();
    // #2178: the ONE selection (incl. the exempt deposit mirror, which stays SENT) — shared with the
    // inline-return preflight, which prices against the matching set as it will be after this revert.
    const linked = await selectEditRevertedInvoices(db, orderId);
    const reverted: string[] = [];
    for (const inv of linked) {
      // Under the caller's tx: hold the row before the count, so the payment-block below reads a
      // state no concurrent recordPayment can change until this tx commits or rolls back.
      if (opts?.lockRows) await lockRowsNoWait(db, "Invoice", [inv.id], "INVOICE_BUSY");
      // B314: same live-payments filter as revertInvoiceToDraft — a VOID (bounced) payment
      // carries no money and must never block an edit that would otherwise revert cleanly.
      // Existence check, not a money sum — see the identical note on revertInvoiceToDraft
      // above; a DRAFT payment must still block this edit.
      // scan-ok: draft-payment-not-void — see comment above.
      const paymentCount = await db.invoicePayment.count({
        where: { invoiceId: inv.id, status: { not: "VOID" } },
      });
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
    unitAware.assertNoUnitAwareLines(inv.items, "duplicated"); // the copy drops the unit
    // F-05: a copy is a new sale of every catalog line it carries.
    await this.sellingRestrictions.assertLinesSellable({
      tenantId: requireRestrictionTenantId(this.prisma.getTenantId()),
      customerId: inv.customerId,
      lines: catalogRestrictionLines(inv.items),
      channel: "STAFF",
    });

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
      taxRate: isNsfLine(i) ? 0 : i.taxRate, // #2656: the NSF line is never taxed, even when copied
      boxes: (i as any).boxes ?? null,
      pieces: (i as any).pieces ?? null,
      // The sale-time box size travels with the boxes/pieces: without it the copy depends on the LIVE
      // pack, and a client that rebuilds the line from it re-prices per piece (B644 sibling).
      unitsPerBox: (i as any).unitsPerBox ?? null,
      // Price markers and the per-line note travel too (a copy must not reset DISCOUNTED to STANDARD).
      originalPrice: (i as any).originalPrice != null ? Number((i as any).originalPrice) : null,
      priceType: (i as any).priceType ?? undefined, // undefined -> the schema default (STANDARD)
      notes: (i as any).notes ?? null,
      // BUY_N_GET_M snapshot travels with the copy — the subtotal is verbatim, and
      // without the snapshot the copy's first edit would re-price the line to full.
      promoFreeUnits: (i as any).promoFreeUnits ?? null,
      // MSRP is copied VERBATIM, not re-resolved — a duplicate must show what the
      // source line showed, never a live re-read of the (possibly since-changed)
      // product/customer MSRP.
      msrp: (i as any).msrp != null ? Number((i as any).msrp) : null,
      subtotal: roundMoney(Number(i.subtotal)),
      // RF-4/B297: category tax + regulated snapshots (incl. the rate trio) travel to the copy.
      trackedCategoryId: (i as any).trackedCategoryId ?? null,
      trackedSubcategoryId: (i as any).trackedSubcategoryId ?? null,
      categoryTaxAmount: roundMoney(Number((i as any).categoryTaxAmount ?? 0)),
      categoryTaxType: (i as any).categoryTaxType ?? null,
      categoryTaxRate:
        (i as any).categoryTaxRate != null ? Number((i as any).categoryTaxRate) : null,
      categoryPriceIncludesTax: (i as any).categoryPriceIncludesTax ?? null,
      // #2169 (SA-395): a duplicated NSF fee line is still a real system-written NSF line —
      // carried verbatim, like every other snapshot column above.
      systemKind: i.systemKind ?? null,
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
    // B89/L-047: stamp issueDate explicitly as UTC-midnight of today (tenant
    // calendar day) — every other issueDate write in this file holds this
    // invariant; omitting it here left it to whatever the schema default
    // (`now()`) resolves to, a real instant rather than a calendar stamp.
    const tenantDefaults = await this.resolveTenantInvoiceDefaults();
    const issueDate = startOfCalendarDay(new Date(), tenantDefaults.timezone);
    // The copy's due date runs from ITS issue date on the source's own terms — it had none, so a copy
    // could never become OVERDUE and never aged. A label that cannot drive a date is dropped WITH the date,
    // so `paymentTermsLabel` and `dueDate` always agree (finance.prisma invariant).
    const sourceTerms = String((inv as any).paymentTermsLabel ?? "").trim();
    const termDays = Object.prototype.hasOwnProperty.call(TERM_DAYS, sourceTerms)
      ? TERM_DAYS[sourceTerms]
      : null;
    const dueDate = termDays != null ? addCalendarDays(issueDate, termDays) : null;

    try {
      // B100/F16b: the number is reserved in reserveNext's OWN short transaction,
      // committed BEFORE the one below opens, so this transaction never holds the counter
      // row lock and never needs a second pooled connection (fix-round-2.md D1); a
      // failing insert therefore leaves a gap. `tx` auto-injects tenantId like forTenant().
      // duplicate() never receives a caller tx; if it ever does, reserve INSIDE it with
      // `generateInvoiceNumber(tenantId, tx)` per fix-round-2b.md D7.
      const invoiceNumber = await this.nextInvoiceNumber();
      return await this.prisma.tenantTransaction(async (tx: any) => {
        const copy = await tx.invoice.create({
          data: {
            invoiceNumber,
            customerId: inv.customerId,
            status: InvoiceStatus.DRAFT,
            issueDate,
            dueDate,
            subtotal,
            taxAmount: taxTotal,
            discount: invDiscount,
            shippingFee: shipping,
            total,
            notes: inv.notes,
            terms: inv.terms,
            // The "Net 30"-style label travels only when it drove the dueDate above (they must
            // agree). Deposit fields do NOT travel: a duplicate is a fresh invoice with its
            // own (unstarted) payment story, not a continuation of the source's deposit
            // schedule (out of scope: no InvoiceInstallment / deposit-aware statuses).
            paymentTermsLabel: dueDate ? sourceTerms : null,
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
        // B680: the copy's regulated lines get their own SALE rows, same path as create().
        if (itemsData.some((it) => it.trackedCategoryId != null))
          await this.writeCreatedInvoiceLedger(tx, copy);
        return copy;
      });
    } catch (err: any) {
      // B100/F16b (REG-B100-E): duplicate() had no P2002 catch — a concurrent
      // duplicate's unique-constraint hit propagated as a raw 500 instead of the
      // 409 every other mint site already returns (same message as :557-559).
      if (err?.code === "P2002")
        throw new ConflictException("Invoice number conflict — please retry.");
      throw err;
    }
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
      // B89/L-047: paidAt is a REAL instant (not a UTC-midnight calendar
      // stamp), so its day-window bounds are evaluated in the TENANT's own
      // timezone — never the host clock's `setHours`.
      const tenantDefaults = await this.resolveTenantInvoiceDefaults();
      where.paidAt = {};
      if (dateFrom)
        where.paidAt.gte = this.tenantCalendarDayStart(dateFrom, tenantDefaults.timezone);
      if (dateTo) where.paidAt.lte = this.tenantCalendarDayEnd(dateTo, tenantDefaults.timezone);
    }
    if (search) {
      where.OR = [
        { paymentNumber: { contains: search, mode: "insensitive" } },
        { reference: { contains: search, mode: "insensitive" } },
        { invoice: { customer: { businessName: { contains: search, mode: "insensitive" } } } },
      ];
    }

    // B169: `id` tiebreaker — paidAt/settledAt ties are common (bulk imports,
    // same-day batches), so a single-key orderBy leaves page order unstable.
    const sortDirection = sortDir === "asc" ? "asc" : "desc";
    const validSortFields: Record<string, any> = {
      paidAt: [{ paidAt: sortDirection }, { id: sortDirection }],
      settledAt: [{ settledAt: sortDirection }, { id: sortDirection }],
      amount: [{ amount: sortDirection }, { id: sortDirection }],
      createdAt: [{ createdAt: sortDirection }, { id: sortDirection }],
      paymentNumber: [{ paymentNumber: sortDirection }, { id: sortDirection }],
    };
    // m9: Object.hasOwn (not a bare index) so prototype keys — `constructor`,
    // `__proto__`, `toString`, `valueOf`… — can't resolve to an INHERITED value
    // and reach Prisma as a malformed orderBy (→ 500). Unknown OR inherited
    // falls back to the safe paidAt-desc default.
    const orderBy =
      sortBy && Object.hasOwn(validSortFields, sortBy)
        ? validSortFields[sortBy]
        : [{ paidAt: "desc" }, { id: "desc" }];

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

    // Summary: total received (PAID only) and advance balance. B421:
    // "received" is cash-only — a CREDIT_NOTE application never counts,
    // regardless of the caller's own `method` filter (if set, it narrows
    // further via AND; it can never widen this back to include CREDIT_NOTE —
    // filtering the LIST to credit-note rows must still show $0 received).
    const { method: whereMethod, ...summaryWhereRest } = where;
    const summaryWhere: any = {
      ...summaryWhereRest,
      status: "PAID",
      AND: [
        { method: RECEIVED_METHOD_FILTER },
        ...(whereMethod != null ? [{ method: whereMethod }] : []),
      ],
    };
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

  // Receipt/slip/check photos on a payment EVENT live in payment-image.ts (size ratchet).
  uploadPaymentImage(paymentId: string, buffer: Buffer, originalName: string, mimeType: string) {
    return uploadPaymentImage(this.paymentImageDeps(), paymentId, buffer, originalName, mimeType);
  }

  getPaymentImageUrl(paymentId: string) {
    return getPaymentImageUrl(this.paymentImageDeps(), paymentId);
  }

  deletePaymentImage(paymentId: string) {
    return deletePaymentImage(this.paymentImageDeps(), paymentId);
  }

  private paymentImageDeps(): PaymentImageDeps {
    return { prisma: this.prisma, storage: this.storage };
  }

  // ─── Payment recording ────────────────────────────────────────────────────

  async recordPayment(id: string, dto: RecordInvoicePaymentDto) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    if ((dto.method as any) === "CREDIT_NOTE" || (dto.method as any) === "ADVANCE") {
      throw new BadRequestException(
        "Use the dedicated 'Apply Credit Note' or 'Apply Advance Payment' actions for these methods so the source balance is properly debited.",
      );
    }
    // Refuse a null tenant BEFORE the transaction opens — same policy as sites
    // 2/3 (D3): a PAY number is never minted from the shared "singleton" row.
    const { tenantId, tenantShort } = this.requirePaymentTenant();
    return withAfterCommit(this.prisma, async (tx, after) => {
      // Lock the invoice row so concurrent payment requests serialize here
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;

      const inv = await tx.invoice.findUnique({
        where: { id },
        // PR-2 (check-payments B1 hardening, review-opus-v2 condition #6): fetches
        // every non-VOID row now, not just CONFIRMED — the capacity guard below
        // moves to remainingCapacity() (DRAFT+PAID, N4: capacity must count DRAFT,
        // closing a real double-book gap this narrower query previously masked),
        // while recomputeStatus below keeps reading CONFIRMED-only via sumConfirmed
        // — F03/R1 status discipline is unchanged. Feeds remainingCapacity()'s own
        // internal not-void filter; @routeflow/pricing deliberately exports no
        // Prisma "not void" filter (see remainingCapacity's docstring), so this is
        // the correct inline form, not a re-derived mirror.
        // scan-ok: draft-payment-not-void — see comment above.
        include: { payments: { where: { status: { not: "VOID" } } } },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      const refusal = paymentRefusal(inv.status); // #2472 (4): VOID and WRITTEN_OFF, like the others
      if (refusal) throw new BadRequestException(`Cannot record payment on ${refusal} invoice`);

      const total = Number(inv.total);
      const alreadyPaid = sumConfirmed(inv.payments);
      const remaining = remainingCapacity(total, inv.payments);
      const paymentStatus = dto.status ?? "PAID";
      const amount = roundMoney(dto.amount); // #2293: ONE rounded value — guard, write, status

      if (paymentStatus === "PAID") {
        if (remaining <= 0) {
          // PR-2 review (routeflow-Lead, 2026-09-16): `remaining` is capacity
          // (DRAFT+PAID+PENDING), so it can hit 0 while `alreadyPaid` (CONFIRMED
          // only) is still below the total — the invoice isn't actually fully
          // paid, its remaining capacity is reserved by unconfirmed payments.
          throw new BadRequestException(
            alreadyPaid >= total - 0.001
              ? "Invoice is already fully paid"
              : "Invoice's remaining balance is already reserved by unconfirmed payments",
          );
        }
        if (amount > remaining + 0.001)
          throw new BadRequestException(
            `Payment exceeds remaining balance of ${remaining.toFixed(2)}`,
          );
      }

      // Auto-generate payment number — use tenantId as the counter row key so
      // each tenant has its own independent sequence. Include a short tenant hash
      // in the payment number to avoid global @unique collisions across tenants.
      const counter = await tx.paymentCounter.upsert({
        where: { id: tenantId },
        update: { next: { increment: 1 } },
        // `tenantId` explicitly: the tx proxy injects it for a wrapped tx, but a
        // caller-supplied raw client would leave the counter row tenant-less.
        create: { id: tenantId, next: 2, tenantId },
      });
      const paymentNumber = `PAY-${tenantShort}-${String(counter.next - 1).padStart(4, "0")}`;

      const createdPayment = await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          // Never clamped: a post-dated check settles in the future.
          settledAt: dto.settledAt ? new Date(dto.settledAt) : null,
          bankCharges: roundMoneyOrNull(dto.bankCharges),
          status: paymentStatus as any,
          paymentNumber,
          checkStatus: dto.method === "CHECK" ? CheckStatus.RECORDED : null,
        },
      });

      const newPaid = paymentStatus === "PAID" ? alreadyPaid + amount : alreadyPaid;
      const newStatus =
        paymentStatus === "PAID"
          ? recomputeInvoiceStatus(newPaid, total, inv.dueDate, inv.status, tz)
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
      after.defer(this.gateway).emitInvoiceUpdated(this.prisma.getTenantId(), {
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
   * B663: per delivered order, ensure a finalized invoice exists — reconcile an open
   * DRAFT "pending mirror" onto the DELIVERED quantities, or a SENT deposit mirror,
   * else create a fresh DRAFT from the order. Body lives in `delivered-reconcile.ts`
   * (size-ratchet: this file has no headroom for it) — see that file for the full
   * rationale and the `reconcileOrderIds` param.
   */
  async reconcileDeliveredOrdersInTx(
    tx: any,
    orderIds: string[],
    reconcileOrderIds?: string[],
  ): Promise<void> {
    return reconcileDeliveredOrdersInTxImpl(
      {
        findOpenOrderDraft: this.findOpenOrderDraft.bind(this),
        createInvoiceFromOrder: this.createInvoiceFromOrder.bind(this),
        rebuildIssuedDepositMirrorOnDelivery: this.rebuildIssuedDepositMirrorOnDelivery.bind(this),
        reconcileOrderDeliveredInvoices: this.reconcileOrderDeliveredInvoices.bind(this),
      },
      tx,
      orderIds,
      reconcileOrderIds,
    );
  }

  /**
   * Record a driver-collected payment at stop completion, resolving the target
   * invoice(s) SERVER-side from the delivered orders. The mobile client cannot
   * supply an invoiceId (Order has no invoiceId scalar and the run/stop payload
   * never carries one), which is why every at-door payment silently vanished.
   * Runs INSIDE the caller's transaction so it is atomic with stop completion.
   *
   * B663: this no longer reconciles the delivered orders' invoices itself — see
   * `reconcileDeliveredOrdersInTx`, which the caller (`completeWithPayment`) runs
   * unconditionally before this, whether or not there is a payment to record. This
   * function applies the lump-sum across the orders' non-VOID invoices OLDEST-first
   * (base invoice before any regulated `-R#` split siblings), capped at each
   * invoice's remaining. Each application finalizes a DRAFT→SENT (recomputeStatus
   * treats DRAFT as terminal, so a payment on a still-DRAFT invoice would never move
   * it off DRAFT) and is recorded the canonical way — an InvoicePayment row +
   * recomputeStatus over the non-VOID payment sum, NEVER the (non-existent) `balance`
   * scalar the old completeWithPayment code tried to decrement.
   *
   * @param context optional `{ runId, stopId }` used only to tag a booked
   *          over-collection advance's `reference` (`RUN:<runId>:STOP:<stopId>`).
   * @returns `applied` (< amount only when the orders' invoices were already
   *          covered, or there is a residual over-collection) plus `excess` — the
   *          undropped remainder. When the delivered orders resolve to exactly one
   *          customer, `excess` is booked as an AdvancePayment (`advancePaymentId`
   *          set); a multi-customer stop books no advance (`advancePaymentId`
   *          null) and the caller keeps its warn for that case.
   */
  async recordDeliveryPaymentInTx(
    tx: any,
    after: AfterCommit, // #2175: the caller's queue — its transaction owns the flush
    orderIds: string[],
    amount: number,
    method: string,
    context?: { runId?: string; stopId?: string },
  ): Promise<{
    applied: number;
    invoiceIds: string[];
    paymentIds: string[];
    excess: number;
    advancePaymentId: string | null;
  }> {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    if (!(amount > 0) || orderIds.length === 0)
      return { applied: 0, invoiceIds: [], paymentIds: [], excess: 0, advancePaymentId: null };
    // CREDIT_NOTE/ADVANCE must debit a source balance (see recordPayment); a driver
    // at-door collection is never one of these (On-account sends amount 0), so
    // refuse to book a phantom payment rather than bypass the source debit.
    if (method === "CREDIT_NOTE" || method === "ADVANCE")
      return { applied: 0, invoiceIds: [], paymentIds: [], excess: 0, advancePaymentId: null };

    // Payable statuses — exclude terminal VOID/WRITTEN_OFF: a written-off bad debt
    // must not swallow the cash (recomputeStatus can't advance it), which would also
    // starve a live sibling since we apply oldest-first.
    // (shared with credit-notes.service.ts via invoice-status-sets.ts, F09/R3a)

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
    // NOTE: no early return when `invoices` is empty — the loop below is then a
    // no-op (`remaining` stays the full `amount`) and falls through to the tail,
    // where the whole collected amount becomes `excess` and is booked as an
    // advance via the order-lookup fallback below, instead of silently vanishing.

    // 3. Spread the lump-sum oldest-first, capped at each invoice's remaining.
    let remaining = roundMoney(amount);
    const invoiceIds: string[] = [];
    const paymentIds: string[] = [];
    for (const inv of invoices) {
      if (remaining <= 0.001) break;
      // Row-lock (like recordPayment) then read paid FRESH, so a concurrent
      // back-office payment on the same invoice can't also read 0 and over-collect.
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${inv.id} FOR UPDATE`;
      // SA-404f N1: the PAYABLE read above was taken before this lock — re-derive it under the lock.
      // An invoice voided / written off meanwhile is SKIPPED (the driver's cash goes to the next
      // invoice or the advance below), never written back over.
      const locked = await tx.invoice.findUnique({
        where: { id: inv.id },
        select: { status: true },
      });
      if (!locked || !(PAYABLE as string[]).includes(locked.status)) continue;
      inv.status = locked.status;
      // F03/R1: CONFIRMED (PAID) payments only.
      const priorPayments = await tx.invoicePayment.findMany({
        where: { invoiceId: inv.id, ...CONFIRMED_PAYMENT },
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

      const newStatus = recomputeInvoiceStatus(
        alreadyPaid + applyHere,
        total,
        inv.dueDate,
        baseStatus,
        tz,
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
      after.defer(this.gateway).emitInvoiceUpdated(this.prisma.getTenantId(), {
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

    // 4. Never drop a residual over-collection: whatever is left of the driver's
    // cash after applying to every payable invoice becomes `excess`. When the
    // delivered orders resolve to exactly one customer, book it as an
    // AdvancePayment against that customer's wallet (the office's manual
    // payments-modal flow does the same thing at :5028 — this mirrors that
    // shape). A multi-customer stop is an anomaly today's UI can't produce
    // deliberately, so it books no advance and the caller keeps its warn.
    const excess = roundMoney(remaining);
    let advancePaymentId: string | null = null;
    if (excess > 0.001) {
      // Same-customer resolution: prefer the payable invoices already loaded
      // above (covers the common "invoice(s) existed" path); only when there
      // were none to load (the :4576 zero-payable-invoice case) fall back to
      // the orders themselves so the whole amount still resolves a customer
      // instead of being discarded.
      const customerIds =
        invoices.length > 0
          ? new Set(invoices.map((i: any) => i.customerId))
          : new Set(
              (
                await tx.order.findMany({
                  where: { id: { in: orderIds } },
                  select: { customerId: true },
                })
              ).map((o: any) => o.customerId),
            );
      if (customerIds.size === 1) {
        const [customerId] = customerIds;
        const advance = await tx.advancePayment.create({
          data: {
            customerId,
            amount: excess,
            balance: excess,
            method: method as any,
            receivedAt: new Date(),
            reference: context?.runId ? `RUN:${context.runId}:STOP:${context.stopId}` : null,
            notes: `Driver at-door over-collection — collected ${amount}, applied ${roundMoney(amount - remaining)} to invoice(s) ${invoiceIds.join(",")}; orders ${orderIds.join(",")}.`,
          },
        });
        advancePaymentId = advance.id;
      }
      // size !== 1 (0 orders resolved, or a multi-customer anomaly): no advance
      // booked — the caller logs/warns on the returned `excess` instead.
    }
    return {
      applied: roundMoney(amount - remaining),
      invoiceIds,
      paymentIds,
      excess,
      advancePaymentId,
    };
  }

  /**
   * The one tenant policy every PAY site shares (D3): a payment number is only
   * ever minted from a counter row keyed on a NON-NULL tenantId — never from the
   * shared `"singleton"` row, which two tenants in that state would both mint
   * `PAY-SINGLE-0001` from and collide on the GLOBAL `InvoicePayment.paymentNumber`
   * unique. Reservation LIFETIME still differs by site: sites 1/2 mint on the
   * caller's transaction (hoisting would take a second pooled connection inside an
   * open tx — F16b — and would burn a number on every validation failure), site 3
   * reserves standalone before its tx.
   */
  private requirePaymentTenant(): { tenantId: string; tenantShort: string } {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new BadRequestException("A tenant context is required to record a payment.");
    }
    return { tenantId, tenantShort: tenantId.slice(0, 6).toUpperCase() };
  }

  /** Tenant-scoped `PAY-XXXX-####` sequence — mirrors recordPayment's counter. */
  private async nextPaymentNumberInTx(tx: any): Promise<string> {
    const { tenantId, tenantShort } = this.requirePaymentTenant();
    const counter = await tx.paymentCounter.upsert({
      where: { id: tenantId },
      update: { next: { increment: 1 } },
      // See recordPayment: explicit so a raw (unwrapped) tx client cannot land a
      // tenant-less counter row.
      create: { id: tenantId, next: 2, tenantId },
    });
    return `PAY-${tenantShort}-${String(counter.next - 1).padStart(4, "0")}`;
  }

  /**
   * Tenant-scoped `PAY-<tenantShort>-####` sequence for the standalone
   * (bulk-allocation) payment site — B269. Reserves `count` consecutive
   * numbers with a SHORT STANDALONE upsert on `this.prisma` (never `tx`),
   * committed BEFORE the caller opens its own payment transaction: a
   * rolled-back booking (e.g. a Stripe webhook redelivery whose allocation
   * fails validation) burns the reserved block instead of re-minting the same
   * number on retry — the permanent settlement stall
   * `cause-refutation.md` §2.3 describes. Never falls back to a "singleton"
   * counter: a null tenant is refused outright, matching sites 1/2's existing
   * `tenantShort` segment (never a bare `PAY-####`).
   */
  private async nextPaymentNumber(count = 1): Promise<{ tenantShort: string; start: number }> {
    const { tenantId, tenantShort } = this.requirePaymentTenant();
    const counter = await this.prisma.paymentCounter.upsert({
      where: { id: tenantId },
      // F6 (REG-B269-E, cause-ruling.md §2 D2 follow-up / findings #4 on run
      // 54): `tenantId` explicit on the UPDATE arm too, not just `create` —
      // every tenant that already recorded a payment before this helper
      // existed keeps a counter row at `id: tenantId` with `tenantId: NULL`,
      // and an update-only upsert never touches that column, so the comment
      // below's claim ("avoids the legacy shape backfill-legacy-tenant-ids.mjs
      // exists to repair") was false for the whole installed base — it only
      // held for a tenant minting its FIRST payment under this helper. This
      // repairs the row on first use going forward, same value either arm
      // takes since `id` already pins it to this tenant.
      update: { next: { increment: count }, tenantId },
      // `tenantId` explicitly: this upsert runs on the UNSCOPED client (it is
      // standalone, outside any tenant tx), so nothing injects the column the way
      // the tx proxy does for `upsert.create`. Without it the counter row lands
      // with tenantId NULL — the very legacy shape backfill-legacy-tenant-ids.mjs
      // exists to repair.
      create: { id: tenantId, tenantId, next: count + 1 },
    });
    return { tenantShort, start: counter.next - count };
  }

  async updatePayment(invoiceId: string, paymentId: string, dto: UpdatePaymentDto) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    if ((dto.method as any) === "CREDIT_NOTE" || (dto.method as any) === "ADVANCE") {
      throw new BadRequestException(
        "Cannot edit a payment to method CREDIT_NOTE or ADVANCE. Void this payment and apply the credit note / advance via the dedicated action.",
      );
    }
    return withAfterCommit(this.prisma, async (tx, after) => {
      // PR-2 (check-payments B1 hardening, review-opus-v2 finding m3): recordPayment
      // already row-locks the invoice before reading its payments; updatePayment had
      // no equivalent, so two concurrent edits could both read a stale remaining
      // balance and jointly overshoot the invoice total.
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
      const inv = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot edit payment on voided invoice");

      const payment = inv.payments.find((p) => p.id === paymentId);
      if (!payment) throw new NotFoundException("Payment not found");

      // F03/R5/T-B81: read the STORED method, not just the incoming dto — the same
      // guard deletePayment (:4653) and voidPayment (:4941) already have. Neither
      // sibling lets a CREDIT_NOTE/ADVANCE payment unwind any way but its dedicated
      // reversal path; updatePayment had no equivalent, so a PATCH with an
      // unrelated method (e.g. "CASH") silently rewrote the row with no balance
      // compensation, permanently orphaning the credit note's amountUsed / the
      // advance wallet's debit.
      if (
        ((payment.method as any) === "CREDIT_NOTE" || (payment.method as any) === "ADVANCE") &&
        dto.method !== payment.method
      ) {
        throw new ConflictException(
          `This payment is an applied ${
            payment.method === "CREDIT_NOTE" ? "credit note" : "advance"
          }. Void it and use the dedicated action instead so the source balance stays correct.`,
        );
      }

      const newPaymentStatus = dto.status ?? payment.status ?? "PAID";
      const amount = roundMoney(dto.amount); // #2293: ONE rounded value — guard, status, write

      // F03/R1: only a CONFIRMED (PAID) row funds the recomputed status — VOID and
      // DRAFT both contribute $0, mirroring recordPayment (:4415). Counting a DRAFT
      // here let an operator flip an invoice to PAID (and stamp paidAt) off money
      // nobody confirmed — either by editing an unconfirmed payment or by
      // un-confirming a real one — while sumConfirmed still reported the full
      // balance due: exactly the B11 damage class CONFIRMED_PAYMENT removes. The
      // remaining-balance guard below deliberately stays on the full amount so a
      // DRAFT still cannot be parked above the invoice total.
      const effectiveAmount = newPaymentStatus === "PAID" ? amount : 0;

      // F03/R1: the recomputed status still funds only off CONFIRMED (PAID)
      // payments — an unconfirmed DRAFT "other" payment must not inflate the
      // status any more than a VOID one.
      const otherPayments = inv.payments.filter((p) => p.id !== paymentId);
      const othersTotal = sumConfirmed(otherPayments);
      const total = Number(inv.total);
      // PR-2 (B1 hardening, review-opus-v2 condition #6): the remaining-balance
      // *guard* moves to remainingCapacity() (DRAFT+PAID+PENDING) — a DRAFT "other"
      // payment now also reserves capacity here, closing the same double-book gap
      // recordPayment's conversion closes, so this edit can no longer be parked
      // above what the invoice can actually hold once that DRAFT confirms.
      const capacity = remainingCapacity(total, otherPayments);
      if (newPaymentStatus !== "VOID" && amount > capacity + 0.001) {
        throw new BadRequestException(`Payment amount exceeds remaining balance`);
      }

      await tx.invoicePayment.update({
        where: { id: paymentId },
        data: {
          amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
          ...(dto.paidAt && { paidAt: new Date(dto.paidAt) }),
          // Key present = set or (null) clear; key absent = keep what is stored.
          ...(dto.settledAt !== undefined && {
            settledAt: dto.settledAt ? new Date(dto.settledAt) : null,
          }),
          ...(dto.bankCharges !== undefined && { bankCharges: roundMoneyOrNull(dto.bankCharges) }),
          status: newPaymentStatus,
        },
      });

      const newPaid = othersTotal + effectiveAmount;
      const newStatus = recomputeInvoiceStatus(newPaid, total, inv.dueDate, inv.status, tz);
      const updated = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      after.defer(this.gateway).emitInvoiceUpdated(this.prisma.getTenantId(), {
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
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    let imageKey: string | null = null;
    const updated = await withAfterCommit(this.prisma, async (tx, after) => {
      // PR-2 review (routeflow-Lead, 2026-09-16): same Invoice FOR UPDATE lock as
      // updatePayment/recordPayment, taken BEFORE touching the payment row, and in
      // the same order — deletePayment and voidPayment previously took no lock at
      // all, so a concurrent updatePayment/recordPayment on the same invoice could
      // deadlock against them (each waiting on a row the other already touched) or
      // simply race on a stale remaining-balance read.
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
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
      // scan-ok: draft-payment-not-void — a same-row already-VOID guard on the
      // payment being deleted, never a sibling sum/capacity check.
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

      // F03/R1: exclude the deleted payment and count only CONFIRMED (PAID)
      // survivors — a VOID (bounced) or unconfirmed DRAFT payment left on the
      // invoice must not be counted as paid and mis-recompute the status.
      const remaining = sumConfirmed(inv.payments.filter((p) => p.id !== paymentId));
      const total = Number(inv.total);
      const newStatus = recomputeInvoiceStatus(remaining, total, inv.dueDate, inv.status, tz);
      const updated = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
      after.defer(this.gateway).emitInvoiceUpdated(this.prisma.getTenantId(), {
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
    const early = writeOffRefusal(inv.status);
    if (early) throw new BadRequestException(early);
    // Sales agents & commissions: materially a no-op for money (payable
    // derives from payments, and WRITTEN_OFF releases nothing beyond cash
    // already collected) but wrapped atomically to refresh the accrual's
    // display status alongside the write-off.
    return this.prisma.tenantTransaction(async (tx) => {
      // #2472 (3): (Order →) Invoice locked FIRST and re-checked there — a void since the pre-read wins.
      const locked = await lockInvoiceRow(tx, id, inv.orderId);
      if (!locked) throw new NotFoundException("Invoice not found");
      const refused = writeOffRefusal(locked.status);
      if (refused) throw new BadRequestException(refused);
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
    return withAfterCommit(this.prisma, async (tx, after) => {
      // SA-608g (SA-214: Order -> Invoice -> CreditNote): read the invoice UNLOCKED only for its order,
      // lock the order, then the invoice (never the invoice first: adjustInvoicedQtyForInvoice writes the
      // order's items below, so Invoice -> Order would invert SA-214 against an order-edit sync), and
      // RE-READ under the lock. Once the invoice is locked, a reissue's mint (KEY SHARE on it) waits, so
      // the sourced-note reads below cannot miss a note that commits in between and be SET NULL orphaned.
      const peek = await tx.invoice.findUnique({ where: { id }, select: { orderId: true } });
      if (!peek) throw new NotFoundException("Invoice not found");
      if (peek.orderId)
        await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${peek.orderId} FOR UPDATE`;
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
      const inv = await tx.invoice.findUnique({
        where: { id },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      // The order was locked from the PEEK. If the link moved since (no writer re-points it today:
      // only A -> null), adjustInvoicedQtyForInvoice below would write an order we never locked.
      if (inv.orderId !== peek.orderId)
        throw new ConflictException({
          code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
          message: "The invoice changed while it was being deleted. Try again.",
        });

      if (inv.payments.length > 0) {
        throw new BadRequestException(
          "Cannot delete an invoice that has recorded payments. Remove all payments first, or void the invoice.",
        );
      }

      // B214 (REG-B214): refuse while a credit note this invoice sourced still has spendable
      // balance — deleting would orphan it (invoiceId → null) as provenance-less wallet money.
      // Runs before any write, on rows read through this tx (L-081).
      await assertNoUnspentSourcedCredits(tx, [id]);

      // Free up invoicedQty on the source order BEFORE deleting the invoice
      // items (we read them inside the helper). Otherwise a delete leaves the
      // source order's lines flagged as fully invoiced with no surviving
      // record of why — operator can never split again.
      await this.adjustInvoicedQtyForInvoice(tx, id, inv.orderId, -1);

      // W5: reverse this invoice's regulated ledger rows before the invoice + its
      // items are deleted (the ledger keeps its own snapshot; append-only, no FK).
      await this.ledger.reverseInvoiceEntries({ invoiceId: id, db: tx });

      // Unlink the remaining (closed) credit notes this invoice sourced, marking each (#2848).
      await unlinkSourcedCredits(
        tx,
        [{ id, invoiceNumber: inv.invoiceNumber }],
        this.prisma.getTenantId(),
      );

      // Delete line items
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });

      // Sales agents & commissions: throws ConflictException (409) if any
      // accrual on this invoice has claimedAmount > 0 — a zero-payment SENT
      // invoice can still carry claimed commission, so the delete must be
      // guarded, not silently strand/destroy the accrual.
      await this.commissionEngine.removeInvoiceCommission(id, tx);

      // Delete the invoice (also detaches orderId reference)
      await tx.invoice.delete({ where: { id } });

      // #2142 W1: a deleted DRAFT was never issued, so its number and total stay on the
      // operators' feed; the customer's room (the buyer portal) hears only of issued invoices.
      after.defer(this.gateway).emitInvoiceUpdated(
        this.prisma.getTenantId(),
        {
          invoiceId: id,
          invoiceNumber: inv.invoiceNumber,
          customerId: inv.customerId,
          status: "DELETED" as any,
          total: Number(inv.total),
        },
        { customerRoom: inv.status !== InvoiceStatus.DRAFT },
      );

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
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    const paymentGroupId = randomUUID();
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    // One bank date for the whole allocation group — the money landed once.
    const settledAt = dto.settledAt ? new Date(dto.settledAt) : null;
    const status = dto.status ?? "PAID";
    // B769 / SA-112: rounded totals, and Σ allocations ≤ payment — refused before any write.
    const { excess } = standaloneAllocationTotals(dto);

    // Standalone reservation, committed BEFORE the payment tx opens (B269): a
    // rolled-back booking burns the reserved block instead of re-minting the
    // same number on retry, and a null tenant is refused instead of falling
    // back to the shared "singleton" counter (which is how two tenants' first
    // settlements used to collide on the GLOBAL paymentNumber unique).
    const { tenantShort, start } = await this.nextPaymentNumber(dto.allocations.length);

    // #2472 (1): a multi-invoice payment can deadlock (40P01) with completeWithPayment — re-run it.
    return retryOnTxConflict(`standalone payment group=${paymentGroupId}`, () =>
      this.prisma.tenantTransaction(async (tx) => {
        // B311: the buyer/online path's anti-overpay guard reads the invoice's balance and
        // THEN checks it — with no row lock between the two, a concurrent office payment on the
        // same invoice could commit in between, and this check would still pass against the
        // STALE balance it already read, overpaying the invoice exactly like B310's wallet race.
        // Lock every allocation's invoice FIRST, all in ONE statement in id-sorted order —
        // Opus review (F39): taking them one at a time inside the loop below (in whatever order
        // the caller's `allocations` array happens to list them) would let two concurrent
        // multi-allocation calls acquire the same two rows in opposite orders and deadlock
        // (db-locks.ts's "take rows in a consistent order" rule). Plain blocking `FOR UPDATE`,
        // not the house `lockRowsNoWait` NOWAIT primitive: the competing office payment takes NO
        // explicit lock of its own — it just INSERTs an InvoicePayment, which only holds `FOR KEY
        // SHARE` on the parent Invoice row — and `FOR NO KEY UPDATE` does NOT conflict with `FOR
        // KEY SHARE`, so NOWAIT here would not actually exclude that writer; `FOR UPDATE` does.
        // SA-404f F1: now UNCONDITIONAL, and Order → Invoice (SA-214) — every standalone payment,
        // not only the buyer path, reads its invoices' status under the lock a void also takes.
        await lockInvoicesForPayment(
          tx,
          dto.allocations.map((a) => a.invoiceId),
        );

        const payments: any[] = [];
        for (let i = 0; i < dto.allocations.length; i++) {
          const alloc = dto.allocations[i];
          const paymentNumber = `PAY-${tenantShort}-${String(start + i).padStart(4, "0")}`;

          // Validate invoice belongs to customer and is not voided. F03/R1:
          // CONFIRMED (PAID) rows only feed the balance check below.
          const invoice = await tx.invoice.findFirst({
            where: { id: alloc.invoiceId, customerId: dto.customerId },
            include: { payments: { where: CONFIRMED_PAYMENT } },
          });
          if (!invoice)
            throw new NotFoundException(`Invoice ${alloc.invoiceId} not found for customer`);
          const refused = paymentRefusal(invoice.status); // SA-404f F1: on the LOCKED row
          if (refused) throw new BadRequestException(`Invoice ${alloc.invoiceId} is ${refused}`);
          if (opts?.assertAllocationsWithinBalance) {
            const alreadyPaid = sumConfirmed(invoice.payments);
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
              amount: roundMoney(alloc.amount),
              method: dto.method as any,
              paidAt,
              settledAt,
              bankCharges: roundMoneyOrNull(dto.bankCharges),
              reference: dto.reference,
              notes: dto.notes,
              status: status as any,
              paymentNumber,
              paymentGroupId,
              checkStatus: dto.method === "CHECK" ? CheckStatus.RECORDED : null,
            },
          });
          payments.push(payment);

          // #2255 / SA-404d R2: EVERY payment updates its Invoice row in this tx, unconditionally — a
          // PENDING/DRAFT payment is blocking money too, and the real UPDATE takes the row lock, so a
          // concurrent void conflicts (40001) and its retry re-reads it (the #2258 writer invariant).
          let invoiceData: Prisma.InvoiceUpdateInput = { updatedAt: new Date() };
          if (status === "PAID") {
            // F03/R1: CONFIRMED (PAID) rows only feed recomputeStatus.
            const allPayments = await tx.invoicePayment.findMany({
              where: { invoiceId: alloc.invoiceId, ...CONFIRMED_PAYMENT },
            });
            const totalPaid = sumConfirmed(allPayments);
            const newStatus = recomputeInvoiceStatus(
              totalPaid,
              Number(invoice.total),
              invoice.dueDate,
              invoice.status,
              tz,
            );
            invoiceData = {
              status: newStatus,
              paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null,
            };
          }
          await tx.invoice.update({ where: { id: alloc.invoiceId }, data: invoiceData });
        }

        // Commission hook: the payments-modal / buyer-allocation path creates PAID
        // payments across many invoices — each one's payable must move with the
        // cash in the SAME tx (otherwise it lags until the reconciliation cron).
        for (const alloc of dto.allocations) {
          await this.commissionEngine.syncInvoiceCommissionSafe(alloc.invoiceId, tx);
        }

        // Handle excess amount → create AdvancePayment (rounded up front, SA-112)
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
      }),
    );
  }

  // ─── Void a single payment ────────────────────────────────────────────────

  async voidPayment(invoiceId: string, paymentId: string) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    return withAfterCommit(this.prisma, async (tx, after) => {
      // PR-2 review (routeflow-Lead, 2026-09-16): same Invoice FOR UPDATE lock as
      // updatePayment/recordPayment/deletePayment, taken BEFORE touching the
      // payment row, and in the same order — voidPayment previously took no lock
      // at all, so a concurrent updatePayment/recordPayment/deletePayment on the
      // same invoice could deadlock against it or race on a stale balance read.
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
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

      // Recompute invoice status treating this payment as $0. F03/R1: CONFIRMED
      // (PAID) rows only — an unconfirmed DRAFT payment left on the invoice must
      // not be counted as paid.
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          payments: { where: CONFIRMED_PAYMENT },
          order: { select: { routeRunId: true, routeRunStopId: true } },
        },
      });
      if (!invoice) throw new NotFoundException("Invoice not found");

      // B306: a driver's at-door over-collection on this stop is booked as an
      // AdvancePayment tagged RUN:<runId>:STOP:<stopId> (recordDeliveryPaymentInTx).
      // Once every confirmed door payment for the stop is voided, that advance
      // no longer reflects real collected money — reverse it too, or the run's
      // cash reconciliation keeps summing it forever.
      const runStopId = (invoice as any).order?.routeRunStopId;
      const runIdForAdvance = (invoice as any).order?.routeRunId;
      if (runStopId) {
        const remainingConfirmed = await tx.invoicePayment.count({
          where: { ...CONFIRMED_PAYMENT, invoice: { order: { routeRunStopId: runStopId } } },
        });
        if (remainingConfirmed === 0) {
          await this.reverseRunAdvancesInTx(tx, {
            runId: runIdForAdvance,
            stopId: runStopId,
            reason: "door payments voided",
          });
        }
      }

      const totalPaid = sumConfirmed(invoice.payments.filter((p) => p.id !== paymentId));
      const newStatus = recomputeInvoiceStatus(
        totalPaid,
        Number(invoice.total),
        invoice.dueDate,
        invoice.status,
        tz,
      );
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? invoice.paidAt : null,
        },
      });

      after.defer(this.gateway).emitInvoiceUpdated(this.prisma.getTenantId(), {
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
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    return withAfterCommit(this.prisma, async (tx, after) => {
      // PR-2 review (routeflow-Lead, 2026-09-16): same Invoice FOR UPDATE lock as
      // recordPayment/updatePayment/deletePayment/voidPayment, taken BEFORE
      // touching the payment row, and in the same order — setCheckStatus
      // previously took no lock at all, so a BOUNCED transition racing a
      // concurrent void or edit on the same invoice could deadlock against it.
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
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
        after.defer(this.gateway).emitInvoiceUpdated(this.prisma.getTenantId(), {
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
      // scan-ok: draft-payment-not-void — a single-row (id-scoped) CAS guard,
      // never a sibling sum/capacity check.
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

      // F03/R1: CONFIRMED (PAID) payments only.
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: { where: CONFIRMED_PAYMENT } },
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
            // #2169 (SA-395): the ONE writer of systemKind. Every consumer that needs to know
            // "is this the NSF fee line" reads it via the shared predicate (invoices/nsf-line.ts),
            // never by re-matching the description prefix above.
            systemKind: InvoiceItemSystemKind.NSF_FEE,
          },
        });
        newSubtotal = roundMoney(newSubtotal + fee);
        newTotal = roundMoney(newTotal + fee);
      }

      const totalPaid = sumConfirmed(invoice.payments.filter((p) => p.id !== paymentId));
      const newStatus = recomputeInvoiceStatus(
        totalPaid,
        newTotal,
        invoice.dueDate,
        invoice.status,
        tz,
      );
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

      after.defer(this.gateway).emitInvoiceUpdated(this.prisma.getTenantId(), {
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
      // B89/L-047: paidAt is a REAL instant, so its day-window bounds are
      // evaluated in the TENANT's own timezone — same convention as
      // listAllPayments above.
      const tenantDefaults = await this.resolveTenantInvoiceDefaults();
      where.paidAt = {};
      if (dateFrom)
        where.paidAt.gte = this.tenantCalendarDayStart(dateFrom, tenantDefaults.timezone);
      if (dateTo) where.paidAt.lte = this.tenantCalendarDayEnd(dateTo, tenantDefaults.timezone);
    }
    if (search) {
      where.OR = [
        { paymentNumber: { contains: search, mode: "insensitive" } },
        { reference: { contains: search, mode: "insensitive" } },
        { invoice: { customer: { businessName: { contains: search, mode: "insensitive" } } } },
      ];
    }

    // B169: `id` tiebreaker — same convention as listAllPayments above.
    const sortDirection = sortDir === "asc" ? "asc" : "desc";
    const validSortFields: Record<string, any> = {
      paidAt: [{ paidAt: sortDirection }, { id: sortDirection }],
      settledAt: [{ settledAt: sortDirection }, { id: sortDirection }],
      amount: [{ amount: sortDirection }, { id: sortDirection }],
      createdAt: [{ createdAt: sortDirection }, { id: sortDirection }],
      paymentNumber: [{ paymentNumber: sortDirection }, { id: sortDirection }],
    };
    // m9: Object.hasOwn (not a bare index) so prototype keys — `constructor`,
    // `__proto__`, `toString`, `valueOf`… — can't resolve to an INHERITED value
    // and reach Prisma as a malformed orderBy (→ 500). Unknown OR inherited
    // falls back to the safe paidAt-desc default.
    const orderBy =
      sortBy && Object.hasOwn(validSortFields, sortBy)
        ? validSortFields[sortBy]
        : [{ paidAt: "desc" }, { id: "desc" }];

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

    return buildPaymentsCsv(rows);
  }

  // ─── Cron ─────────────────────────────────────────────────────────────────

  // ─── Retroactive Price Adjustment ─────────────────────────────────────────

  async applyPriceAdjustment(
    id: string,
    dto: { items: { itemId: string; newUnitPrice: number }[]; scope: string; sinceDate?: string },
  ) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: the tenant's due day, once per call
    const invoice = await this.prisma.forTenant().invoice.findUnique({
      where: { id },
      // F03/R4: CONFIRMED (PAID) payments only — feeds the status recompute below.
      include: { items: true, payments: { where: CONFIRMED_PAYMENT } },
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
    // units_v1: a bulk price is keyed by productId (a Case price would land on pack lines). The
    // SINGLE scope only re-prices this invoice's own lines in place, off each line's own numbers.
    if (dto.scope !== "SINGLE") {
      unitAware.assertNoUnitAwareLines(invoice.items, "re-priced across invoices");
    }
    // #2392 (d) / SA-478: the NSF bounce-fee line is a system charge, never re-priced by hand.
    const nsfIds = new Set(invoice.items.filter((li) => isNsfLine(li)).map((li) => li.id));
    if (dto.items.some((i) => nsfIds.has(i.itemId))) {
      throw new BadRequestException(
        "The NSF fee line can't be re-priced. Void the bounce or issue a credit note instead.",
      );
    }

    // F03/R3: category (excise) tax follows the customer's exemption exactly like
    // the regular sales tax — foldCategoryTax zeroes every line's snapshot at creation
    // for an exempt customer, so the per-line recompute below must PRESERVE that zero
    // rather than re-derive a levy the customer does not owe. ALL_CUSTOMER_SINCE only
    // ever targets this same customer's invoices, so one read covers every target.
    const adjustmentCustomer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { id: invoice.customerId }, select: { isTaxExempt: true } });
    const isTaxExempt = !!(adjustmentCustomer as any)?.isTaxExempt;

    // Build a map of itemId → newUnitPrice for quick lookup
    const priceMap = new Map(dto.items.map((i) => [i.itemId, i.newUnitPrice]));

    // Build a map of itemId → productId from this invoice's items (used for bulk scope)
    const productIdMap = new Map(invoice.items.map((li) => [li.id, li.productId]));

    // Helper: update items on a single invoice and recalculate totals
    const applyToInvoice = async (
      inv: typeof invoice,
      localPriceMap: Map<string, number>,
      onCommitted?: () => void, // bulk: the tx committed (SA-651 MED-1), before the post-commit syncs
    ) => {
      const auditLine = `[${new Date().toLocaleDateString()} — Price adjusted by operator]`;

      // B294 (SA-141): a legacy order/estimate-derived invoice (every line taxRate 0, a real
      // regular tax) keeps its tax — the inferred flat rate is stamped onto its lines first, in the
      // SAME transaction as the re-price below (B662: item writes, totals and ledger commit together).
      // B662 (N-1/N-2): the status guard, the lines and the payments are all re-read UNDER the Invoice
      // lock (lockInvoiceForPriceAdjustment), and the writes are built from THOSE lines.
      // B662: item writes, invoice totals and the regulated-ledger sync commit or fail TOGETHER.
      await this.prisma.tenantTransaction(async (tx: any) => {
        const live = await lockInvoiceForPriceAdjustment(tx, inv); // Invoice FIRST, then its rows
        const inferred = inferredGoodsFlatRate({ ...live, lines: live.items }); // #2656: goods only
        const { categoriesById, unitsPerBoxByProduct } = await loadPriceAdjustmentReference(
          tx,
          live.items,
          localPriceMap,
        );
        const itemUpdates = buildPriceAdjustmentUpdates({
          items: live.items,
          localPriceMap,
          categoriesById,
          unitsPerBoxByProduct,
          isTaxExempt,
        });
        assertAdjustedTotalsSane(live, itemUpdates); // B1031: totals stay sane, before any write
        if (inferred?.verified) {
          await tx.invoiceItem.updateMany({
            where: { invoiceId: inv.id, taxRate: 0, AND: [notNsfLineWhere] }, // #2243: NSF stays 0
            data: { taxRate: inferred.rate },
          });
        }
        for (const u of itemUpdates)
          await tx.invoiceItem.update({ where: { id: u.id }, data: u.data });
        await commitPriceAdjustment({
          inv: live,
          itemUpdates,
          auditLine,
          tx,
          recomputeStatus: (p, t, d, st) => recomputeInvoiceStatus(p, t, d, st, tz),
          ledger: this.ledger,
          resync: (...a) => this.resyncInvoiceLedger(...a),
        });
      });
      onCommitted?.();
      // Sales agents & commissions: still OUTSIDE the transaction above on purpose (B662 wrapped only
      // the invoice + ledger writes). Pass no tx; the Safe wrapper opens its own transaction, and the
      // hourly reconciliation cron heals the gap if the process dies mid-loop.
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
        // F03/R4: CONFIRMED (PAID) payments only — feeds the status recompute below.
        include: { items: true, payments: { where: CONFIRMED_PAYMENT } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], // B1058: applied / skipped follow a stable order
      });

      const plans: Array<{ inv: typeof invoice; localMap: Map<string, number> }> = [];
      for (const inv of targetInvoices) {
        // Build itemId → newUnitPrice for items whose productId matches
        const localMap = new Map<string, number>();
        for (const item of inv.items) {
          if (item.productId && !item.unitLabel && productPriceMap.has(item.productId)) {
            localMap.set(item.id, productPriceMap.get(item.productId)!);
          }
        }
        if (localMap.size > 0) plans.push({ inv, localMap });
      }
      // B1031/B1058: judge every target (bad line, totals, overpayment) BEFORE writing any.
      await preflightBulkPriceAdjustment(plans, isTaxExempt, this.prisma.forTenant());
      // SA-651 MED-1: each tx re-judges under its own lock; a race refusal is named, and a partial batch is reported.
      await applyBulkPriceAdjustment(plans, applyToInvoice);
    }

    return this.prisma.forTenant().invoice.findUnique({
      where: { id },
      include: { items: true, customer: { select: { id: true, businessName: true } } },
    });
  }
}
