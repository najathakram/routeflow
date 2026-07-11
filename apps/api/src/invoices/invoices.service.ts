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
import { computeLineSubtotal, roundMoney, normalizeBoxesPieces } from "../common/pricing";
import { redactUpsellForCustomer } from "../common/upsell-redaction";
import { InvoiceStatus, UserRole } from "@prisma/client";
import {
  CreateInvoiceDto,
  RecordInvoicePaymentDto,
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

const TERM_DAYS: Record<string, number> = {
  "Due on Receipt": 0,
  "Net 15": 15,
  "Net 30": 30,
  "Net 45": 45,
  "Net 60": 60,
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
  ) {}

  /** Resolve the tenant's default invoice terms and corresponding due-days offset. */
  async resolveDefaultTerms(): Promise<{ terms: string; dueDays: number }> {
    const stored = await this.systemConfig.get("invoice.defaultTerms");
    const terms = stored || "Net 30";
    return { terms, dueDays: TERM_DAYS[terms] ?? 30 };
  }

  /** Resolve the tenant's customer-facing invoice Notes and Terms & Conditions defaults. */
  private async resolveTenantInvoiceDefaults(): Promise<{
    notes: string | null;
    terms: string | null;
  }> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return { notes: null, terms: null };
    const cfg = await this.prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { invoiceNotes: true, invoiceTerms: true },
    });
    return { notes: cfg?.invoiceNotes ?? null, terms: cfg?.invoiceTerms ?? null };
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

    // Pre-fetch products for items that specify boxes/pieces so we can resolve qty
    const productIds = [
      ...new Set(
        dto.items
          .filter((i) => i.productId && (i.boxes != null || i.pieces != null))
          .map((i) => i.productId!),
      ),
    ];
    const products =
      productIds.length > 0
        ? await this.prisma.forTenant().product.findMany({ where: { id: { in: productIds } } })
        : [];
    const productMap = new Map(products.map((p) => [p.id, p]));

    let subtotal = 0;
    const itemsData = dto.items.map((item) => {
      let qty = item.qty;
      let boxes: number | null = null;
      let pieces: number | null = null;
      let unitsPerBox: number | undefined;
      if (item.productId && (item.boxes != null || item.pieces != null)) {
        const product = productMap.get(item.productId);
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
      const beforeDiscount = computeLineSubtotal({
        unitPrice: item.unitPrice,
        qty,
        boxes,
        pieces,
        unitsPerBox,
      });
      const lineSub = roundMoney(beforeDiscount - (item.discount ?? 0));
      subtotal += lineSub;
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
        tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
      };
    });
    subtotal = roundMoney(subtotal);

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
    const taxTotal = (customer as any).isTaxExempt
      ? 0
      : roundMoney(itemsData.reduce((sum, it) => sum + it.subtotal * (it.taxRate ?? 0), 0));
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
    let invoice: any;
    try {
      invoice = await this.prisma.forTenant().invoice.create({
        data: {
          invoiceNumber: await this.nextInvoiceNumber(),
          customerId: dto.customerId,
          status: InvoiceStatus.DRAFT,
          subtotal,
          taxAmount: taxTotal,
          discount: invDiscount,
          shippingFee: shipping,
          total,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          issueDate: dto.issueDate ? new Date(dto.issueDate) : new Date(),
          notes: dto.notes ?? tenantDefaults.notes,
          terms: dto.terms ?? tenantDefaults.terms,
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
   * inside completeStop()'s $transaction.
   *
   * RF-147: tenantId is now explicitly set on the Invoice record.  Previously
   * the create call omitted it, leaving invoices with tenantId=null which
   * bypassed all tenant-scoped queries.
   */
  async createInvoiceFromOrder(orderId: string, txClient?: any) {
    const db = txClient ?? this.prisma;

    // Fetch order with non-cancelled line items
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: { select: { name: true, unitsPerBox: true, trackedCategoryId: true } },
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
    const customer = await db.customer.findUnique({
      where: { id: order.customerId },
      select: { isTaxExempt: true },
    });

    const tenantId = this.prisma.getTenantId();
    // Due date from configured payment terms (e.g. "Net 30")
    const { terms: defaultTerms, dueDays } = await this.resolveDefaultTerms();
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueDays);
    // Customer-facing invoice Notes and T&C from tenant settings
    const tenantDefaults = await this.resolveTenantInvoiceDefaults();

    const extraInvoiceData: Record<string, any> = {
      dueDate,
      terms: tenantDefaults.terms ?? defaultTerms,
      issueDate: new Date(),
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
   * a full bill from scratch (prior 0, bill = qty), copies `S` verbatim.
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
      });
    } else {
      // Telescoping cumulative rounding — exact and drift-free across partials.
      subtotal = roundMoney(
        roundMoney((storedSubtotal * (prior + billQty)) / orderQty) -
          roundMoney((storedSubtotal * prior) / orderQty),
      );
    }

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
      categoryTaxAmount: Number(li.categoryTaxAmount ?? 0),
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
   * regular tax is allocated proportionally by subtotal with the LAST group
   * absorbing the rounding remainder, so Σ(group tax) == the single-invoice tax
   * exactly. Category tax (snapshotted per line) is added per group — currently
   * always 0 (guarded below), so siblings sum == the order total to the cent.
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

    // Interim guard: category tax is snapshotted but NOT yet folded into the ORDER
    // total, so a non-zero rate would make sibling totals exceed the order total
    // and break the split invariant. Block it explicitly until the order-total
    // follow-up ships. Tobacco (the only seeded category) is taxType=NONE/rate=0,
    // so no current tenant is affected.
    for (const g of groups) {
      if (g.category && g.category.taxType !== "NONE" && Number(g.category.rate) > 0) {
        throw new BadRequestException(
          `Category "${g.category.name}" has a non-zero tax rate; per-category tax on invoices is not enabled yet. Set its rate to 0 before invoicing it.`,
        );
      }
    }

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
      const categoryTax = roundMoney(
        itemsData.reduce((s: number, it: any) => s + Number(it.categoryTaxAmount ?? 0), 0),
      );
      return { g, itemsData, subtotal, categoryTax, regularTax: 0, taxAmount: 0, total: 0 };
    });

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
    groupData.forEach((gd) => {
      gd.taxAmount = roundMoney(gd.regularTax + gd.categoryTax);
      gd.total = roundMoney(gd.subtotal + gd.taxAmount);
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
            shippingFee: 0,
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
   */
  async reconcileOrderDraftInvoice(
    orderId: string,
    opts: { basis: "order" | "delivered"; tx?: any },
  ) {
    const db = opts.tx ?? this.prisma.forTenant();
    const draft = await this.findOpenOrderDraft(orderId, db);
    if (!draft) return null;

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: { select: { name: true, unitsPerBox: true, trackedCategoryId: true } },
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
    const subtotal = roundMoney(itemsData.reduce((s: number, it: any) => s + it.subtotal, 0));

    const customer = await db.customer.findUnique({
      where: { id: order.customerId },
      select: { isTaxExempt: true },
    });
    const orderSubtotal = Number(order.subtotal) || 1;
    const proportion = subtotal / orderSubtotal;
    const taxAmount = customer?.isTaxExempt ? 0 : roundMoney(Number(order.tax) * proportion);
    const total = roundMoney(
      subtotal - Number(draft.discount ?? 0) + Number(draft.shippingFee ?? 0) + taxAmount,
    );

    await db.invoiceItem.deleteMany({ where: { invoiceId: draft.id } });
    const updated = await db.invoice.update({
      where: { id: draft.id },
      data: {
        subtotal,
        taxAmount,
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
          unitPrice: Number(it.unitPrice),
          sample: it,
        };
        prev.qty += Number(it.qty);
        prev.subtotal += Number(it.subtotal);
        prev.unitPrice = Number(it.unitPrice); // most-recent line wins for display
        prev.sample = it;
        byTarget.set(key, prev);
      }
    }

    let subtotal = 0;
    for (const agg of byTarget.values()) {
      const existing = agg.line;
      const lineSubtotal = roundMoney(agg.subtotal);
      subtotal += lineSubtotal;
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
    // drift); mirror updateOrderItems' total = subtotal + tax convention.
    subtotal = roundMoney(subtotal);
    const prevSubtotal = Number(order.subtotal) || 0;
    const effectiveTaxRate = prevSubtotal > 0 ? Number(order.tax) / prevSubtotal : 0;
    const tax = roundMoney(subtotal * effectiveTaxRate);
    const total = roundMoney(subtotal + tax);
    await db.order.update({ where: { id: orderId }, data: { subtotal, tax, total } });
    return { orderId, subtotal, tax, total };
  }

  /**
   * Fire-and-forget safe variant of createInvoiceFromOrder.
   * Accepts an explicit tenantId so it doesn't depend on AsyncLocalStorage
   * (which is lost when the call is not awaited in the request lifecycle).
   */
  async createInvoiceFromOrderWithTenant(orderId: string, tenantId: string | null) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, ...(tenantId ? { tenantId } : {}) },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: { select: { name: true, unitsPerBox: true, trackedCategoryId: true } },
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

    // RF-079: apply tax-exempt check in the fire-and-forget path too.
    const customerForTax = tenantId
      ? await this.prisma.customer.findFirst({
          where: { id: order.customerId, ...(tenantId ? { tenantId } : {}) },
          select: { isTaxExempt: true },
        })
      : null;

    // Resolve default terms — read SystemConfig with explicit tenantId since we're
    // outside the normal request context (fire-and-forget, no AsyncLocalStorage).
    let defaultTerms = "Net 30";
    let dueDays = 30;
    if (tenantId) {
      const cfg = await this.prisma.systemConfig.findFirst({
        where: { tenantId, key: "invoice.defaultTerms" },
        select: { value: true },
      });
      if (cfg?.value) {
        defaultTerms = cfg.value;
        dueDays = TERM_DAYS[defaultTerms] ?? 30;
      }
    }

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueDays);

    // Customer-facing invoice Notes and T&C from tenant settings
    let tenantNotes: string | null = null;
    let tenantTerms: string | null = null;
    if (tenantId) {
      const cfg = await this.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: { invoiceNotes: true, invoiceTerms: true },
      });
      tenantNotes = cfg?.invoiceNotes ?? null;
      tenantTerms = cfg?.invoiceTerms ?? null;
    }

    const extraInvoiceData: Record<string, any> = {
      dueDate,
      terms: tenantTerms ?? defaultTerms,
      issueDate: new Date(),
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
  async createPartialFromOrder(orderId: string, dto: CreatePartialInvoiceDto) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: {
          where: { status: { not: "CANCELLED" } },
          include: {
            product: { select: { name: true, unitsPerBox: true, trackedCategoryId: true } },
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

    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: order.customerId }, select: { isTaxExempt: true } });
    const orderSubtotal = Number(order.subtotal) || 1;
    const proportion = subtotal / orderSubtotal;
    const taxAmount = (customer as any)?.isTaxExempt
      ? 0
      : roundMoney(Number(order.tax) * proportion);
    const total = roundMoney(subtotal + taxAmount);

    // Resolve due date: explicit dto.dueDate wins, else default term.
    const { terms: defaultTerms, dueDays } = await this.resolveDefaultTerms();
    let dueDate: Date;
    if (dto.dueDate) {
      dueDate = new Date(dto.dueDate);
    } else {
      dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + dueDays);
    }

    const tenantDefaults = await this.resolveTenantInvoiceDefaults();
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
          shippingFee: 0,
          total,
          dueDate,
          terms: dto.terms ?? tenantDefaults.terms ?? defaultTerms,
          issueDate: new Date(),
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
      const paidAmount = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
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
      return { ...inv, balanceDue, paidAmount, isOverdue };
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
          include: { product: { select: { id: true, name: true, unit: true, unitsPerBox: true } } },
        },
        payments: { orderBy: { createdAt: "desc" } },
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
    const paidAmount = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
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
    return { ...inv, balanceDue, paidAmount, isOverdue };
  }

  async update(id: string, dto: Partial<CreateInvoiceDto>) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException("Only DRAFT invoices can be edited");
    await this.assertOrderInvoiceUnlocked(inv);

    if (dto.items) {
      await this.prisma.forTenant().invoiceItem.deleteMany({ where: { invoiceId: id } });

      // Pre-fetch products for boxes/pieces resolution
      const productIds = [
        ...new Set(
          dto.items
            .filter((i) => i.productId && (i.boxes != null || i.pieces != null))
            .map((i) => i.productId!),
        ),
      ];
      const products =
        productIds.length > 0
          ? await this.prisma.forTenant().product.findMany({ where: { id: { in: productIds } } })
          : [];
      const productMap = new Map(products.map((p) => [p.id, p]));

      let subtotal = 0;
      const itemsData = dto.items.map((item) => {
        let qty = item.qty;
        let boxes: number | null = null;
        let pieces: number | null = null;
        let unitsPerBox: number | undefined;
        if (item.productId && (item.boxes != null || item.pieces != null)) {
          const product = productMap.get(item.productId);
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
        const beforeDiscount = computeLineSubtotal({
          unitPrice: item.unitPrice,
          qty,
          boxes,
          pieces,
          unitsPerBox,
        });
        const lineSub = roundMoney(beforeDiscount - (item.discount ?? 0));
        subtotal += lineSub;
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
          tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
        };
      });
      subtotal = roundMoney(subtotal);
      const customerForTax = await this.prisma
        .forTenant()
        .customer.findUnique({ where: { id: inv.customerId }, select: { isTaxExempt: true } });
      // Tax from each line's stored post-discount subtotal (same basis as the line).
      const taxTotal = (customerForTax as any)?.isTaxExempt
        ? 0
        : roundMoney(itemsData.reduce((s, it) => s + it.subtotal * (it.taxRate ?? 0), 0));
      const invDiscount = dto.discount ?? Number(inv.discount);
      const shipping = dto.shippingFee ?? Number(inv.shippingFee);
      const total = roundMoney(subtotal - invDiscount + shipping + taxTotal);
      const updated = await this.prisma.forTenant().invoice.update({
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
          ...(dto.referenceNumber !== undefined && { referenceNumber: dto.referenceNumber }),
          ...(dto.subject !== undefined && { subject: dto.subject }),
          pdfUrl: null,
          items: { create: itemsData },
        },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: true,
        },
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
        ...(dto.referenceNumber !== undefined && { referenceNumber: dto.referenceNumber }),
        ...(dto.subject !== undefined && { subject: dto.subject }),
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
      .invoice.findUnique({ where: { id }, select: { id: true, status: true, shippedAt: true } });
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
    const order = await this.prisma.forTenant().order.findUnique({
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
    const updated = await this.prisma.forTenant().invoice.update({
      where: { id },
      data: { status: InvoiceStatus.SENT, sentAt: new Date() },
    });
    this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      customerId: updated.customerId,
      status: InvoiceStatus.SENT,
      total: Number(updated.total),
    });
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

    const recipientEmail = overrideEmail || inv.customer?.email;
    if (!recipientEmail)
      throw new BadRequestException(
        "No email address on file for this customer. Provide an email address.",
      );

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

    await this.emailService.sendInvoice({
      to: recipientEmail,
      customerName: inv.customer?.businessName ?? "Customer",
      invoiceNumber: inv.invoiceNumber,
      invoiceId: inv.id,
      issueDate: inv.issueDate
        ? new Date(inv.issueDate).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "",
      dueDate: inv.dueDate
        ? new Date(inv.dueDate).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "",
      total: Number(inv.total),
      items: inv.items.map((it: any) => ({
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        subtotal: Number(it.subtotal),
      })),
      pdfUrl,
      isReminder: false,
    });

    // Mark as SENT
    const updated = await this.prisma.forTenant().invoice.update({
      where: { id },
      data: { status: InvoiceStatus.SENT, sentAt: new Date() },
    });
    this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      customerId: updated.customerId,
      status: InvoiceStatus.SENT,
      total: Number(updated.total),
    });
    return { success: true, sentTo: recipientEmail };
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

    const recipientEmail = overrideEmail || inv.customer?.email;
    if (!recipientEmail)
      throw new BadRequestException(
        "No email address on file for this customer. Provide an email address.",
      );

    let pdfUrl: string | undefined;
    try {
      pdfUrl = await this.pdfService.getOrGenerate(id);
    } catch {
      /* non-critical */
    }

    await this.emailService.sendInvoice({
      to: recipientEmail,
      customerName: inv.customer?.businessName ?? "Customer",
      invoiceNumber: inv.invoiceNumber,
      invoiceId: inv.id,
      issueDate: inv.issueDate
        ? new Date(inv.issueDate).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "",
      dueDate: inv.dueDate
        ? new Date(inv.dueDate).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "",
      total: Number(inv.total),
      items: inv.items.map((it: any) => ({
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        subtotal: Number(it.subtotal),
      })),
      pdfUrl,
      isReminder: true,
    });

    return { success: true, sentTo: recipientEmail };
  }

  async voidInvoice(id: string) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status === InvoiceStatus.PAID)
      throw new BadRequestException("Cannot void a fully paid invoice");
    if (inv.status === InvoiceStatus.PARTIAL)
      throw new BadRequestException(
        "Cannot void an invoice with partial payments. Reverse or refund payments first.",
      );

    // Wrap in a transaction so the void + invoicedQty decrements are atomic.
    // We need to free up the qty on the source order so the operator can
    // re-split into multiple invoices after void — the user's "after delivering
    // an order, it should be possible to split it into multiple invoices"
    // scenario. The auto-create-on-DELIVERED captured all remaining qty; voiding
    // releases it so a fresh split can run.
    return this.prisma.tenantTransaction(async (tx) => {
      const voided = await tx.invoice.update({
        where: { id },
        data: { status: InvoiceStatus.VOID },
      });

      await this.adjustInvoicedQtyForInvoice(tx, id, inv.orderId, -1);
      // W5: reverse this invoice's regulated ledger rows so filings net to zero.
      await this.ledger.reverseInvoiceEntries({ invoiceId: id, db: tx });
      return voided;
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
    return this.prisma.forTenant().invoice.update({
      where: { id },
      data: { status: InvoiceStatus.DRAFT, sentAt: null, pdfUrl: null },
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

    return this.prisma.forTenant().invoice.update({
      where: { id },
      data: { status: InvoiceStatus.DRAFT, paidAt: null },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: { orderBy: { createdAt: "desc" } },
      },
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
      .customer.findUnique({ where: { id: inv.customerId }, select: { isTaxExempt: true } });

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
      subtotal: roundMoney(Number(i.subtotal)),
      tenantId: this.prisma.getTenantId(),
    }));
    const subtotal = roundMoney(itemsData.reduce((s, i) => s + Number(i.subtotal), 0));
    const taxTotal = (customer as any)?.isTaxExempt
      ? 0
      : roundMoney(itemsData.reduce((s, i) => s + Number(i.subtotal) * Number(i.taxRate ?? 0), 0));
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
      limit = 25,
      customerId,
      method,
      status,
      dateFrom,
      dateTo,
      search,
      sortBy,
      sortDir,
    } = query;
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

      await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          bankCharges: dto.bankCharges,
          status: paymentStatus as any,
          paymentNumber,
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
      return paid;
    });
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
      return updated;
    });
  }

  async deletePayment(invoiceId: string, paymentId: string) {
    return this.prisma.tenantTransaction(async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (inv.status === InvoiceStatus.VOID)
        throw new BadRequestException("Cannot delete payment on voided invoice");

      const payment = inv.payments.find((p) => p.id === paymentId);
      if (!payment) throw new NotFoundException("Payment not found");

      await tx.invoicePayment.delete({ where: { id: paymentId } });

      const remaining = inv.payments
        .filter((p) => p.id !== paymentId)
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
      return updated;
    });
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
    return this.prisma.forTenant().invoice.update({
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

  async recordStandalonePayment(dto: StandalonePaymentDto) {
    const paymentGroupId = randomUUID();
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
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

        const payment = await tx.invoicePayment.create({
          data: {
            invoiceId: alloc.invoiceId,
            amount: alloc.amount,
            method: dto.method as any,
            paidAt,
            bankCharges: dto.bankCharges,
            reference: dto.reference,
            notes: dto.notes,
            status: status as any,
            paymentNumber,
            paymentGroupId,
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
      return { success: true };
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

    const header = "Payment#,Date,Customer,Invoice#,Method,Reference,Bank Charges,Amount,Status";
    const lines = rows.map((r: any) =>
      [
        escape(r.paymentNumber ?? ""),
        escape(r.paidAt ? new Date(r.paidAt).toISOString().split("T")[0] : ""),
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
      const taxAmount = roundMoney(
        updatedItems.reduce((s, li) => s + Number(li.subtotal) * Number(li.taxRate ?? 0), 0),
      );
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
