import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { Prisma, MovementType } from "@prisma/client";
import { costDecimal, nextAverageCost, reverseAverageCost } from "../inventory/costing";
import { roundMoney } from "../common/pricing";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { buildTokenWeights, composedProductName, matchLine } from "./product-matcher";
import {
  DuplicateMatchService,
  extractSupplierInvoiceNumber,
  normalizeInvoiceNumber,
  type VendorBillDuplicateMatch,
} from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { ProductAliasService, type AliasTarget } from "../import/product-alias.service";
import { matchSupplier } from "../import/supplier-match";
import { hashFile, lineFingerprint } from "./invoice-scan.fingerprint";
import { CheckVendorBillDuplicateDto } from "./dto/check-vendor-bill-duplicate.dto";
import { ReceiveVendorBillDto } from "./dto/receive-vendor-bill.dto";
import { SaveProductMappingDto } from "./dto/save-product-mapping.dto";

/** What clients render when a bill is blocked as a duplicate. */
export interface VendorBillDuplicatePayload {
  billId: string;
  billNumber: string;
  status: string;
  resumable: boolean;
  totalOwed: number;
  billDate: Date | null;
  receivedDate: Date | null;
  supplierName: string | null;
  itemCount: number;
  matchedBy: "number" | "fuzzy" | "lines";
  totalMatches: boolean;
}

/** One uploaded page. `fileName`/`size` are metadata only — the bytes are the document. */
export interface ScanInvoiceFile {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  size?: number;
}

/**
 * What happened the last time these exact bytes were uploaded. Returned instead
 * of a fresh extraction so a repeat upload is instant, free, and tells the
 * operator whether the document already became a bill.
 */
export interface PriorScanSummary {
  scanId: string;
  scannedAt: Date;
  status: string;
  vendorBillId: string | null;
  billNumber: string | null;
  supplierInvoiceNumber: string | null;
  total: number | null;
}

/** Phase-1 OCR model. Persisted with each scan, so the constant is the single source. */
const SCAN_MODEL = "claude-haiku-4-5";

/** Extension per accepted upload type — the stored key keeps the original bytes readable. */
const SCAN_FILE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

const INVOICE_SCAN_STATUSES = ["SCANNED", "POSTED", "DISCARDED", "DUPLICATE"] as const;

/** Promoted columns only — `extractedPayload` is far too large for a list response. */
const INVOICE_SCAN_LIST_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  pageCount: true,
  byteSize: true,
  fileKey: true,
  supplierNameRaw: true,
  supplierId: true,
  supplierInvoiceNumber: true,
  invoiceDate: true,
  subtotal: true,
  tax: true,
  total: true,
  lineCount: true,
  status: true,
  vendorBillId: true,
  scannedById: true,
  createdAt: true,
  supplier: { select: { id: true, name: true } },
  vendorBill: { select: { id: true, billNumber: true, status: true } },
} as const;

@Injectable()
export class VendorBillsService {
  private readonly logger = new Logger(VendorBillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly systemConfig: SystemConfigService,
    private readonly duplicateMatch: DuplicateMatchService,
    private readonly storage: StorageService,
    private readonly inventory: InventoryService,
    private readonly productAlias: ProductAliasService,
  ) {}

  /**
   * A bill line's INVENTORY denomination. Suppliers price lines in whatever
   * unit the invoice prints — usually CASES for boxed goods — while
   * `Product.currentStock` and `Product.averageCost` are contractually per
   * PIECE (common/pricing.ts `costPerSellingUnit`). A line with
   * `packSize > 1` is a case line: pieces = qty × packSize, per-piece cost =
   * unitCost ÷ packSize. The bill's own money is untouched — `totalOwed`
   * stays Σ qty × unitCost in invoice denomination, matching the printed
   * line totals. Receive, revert and void MUST all convert through this one
   * helper or reversals stop matching receipts.
   */
  private lineInventoryDelta(item: {
    qty: Prisma.Decimal | number | string;
    unitCost: Prisma.Decimal | number | string;
    packSize?: number | null;
  }): { qty: Prisma.Decimal; unitCost: Prisma.Decimal } {
    const rawQty = new Prisma.Decimal(item.qty as Prisma.Decimal.Value);
    const rawCost = costDecimal(item.unitCost);
    const pack = item.packSize ?? 0;
    if (pack > 1) {
      return { qty: rawQty.mul(pack), unitCost: costDecimal(rawCost.div(pack)) };
    }
    return { qty: rawQty, unitCost: rawCost };
  }

  /**
   * How much of a line has actually been received, in BILL denomination.
   * Null `qtyReceived` is ambiguous: on a bill received before per-line
   * tracking existed (receivedDate set, EVERY line null) it means fully
   * received; on a bill with tracking (any line non-null) it means that line
   * was never received. Receive, revert and void all read through this one
   * helper so top-ups and reversals stay consistent with what was applied.
   */
  private lineReceivedQty(
    bill: { receivedDate: Date | null; items: { qtyReceived: Prisma.Decimal | null }[] },
    item: { qty: Prisma.Decimal; qtyReceived: Prisma.Decimal | null },
  ): Prisma.Decimal {
    if (item.qtyReceived != null) return new Prisma.Decimal(item.qtyReceived);
    const tracked = bill.items.some((i) => i.qtyReceived != null);
    return bill.receivedDate != null && !tracked
      ? new Prisma.Decimal(item.qty)
      : new Prisma.Decimal(0);
  }

  private async nextBillNumber() {
    const year = new Date().getFullYear();
    const prefix = `BILL-${year}-`;
    const last = await this.prisma.forTenant().vendorBill.findFirst({
      where: { billNumber: { startsWith: prefix } },
      orderBy: { billNumber: "desc" },
    });
    const seq = last ? parseInt(last.billNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  async create(dto: any) {
    // supplierId is required when creating manually from the UI, but optional for import-created bills
    if (dto.requireSupplier !== false) {
      if (!dto.supplierId || typeof dto.supplierId !== "string" || dto.supplierId.trim() === "") {
        throw new BadRequestException("Please select a supplier before creating the bill.");
      }
    }
    const supplierId = dto.supplierId && dto.supplierId.trim() ? dto.supplierId.trim() : null;

    // Calculate totalOwed from line items if provided, otherwise use dto.totalOwed
    let totalOwed = dto.totalOwed ?? 0;
    if (dto.items && Array.isArray(dto.items) && dto.items.length > 0) {
      totalOwed = dto.items.reduce(
        (sum: number, item: any) =>
          sum + (Number(item.qty) || 1) * Number(item.unitCost ?? item.unitPrice ?? 0),
        0,
      );
    }
    // Sales tax on the supplier invoice is owed too (the scan flow passes it as
    // taxAmount — line items only carry the pre-tax unit costs). totalOwed is a
    // monetary write, so round it.
    totalOwed = roundMoney(totalOwed + (Number(dto.taxAmount) || 0));

    const supplierInvoiceNumber = this.resolveSupplierInvoiceNumber(dto);
    const billDate = this.parseDate(dto.billDate);

    // Re-scanning the same supplier invoice must not create a second bill (and
    // a second restock). Only checkable when the document is identifiable —
    // otherwise every plausible bill would be blocked.
    if (!dto.allowDuplicate && (supplierInvoiceNumber || (supplierId && billDate))) {
      const match = await this.duplicateMatch.findVendorBillDuplicate({
        supplierId,
        number: supplierInvoiceNumber,
        total: totalOwed,
        issueDate: billDate,
      });
      // A number match is document identity; a fuzzy match (supplier + date +
      // total, no number) is only a hint for a human — two separate same-day
      // deliveries from one supplier for the same amount are legitimate and must
      // stay enterable. `checkDuplicate` still reports the fuzzy hit so a client
      // can warn before the operator commits.
      if (match?.matchedBy === "number") {
        const duplicate = await this.toDuplicatePayload(match);
        throw new ConflictException({
          code: "DUPLICATE_VENDOR_BILL",
          message: this.duplicateMessage(supplierInvoiceNumber, match),
          duplicate,
        });
      }
    }

    if (!dto.allowDuplicate) {
      await this.assertNoPostedLineMatch(dto, totalOwed, supplierId ?? null);
    }

    const bill = await this.prisma.forTenant().vendorBill.create({
      data: {
        billNumber: await this.nextBillNumber(),
        ...(supplierId ? { supplierId } : {}),
        status: "DRAFT",
        totalOwed,
        ...(supplierInvoiceNumber ? { supplierInvoiceNumber } : {}),
        // Kept alongside totalOwed (which already includes the tax) so an edit
        // recomputing totals from line items can no longer silently drop them.
        taxAmount: this.moneyOrNull(dto.taxAmount),
        subtotal: this.moneyOrNull(dto.subtotal),
        billDate,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        notes: dto.notes,
        items:
          dto.items && dto.items.length > 0
            ? {
                createMany: {
                  data: dto.items.map((item: any) => ({
                    productId: item.productId || null,
                    description: item.description || item.name || "",
                    qty: new Prisma.Decimal(item.qty || 1),
                    unitCost: new Prisma.Decimal(item.unitCost ?? item.unitPrice ?? 0),
                    // Read off the invoice and previously discarded here. `sku`
                    // is what matches this line to a product on the next scan
                    // from the same supplier.
                    sku: item.sku || null,
                    packSize: Number.isFinite(Number(item.packSize))
                      ? Math.trunc(Number(item.packSize))
                      : null,
                    lineTotal: this.moneyOrNull(item.lineTotal),
                  })),
                },
              }
            : undefined,
      },
      include: {
        supplier: { select: { id: true, name: true } },
        items: {
          include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
        },
      },
    });

    await this.markScanPosted(dto.scanId, bill.id);

    return bill;
  }

  /** Round every monetary write; absent stays absent rather than becoming 0. */
  private moneyOrNull(value: unknown): Prisma.Decimal | null {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? new Prisma.Decimal(roundMoney(n)) : null;
  }

  /**
   * Block a bill whose line numbers exactly repeat a scan that was already
   * posted. This is the layer that covers documents whose printed invoice
   * number was never legible — the number guard above can say nothing about
   * them, and until now nothing else could either.
   *
   * Identity-grade, so it is allowed to block: the same quantities at the same
   * unit costs summing to the same total is the same document. A VOID or
   * deleted bill never blocks — voiding is how an operator undoes a bad post.
   */
  private async assertNoPostedLineMatch(
    dto: any,
    totalOwed: number,
    supplierId: string | null,
  ): Promise<void> {
    const fingerprint = await this.resolveLineFingerprint(dto, totalOwed);
    if (!fingerprint) return;

    const priorScan = await this.duplicateMatch.findScanDuplicate({
      lineFingerprint: fingerprint,
      supplierId,
    });
    if (
      !priorScan ||
      priorScan.matchedBy !== "lines" ||
      priorScan.status !== "POSTED" ||
      !priorScan.vendorBillId ||
      priorScan.id === dto.scanId
    ) {
      return;
    }

    const match = await this.vendorBillMatchById(priorScan.vendorBillId, totalOwed);
    if (!match) return;
    throw new ConflictException({
      code: "DUPLICATE_VENDOR_BILL",
      message: this.duplicateMessage(priorScan.supplierInvoiceNumber, match),
      duplicate: await this.toDuplicatePayload(match),
    });
  }

  /**
   * A scan's own stored fingerprint when the bill came from one, so two scans
   * of the same paper are compared on values computed identically at scan time.
   * Hand-keyed bills fall back to the lines in front of us — best-effort, since
   * a typed total includes tax the scan may have recorded separately.
   */
  private async resolveLineFingerprint(dto: any, totalOwed: number): Promise<string | null> {
    if (dto.scanId) {
      const scan = await this.prisma
        .forTenant()
        .invoiceScan.findUnique({
          where: { id: dto.scanId },
          select: { lineFingerprint: true },
        })
        .catch(() => null);
      if (scan?.lineFingerprint) return scan.lineFingerprint;
    }
    const lines = (dto.items ?? []).map((item: any) => ({
      qty: item.qty ?? 1,
      unitCost: item.unitCost ?? item.unitPrice ?? 0,
    }));
    return lineFingerprint(lines, totalOwed);
  }

  /** The bill behind a posted scan, as the duplicate matcher would report it. */
  private async vendorBillMatchById(
    billId: string,
    total: number,
  ): Promise<VendorBillDuplicateMatch | null> {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id: billId },
      select: {
        id: true,
        billNumber: true,
        status: true,
        totalOwed: true,
        billDate: true,
        receivedDate: true,
        supplierId: true,
        _count: { select: { items: true } },
      },
    });
    if (!bill || bill.status === "VOID") return null;
    const totalOwed = Number(bill.totalOwed);
    return {
      id: bill.id,
      billNumber: bill.billNumber,
      status: bill.status,
      totalOwed,
      billDate: bill.billDate ?? null,
      receivedDate: bill.receivedDate ?? null,
      supplierId: bill.supplierId ?? null,
      itemCount: bill._count.items,
      matchedBy: "lines",
      totalMatches: Math.abs(totalOwed - total) <= 0.005,
    };
  }

  /**
   * Close the loop from bill back to the document it came from. A bad or
   * foreign scanId must not fail a bill that is already written — `updateMany`
   * stays tenant-scoped and simply matches nothing.
   */
  private async markScanPosted(scanId: string | undefined, vendorBillId: string): Promise<void> {
    if (!scanId) return;
    try {
      await this.prisma.forTenant().invoiceScan.updateMany({
        where: { id: scanId },
        data: { status: "POSTED", vendorBillId },
      });
    } catch (e) {
      this.logger.error(`create: failed to mark scan ${scanId} POSTED: ${(e as Error).message}`);
    }
  }

  /**
   * Read-only duplicate probe for clients that want to warn before the operator
   * has finished keying a bill. Same matcher, same payload as the create guard.
   */
  async checkDuplicate(
    dto: CheckVendorBillDuplicateDto,
  ): Promise<{ duplicate: VendorBillDuplicatePayload | null }> {
    const number = this.resolveSupplierInvoiceNumber(dto);
    const supplierId = dto.supplierId?.trim() ? dto.supplierId.trim() : null;
    const billDate = this.parseDate(dto.billDate);
    const total = dto.total != null ? Number(dto.total) : null;

    if (!number && !(supplierId && billDate)) return { duplicate: null };

    const match = await this.duplicateMatch.findVendorBillDuplicate({
      supplierId,
      number,
      total,
      issueDate: billDate,
    });
    return { duplicate: match ? await this.toDuplicatePayload(match) : null };
  }

  /**
   * The supplier's own invoice number, normalized. The `notes` fallback keeps
   * clients that only send the "Supplier invoice #N" phrase (older web/mobile
   * bundles, and every row written before the column existed) inside the guard.
   */
  private resolveSupplierInvoiceNumber(dto: {
    supplierInvoiceNumber?: string | null;
    notes?: string | null;
  }): string | null {
    const raw = dto.supplierInvoiceNumber ?? extractSupplierInvoiceNumber(dto.notes);
    if (!raw) return null;
    const normalized = this.duplicateMatch.normalizeNumber(raw);
    return normalized.length > 0 ? normalized : null;
  }

  private parseDate(value?: string | Date | null): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  private async toDuplicatePayload(
    match: VendorBillDuplicateMatch,
  ): Promise<VendorBillDuplicatePayload> {
    const supplier = match.supplierId
      ? await this.prisma
          .forTenant()
          .supplier.findUnique({ where: { id: match.supplierId }, select: { name: true } })
      : null;
    return {
      billId: match.id,
      billNumber: match.billNumber,
      status: match.status,
      resumable: match.status === "DRAFT",
      totalOwed: match.totalOwed,
      billDate: match.billDate,
      receivedDate: match.receivedDate,
      supplierName: supplier?.name ?? null,
      itemCount: match.itemCount,
      matchedBy: match.matchedBy,
      totalMatches: match.totalMatches,
    };
  }

  /**
   * Clients that predate the structured `duplicate` payload surface
   * `response.data.message` verbatim, so the sentence has to stand alone.
   */
  private duplicateMessage(number: string | null, match: VendorBillDuplicateMatch): string {
    const document = number
      ? `Supplier invoice ${number}`
      : match.matchedBy === "lines"
        ? "An invoice with identical quantities and unit costs"
        : "This supplier invoice";
    return match.status === "DRAFT"
      ? `${document} is already saved as draft bill ${match.billNumber} — open it to finish receiving instead of creating a second bill.`
      : `${document} was already recorded as bill ${match.billNumber} — creating it again would double stock and amounts owed.`;
  }

  async update(id: string, dto: any) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({ where: { id } });
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status !== "DRAFT") {
      throw new BadRequestException("Only DRAFT bills can be edited. Revert to draft first.");
    }

    // Recalculate total if items are provided. Mirror create(): fold the
    // bill's tax back in and round — the old recompute dropped taxAmount on
    // the FIRST edit (the G4 "tax lost on edit" bug the taxAmount column was
    // added to make recoverable) and skipped roundMoney.
    let totalOwed: number | undefined;
    if (dto.items && Array.isArray(dto.items)) {
      const itemsTotal = dto.items.reduce(
        (sum: number, item: any) =>
          sum + (Number(item.qty) || 1) * Number(item.unitCost ?? item.unitPrice ?? 0),
        0,
      );
      const tax =
        dto.taxAmount !== undefined ? Number(dto.taxAmount) || 0 : Number(bill.taxAmount ?? 0);
      totalOwed = roundMoney(itemsTotal + tax);
    }

    return this.prisma.tenantTransaction(async (tx) => {
      // Delete existing items and recreate if items provided
      if (dto.items !== undefined) {
        await tx.vendorBillItem.deleteMany({ where: { vendorBillId: id } });
      }

      return tx.vendorBill.update({
        where: { id },
        data: {
          ...(dto.supplierId !== undefined && { supplierId: dto.supplierId }),
          ...(dto.billDate !== undefined && {
            billDate: dto.billDate ? new Date(dto.billDate) : null,
          }),
          ...(dto.dueDate !== undefined && { dueDate: dto.dueDate ? new Date(dto.dueDate) : null }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(dto.supplierInvoiceNumber !== undefined && {
            supplierInvoiceNumber: this.resolveSupplierInvoiceNumber({
              supplierInvoiceNumber: dto.supplierInvoiceNumber,
            }),
          }),
          ...(totalOwed !== undefined && { totalOwed }),
          ...(dto.items !== undefined && dto.items.length > 0
            ? {
                items: {
                  createMany: {
                    // Carry the scan-captured fields through the recreate —
                    // an edit used to silently drop sku/packSize/lineTotal,
                    // losing the case-size the receive conversion depends on.
                    data: dto.items.map((item: any) => ({
                      productId: item.productId || null,
                      description: item.description || item.name || "",
                      qty: new Prisma.Decimal(item.qty || 1),
                      unitCost: new Prisma.Decimal(item.unitCost ?? item.unitPrice ?? 0),
                      sku: item.sku || null,
                      packSize: item.packSize != null && item.packSize > 0 ? item.packSize : null,
                      lineTotal: item.lineTotal != null ? new Prisma.Decimal(item.lineTotal) : null,
                    })),
                  },
                },
              }
            : {}),
        },
        include: {
          supplier: { select: { id: true, name: true } },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
    });
  }

  async receive(id: string, dto?: ReceiveVendorBillDto, performedById?: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    // RF-084: idempotency guard — prevent double-receive doubling stock.
    // Guarded on receivedDate + per-line qtyReceived, NOT status: recordPayment
    // overwrites status to PAID/PARTIAL, so a status-only check let a paid bill
    // be received a second time (stock incremented twice, average cost blended
    // twice). A received bill may be received AGAIN only while per-line
    // tracking shows quantity still outstanding (partial-receipt top-up).
    const linked = bill.items.filter((i) => i.productId && i.product);
    const remainingOf = (item: (typeof bill.items)[number]) => {
      const remaining = new Prisma.Decimal(item.qty).sub(this.lineReceivedQty(bill, item));
      return remaining.gt(0) ? remaining : new Prisma.Decimal(0);
    };
    if (bill.receivedDate != null) {
      if (!linked.some((i) => remainingOf(i).gt(0))) {
        throw new ConflictException("Bill already received");
      }
    } else if (bill.status === "RECEIVED") {
      // Legacy rows: status defaulted to RECEIVED without a receivedDate.
      throw new ConflictException("Bill already received");
    }

    // Cost-integrity guard: unmapped lines don't update inventory or costs.
    // Warn-and-confirm rather than hard block — bills legitimately carry
    // non-inventory lines (freight, deposits). Clients catch code
    // UNLINKED_ITEMS, show the skipped lines, and retry acknowledged. First
    // receive event only — a top-up was already acknowledged once.
    const unlinkedItems = bill.items.filter((i) => !i.productId);
    if (
      bill.receivedDate == null &&
      !dto?.acknowledgeUnlinked &&
      (bill.items.length === 0 || unlinkedItems.length > 0)
    ) {
      throw new ConflictException({
        code: "UNLINKED_ITEMS",
        message:
          bill.items.length === 0
            ? "This bill has no line items, so receiving it will not update any inventory or costs."
            : "Some line items are not linked to a product and will not update inventory or costs.",
        unlinkedItems: unlinkedItems.map((i) => ({
          id: i.id,
          description: i.description,
          qty: Number(i.qty),
          unitCost: Number(i.unitCost),
        })),
      });
    }

    // The receive plan: explicit per-line quantities (partial receive), or the
    // full remaining quantity on every linked line when none were given.
    let plan: { item: (typeof bill.items)[number]; receiveQty: Prisma.Decimal }[];
    if (dto?.items) {
      if (dto.items.length === 0) throw new BadRequestException("No quantities to receive.");
      const seen = new Set<string>();
      plan = dto.items.map((req) => {
        const item = bill.items.find((i) => i.id === req.itemId);
        if (!item) throw new BadRequestException("A requested line is not on this bill.");
        if (seen.has(item.id)) {
          throw new BadRequestException(`"${item.description}" appears twice in the request.`);
        }
        seen.add(item.id);
        if (!item.productId || !item.product) {
          throw new BadRequestException(
            `"${item.description}" is not linked to a product — link it before receiving it.`,
          );
        }
        const receiveQty = new Prisma.Decimal(String(req.qty));
        const remaining = remainingOf(item);
        if (receiveQty.gt(remaining)) {
          throw new BadRequestException(
            `"${item.description}": receiving ${receiveQty.toString()} exceeds the ${remaining.toString()} still outstanding.`,
          );
        }
        return { item, receiveQty };
      });
    } else {
      plan = linked
        .map((item) => ({ item, receiveQty: remainingOf(item) }))
        .filter((p) => p.receiveQty.gt(0));
    }

    // Fully received once every linked line's cumulative receipt covers its
    // qty. Status stays a lossy display blend (recordPayment overwrites it);
    // receipt truth lives in receivedDate + per-line qtyReceived.
    const fullyReceived = linked.every((item) => {
      const adding = plan.find((p) => p.item.id === item.id)?.receiveQty ?? new Prisma.Decimal(0);
      return this.lineReceivedQty(bill, item).add(adding).gte(new Prisma.Decimal(item.qty));
    });

    const updated = await this.prisma.tenantTransaction(async (tx) => {
      // Sync inventory for each line in the plan. The whole block works in
      // INVENTORY denomination: lineInventoryDelta converts a case-priced line
      // (packSize > 1) to pieces + per-piece cost so Product.averageCost keeps
      // its per-PIECE contract (margins previously inflated by unitsPerBox²).
      const effectiveDate = bill.billDate ?? new Date();
      const restockedIds: string[] = [];
      for (const { item, receiveQty } of plan) {
        if (!item.productId || !item.product) continue;

        const { qty, unitCost } = this.lineInventoryDelta({
          qty: receiveQty,
          unitCost: item.unitCost,
          packSize: item.packSize,
        });

        // Read fresh state inside the tx so multi-line bills of the same
        // product compound correctly instead of using the pre-tx snapshot
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { currentStock: true, averageCost: true, costingMethod: true },
        });
        if (!product) continue;

        const newAvgCost = nextAverageCost(
          product.currentStock,
          product.averageCost,
          qty,
          unitCost,
        );
        // STANDARD keeps its operator-set cost — mirrors recordPurchase; bill
        // receive used to clobber it (G7).
        const updatesAverage = product.costingMethod !== "STANDARD";
        const stockAfter = product.currentStock.add(qty);

        // StockLot keeps FIFO/LIFO parity with manual purchases and PO receive
        await tx.stockLot.create({
          data: {
            productId: item.productId,
            purchaseDate: effectiveDate,
            qty,
            remainingQty: qty,
            unitCost,
            reference: bill.billNumber,
          },
        });

        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: MovementType.PURCHASE,
            quantity: qty,
            unitCost,
            avgCostAfter: updatesAverage ? newAvgCost : (product.averageCost ?? null),
            stockAfter,
            supplierId: bill.supplierId,
            reference: bill.billNumber,
            notes: `Auto-synced from vendor bill ${bill.billNumber}`,
            performedById: performedById ?? null,
            // Stamp the movement at the BILL date, matching the lot — a
            // backdated bill's cost snapshot must sit at the right point in
            // the ledger (the lot and the movement used to disagree).
            createdAt: effectiveDate,
          },
        });

        await tx.product.update({
          where: { id: item.productId },
          data: {
            currentStock: { increment: qty },
            ...(updatesAverage ? { averageCost: newAvgCost } : {}),
          },
        });

        // Backdated bill: later movements' snapshots (and possibly the
        // average) are now stale — replay the product, like recordPurchase.
        const newer = await tx.stockMovement.count({
          where: { productId: item.productId, createdAt: { gt: effectiveDate } },
        });
        if (newer > 0) await this.inventory.recomputeProductInTx(tx, item.productId);

        restockedIds.push(item.productId);
      }

      // Bill update LAST so the response's items carry the fresh qtyReceived.
      // Per-line receipt progress goes through the PARENT as nested updates:
      // items are created nested, so their tenantId is null and a direct
      // (tenant-scoped) vendorBillItem.update can't see them — the bill's own
      // tenant scope makes the nested write tenant-safe by construction.
      // receivedDate keeps the FIRST receipt's date across top-ups.
      const updatedBill = await tx.vendorBill.update({
        where: { id },
        data: {
          status: fullyReceived ? "RECEIVED" : "PARTIAL",
          receivedDate: bill.receivedDate ?? new Date(),
          items: {
            update: plan.map(({ item, receiveQty }) => ({
              where: { id: item.id },
              data: { qtyReceived: this.lineReceivedQty(bill, item).add(receiveQty) },
            })),
          },
        },
        include: {
          supplier: { select: { id: true, name: true } },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
        },
      });

      return { updatedBill, restockedIds };
    });

    // Bill receive is the main restock path — fire the same low-stock-cleared
    // alerts a manual purchase does (it never did).
    if (updated.restockedIds.length > 0) {
      this.inventory.fireStockAlerts([...new Set(updated.restockedIds)]);
    }

    return updated.updatedBill;
  }

  async revertToDraft(id: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
      },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    const allowedStatuses = ["RECEIVED", "PARTIAL"] as const;
    if (!(allowedStatuses as readonly string[]).includes(bill.status)) {
      throw new BadRequestException(
        `Only RECEIVED or PARTIAL bills can be reverted to DRAFT. Current status: ${bill.status}`,
      );
    }
    // A PARTIAL status can mean "partially PAID, never received" (recordPayment
    // overwrites status). Reversing a receipt that never happened would drain
    // real stock and corrupt the average — the receipt marker is receivedDate.
    if (bill.receivedDate == null) {
      throw new BadRequestException(
        "This bill was never received — there is no stock or cost to revert. Its payments keep it out of DRAFT.",
      );
    }

    return this.prisma.tenantTransaction(async (tx) => {
      // Reverse inventory for each product-linked item — in the SAME
      // inventory denomination receive() applied (case lines converted to
      // pieces + per-piece cost), and only the quantity ACTUALLY received
      // (partial receipts reverse partially), or the reversal stops matching
      // the receipt.
      for (const item of bill.items) {
        if (!item.productId) continue;

        const receivedQty = this.lineReceivedQty(bill, item);
        if (receivedQty.lte(0)) continue;
        const { qty, unitCost } = this.lineInventoryDelta({
          qty: receivedQty,
          unitCost: item.unitCost,
          packSize: item.packSize,
        });

        // Delete the stock movement created when this bill was received
        await tx.stockMovement.deleteMany({
          where: {
            productId: item.productId,
            reference: bill.billNumber,
            type: MovementType.PURCHASE,
          },
        });

        // Read current product state within the transaction for accurate AVCO reversal
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { currentStock: true, averageCost: true },
        });
        if (!product) continue;

        // Exact AVCO reversal; null ⇒ reversal empties stock — KEEP the
        // previous average so the product's cost basis survives the revert
        const reversedAvg =
          product.averageCost != null
            ? reverseAverageCost(product.currentStock, product.averageCost, qty, unitCost)
            : null;

        await tx.product.update({
          where: { id: item.productId },
          data: {
            currentStock: { decrement: qty },
            ...(reversedAvg !== null ? { averageCost: reversedAvg } : {}),
          },
        });
      }

      // Reverse the lots this bill created (one per received line)
      await this.reverseBillLots(tx, bill.billNumber);

      // Revert bill status to DRAFT and clear per-line receipt progress — the
      // bill is back to never-received. Nested updateMany, not a direct
      // vendorBillItem call: nested-created items have null tenantId, so the
      // tenant-scoped model method can't see them; the parent's scope can.
      return tx.vendorBill.update({
        where: { id },
        data: {
          status: "DRAFT",
          receivedDate: null,
          items: { updateMany: { where: {}, data: { qtyReceived: null } } },
        },
        include: {
          supplier: { select: { id: true, name: true } },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
    });
  }

  /**
   * Remove the StockLots a bill's receive created (reference = billNumber).
   * Untouched lots are deleted outright; partially-consumed lots can only
   * surrender what remains, so they are zeroed and annotated.
   */
  private async reverseBillLots(tx: Prisma.TransactionClient, billNumber: string) {
    const lots = await tx.stockLot.findMany({ where: { reference: billNumber } });
    for (const lot of lots) {
      const remaining = new Prisma.Decimal(lot.remainingQty);
      if (remaining.gte(new Prisma.Decimal(lot.qty))) {
        await tx.stockLot.delete({ where: { id: lot.id } });
      } else {
        const consumed = new Prisma.Decimal(lot.qty).sub(remaining);
        await tx.stockLot.update({
          where: { id: lot.id },
          data: {
            remainingQty: 0,
            notes: `${lot.notes ? `${lot.notes} ` : ""}(bill reversed; ${consumed.toString()} already consumed)`,
          },
        });
      }
    }
  }

  async voidBill(id: string, performedById?: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: { items: { include: { product: true } } },
    });
    if (!bill) throw new NotFoundException("Bill not found");

    // RF-085: reverse stock movements when voiding a bill that was actually
    // RECEIVED. Status alone can't tell — recordPayment overwrites it to
    // PAID/PARTIAL, so a paid-but-never-received bill used to get a phantom
    // reversal (negative adjustment draining stock that was never added).
    // receivedDate is the receipt marker.
    const needsReversal =
      (bill.status === "RECEIVED" || bill.status === "PARTIAL" || bill.status === "PAID") &&
      bill.receivedDate != null;
    if (needsReversal) {
      return this.prisma.tenantTransaction(async (tx) => {
        for (const item of bill.items) {
          if (!item.productId || !item.product) continue;
          // Same inventory denomination receive() applied — see
          // lineInventoryDelta — and only what was actually received.
          const receivedQty = this.lineReceivedQty(bill, item);
          if (receivedQty.lte(0)) continue;
          const { qty, unitCost } = this.lineInventoryDelta({
            qty: receivedQty,
            unitCost: item.unitCost,
            packSize: item.packSize,
          });

          const product = await tx.product.findUnique({
            where: { id: item.productId },
            select: { currentStock: true, averageCost: true },
          });
          if (!product) continue;

          // Exact AVCO reversal; null ⇒ keep the previous average (never zero
          // the cost basis just because the void drains stock)
          const reversedAvg =
            product.averageCost != null
              ? reverseAverageCost(product.currentStock, product.averageCost, qty, unitCost)
              : null;
          const stockAfter = product.currentStock.sub(qty);

          // Compensating stock movement with negative quantity
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              type: MovementType.ADJUSTMENT,
              quantity: qty.negated(),
              unitCost,
              avgCostAfter: reversedAvg ?? product.averageCost,
              stockAfter,
              supplierId: bill.supplierId,
              reference: bill.billNumber,
              notes: `Void reversal for vendor bill ${bill.billNumber}`,
              performedById: performedById ?? null,
            },
          });

          await tx.product.update({
            where: { id: item.productId },
            data: {
              currentStock: { decrement: qty },
              ...(reversedAvg !== null ? { averageCost: reversedAvg } : {}),
            },
          });
        }

        // Reverse the lots this bill created
        await this.reverseBillLots(tx, bill.billNumber);

        return tx.vendorBill.update({ where: { id }, data: { status: "VOID" as any } });
      });
    }

    return this.prisma
      .forTenant()
      .vendorBill.update({ where: { id }, data: { status: "VOID" as any } });
  }

  async findAll(
    supplierId?: string,
    status?: string,
    dateFrom?: string,
    dateTo?: string,
    search?: string,
    page = 1,
    limit = 20,
    needsMapping?: boolean,
  ) {
    const skip = (page - 1) * limit;
    // A DRAFT bill "needs mapping" when it has no line items at all (imported
    // bills) or any line not linked to a product — receiving it would skip
    // inventory/cost updates.
    const needsMappingOr = [{ items: { none: {} } }, { items: { some: { productId: null } } }];
    const where: any = {};
    if (supplierId) where.supplierId = supplierId;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.billDate = {};
      if (dateFrom) where.billDate.gte = new Date(dateFrom);
      if (dateTo) where.billDate.lte = new Date(dateTo + "T23:59:59.999Z");
    }
    if (search) {
      where.OR = [
        { billNumber: { contains: search, mode: "insensitive" } },
        { supplier: { name: { contains: search, mode: "insensitive" } } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }
    if (needsMapping) {
      where.status = "DRAFT";
      where.AND = [...(where.AND ?? []), { OR: needsMappingOr }];
    }
    const [data, total, needsMappingCount] = await Promise.all([
      this.prisma.forTenant().vendorBill.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          payments: { orderBy: { createdAt: "desc" }, take: 1 },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.forTenant().vendorBill.count({ where }),
      this.prisma.forTenant().vendorBill.count({ where: { status: "DRAFT", OR: needsMappingOr } }),
    ]);
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit), needsMappingCount },
    };
  }

  async findOne(id: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: {
        supplier: true,
        payments: { orderBy: { createdAt: "desc" } },
        items: {
          include: {
            // Widened ONLY here (not the list endpoint, not other write
            // sites) so the bill detail page can tell whether a mapped
            // product has variants and show a "Generic — split into
            // variants?" affordance. Additive fields only — response shape
            // stays backward-compatible for every other consumer.
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                unit: true,
                parentProductId: true,
                // ACTIVE children only: the badge invites a split, and stock
                // can only ever be assigned to an active variant — counting
                // deactivated ones would offer the affordance on a generic
                // whose only variant is deleted.
                _count: { select: { variants: { where: { isActive: true } } } },
              },
            },
          },
        },
      },
    });
    if (!bill) throw new NotFoundException("Vendor bill not found");
    return bill;
  }

  // ─── Product Mapping Memory ───────────────────────────────────────────────────

  /**
   * `ProductMapping`'s compound key (`@@unique([supplierName, rawDescription])`)
   * has NO tenantId — it is a GLOBAL key. An `upsert` on that key can hit
   * another tenant's row: tenant B correcting the same (supplier,
   * description) pair as tenant A either 500s on the collision or silently
   * overwrites A's mapping. Go tenant-scoped instead: look up this tenant's
   * own row first, update it by id if found, otherwise attempt a create and
   * swallow ONLY a P2002 on that create (another tenant already holds the
   * global key) — log it and return gracefully rather than 500 the
   * operator's correction. Any other error still rethrows.
   */
  async saveProductMapping(supplierName: string, rawDescription: string, productId: string | null) {
    // Prisma DROPS `undefined` filter keys, so a missing supplierName or
    // rawDescription would turn the lookup below into "this tenant's FIRST
    // mapping" and then repoint an unrelated raw description at the wrong
    // product. The controller's `SaveProductMappingDto` rejects that at the
    // HTTP boundary; this keeps every other caller honest too.
    if (typeof supplierName !== "string" || typeof rawDescription !== "string") {
      throw new BadRequestException("supplierName and rawDescription are required");
    }
    const existing = await this.prisma.forTenant().productMapping.findFirst({
      where: { supplierName, rawDescription },
    });
    let mapping: any;
    if (existing) {
      mapping = await this.prisma.forTenant().productMapping.update({
        where: { id: existing.id },
        data: { productId },
      });
    } else {
      const data: SaveProductMappingDto = { supplierName, rawDescription, productId };
      try {
        mapping = await this.prisma.forTenant().productMapping.create({ data });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          this.logger.debug(
            `saveProductMapping: P2002 on create for (${supplierName}, ${rawDescription}) — another tenant already holds this global mapping key`,
          );
          mapping = null;
        } else {
          throw e;
        }
      }
    }

    // Dual-write into ProductAlias — tenant-scoped and normalized, the
    // eventual replacement for the legacy global-keyed table above — but
    // ONLY when the supplier name actually resolves to a real Supplier. The
    // scan flow must NEVER learn under the "" any-supplier scope: that scope
    // is reserved for batch-import's own any-supplier aliases, and writing
    // there from an unresolved-supplier correction would let it wrongly
    // answer for every other supplier too. Clearing a match (productId null)
    // unlearns instead of learning null.
    const supplierId = await this.resolveSupplierId(supplierName);
    if (supplierId) {
      if (productId) {
        await this.productAlias.learn(supplierId, rawDescription, { productId });
      } else {
        await this.productAlias.unlearn(supplierId, rawDescription);
      }
    }

    return mapping;
  }

  async getProductMappings(supplierName: string) {
    return this.prisma.forTenant().productMapping.findMany({
      where: { supplierName },
      include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
    });
  }

  /** Resolve a supplier's raw scanned name to a real Supplier via the shared scorer. */
  private async resolveSupplierId(supplierRaw: string | null | undefined): Promise<string | null> {
    if (!supplierRaw) return null;
    const suppliers = await this.prisma.forTenant().supplier.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    return matchSupplier(supplierRaw, suppliers)?.id ?? null;
  }

  /**
   * Phase-2 server-side matching: resolve the supplier's raw name to a real
   * Supplier, then match every line against three tiers in priority order —
   * a learned `ProductAlias` (this supplier, falling back to the ""
   * any-supplier scope), the legacy `ProductMapping` table, then the fuzzy
   * composed-name matcher. Runs on BOTH the fresh-scan path and a re-scanned
   * cache hit (see `rematchPriorScan`) so a just-taught alias applies on the
   * very next scan of the same document.
   */
  private async matchItems(
    supplierRaw: string | null | undefined,
    items: any[],
  ): Promise<{ supplierId: string | null; items: any[] }> {
    const supplierId = await this.resolveSupplierId(supplierRaw);

    const [products, allMappings, aliasMap] = await Promise.all([
      this.prisma.forTenant().product.findMany({
        select: {
          id: true,
          name: true,
          sku: true,
          barcode: true,
          unitSku: true,
          parentProductId: true,
          parent: { select: { name: true } },
        },
      }),
      this.prisma.forTenant().productMapping.findMany({
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              barcode: true,
              parentProductId: true,
              parent: { select: { name: true } },
            },
          },
        },
      }),
      this.productAlias.resolveMany(
        supplierId,
        items.map((item) => item.extractedName ?? ""),
      ),
    ]);

    // Build mapping index keyed by supplierName → rawDescription (lowercase)
    const mappingIndex: Record<
      string,
      Record<string, { productId: string | null; productName: string | null }>
    > = {};
    for (const m of allMappings) {
      if (!mappingIndex[m.supplierName]) mappingIndex[m.supplierName] = {};
      mappingIndex[m.supplierName][m.rawDescription.toLowerCase()] = {
        productId: m.productId,
        productName: m.product ? composedProductName(m.product) : null,
      };
    }

    const supplierName = supplierRaw ?? "";
    const supplierMappings = supplierName ? (mappingIndex[supplierName] ?? {}) : {};

    // Rarity-weighted token weights over the composed catalog names — computed
    // once for the whole scan, reused per line.
    const weights = buildTokenWeights(products);

    const matched = items.map((item) => {
      const raw: string = item.extractedName ?? "";
      const rawLower = raw.toLowerCase();

      // 0. Learned alias — tenant-scoped and normalized, takes priority over
      //    the legacy mapping tier below. Supplier-specific beats the ""
      //    any-supplier fallback (resolveMany already applied that order).
      const aliasTarget: AliasTarget | undefined = aliasMap.get(raw);
      if (aliasTarget?.productId) {
        const product = products.find((p) => p.id === aliasTarget.productId);
        return {
          ...item,
          matchedProductId: aliasTarget.productId,
          matchedProductName: product ? composedProductName(product) : null,
          confidence: "high",
          matchSource: "alias",
        };
      }

      // 1. Exact mapping hit (learned from previous corrections) — learned
      //    mappings stay authoritative, no candidates.
      if (supplierMappings[rawLower]?.productId) {
        const m = supplierMappings[rawLower];
        return {
          ...item,
          matchedProductId: m.productId,
          matchedProductName: m.productName,
          confidence: "high",
          matchSource: "memory",
        };
      }

      // 2-3. Composed-name / rarity-weighted fuzzy matching against the catalog.
      const match = matchLine(raw, item.sku ?? null, products, weights);
      return { ...item, ...match };
    });

    return { supplierId, items: matched };
  }

  /**
   * Extract a supplier invoice, and keep every part of it: the document, the
   * verbatim model output, and the keys that identify it. The scan was
   * previously stateless — abandoning a review lost the extraction and the
   * spend, and nothing recorded that a document had been seen at all.
   *
   * Re-uploading bytes already scanned returns the stored payload WITHOUT
   * calling the model: instant, free, and the strongest duplicate signal there
   * is. Neither persistence nor storage may fail the scan — by the time either
   * runs the operator's document has already been read, and that is the part
   * worth keeping.
   */
  async scanInvoice(files: ScanInvoiceFile[], scannedById?: string) {
    const fileHash = hashFile(files.map((f) => f.buffer));
    const prior = await this.findScanByHash(fileHash);
    if (prior) return this.rematchPriorScan(prior);

    // Look up API key: DB-stored key takes precedence over env var
    const storedKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey =
      storedKey && storedKey.length > 0
        ? storedKey
        : this.configService.get<string>("ANTHROPIC_API_KEY");
    if (!apiKey || apiKey.length === 0) {
      throw new BadRequestException(
        "AI invoice scanning is not available. Please contact your system administrator to configure the ANTHROPIC_API_KEY.",
      );
    }

    // ── Phase 0: Normalise inputs ─────────────────────────────────────────────
    // Multi-page invoices arrive as N images (HEIC from iPhone, JPEG, PNG, etc.)
    // or one PDF. HEIC isn't a Claude vision media type, so convert it to JPEG
    // server-side with sharp before sending. PDFs go through as-is via the
    // `document` content block.
    const fileContentBlocks: any[] = [];
    const skippedPages: number[] = [];
    for (let pageNo = 0; pageNo < files.length; pageNo++) {
      const f = files[pageNo];
      const isPdf = f.mimeType === "application/pdf";
      if (isPdf) {
        fileContentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: f.buffer.toString("base64"),
          },
        });
        continue;
      }
      // HEIC / HEIF → JPEG via sharp (libvips). Strip orientation metadata via
      // .rotate() so iPhone photos show right-side up to Claude.
      const isHeic = f.mimeType === "image/heic" || f.mimeType === "image/heif";
      let buf = f.buffer;
      let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" = f.mimeType as any;
      if (isHeic) {
        try {
          buf = await sharp(f.buffer).rotate().jpeg({ quality: 85 }).toBuffer();
          mediaType = "image/jpeg";
        } catch (e) {
          // One unreadable page must not discard the readable ones — skip it
          // and disclose the gap in the result notes.
          this.logger.error(`scanInvoice: HEIC→JPEG conversion failed: ${(e as Error).message}`);
          skippedPages.push(pageNo + 1);
          continue;
        }
      }
      fileContentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: buf.toString("base64"),
        },
      });
    }
    if (fileContentBlocks.length === 0) {
      throw new BadRequestException(
        "Couldn't read any of the uploaded images. Try exporting them as JPEG and re-uploading.",
      );
    }

    // Phase 1 uses Haiku — cheap OCR, no catalog reasoning required at this step.
    // maxRetries:0 — the SDK's default retry (2, each getting its own fresh
    // 110s window) would let a single scan run ~3x past the timeout below,
    // well past the client's 120s abandon point. The UI already has an
    // explicit per-invoice Retry button; that's the intended retry path.
    const anthropic = new Anthropic({ apiKey, maxRetries: 0 });

    const promptText = `Extract data from this supplier invoice and return JSON only (no markdown, no explanation).

The invoice may span MULTIPLE pages — each input image/PDF is one page of the same invoice. Combine all line items across all pages into one items[] array. Use the supplier/invoice#/date/totals from whichever page they appear on (usually page 1 for header, last page for totals).

Return exactly this structure:
{
  "supplier": string or null,
  "invoiceNumber": string or null,
  "invoiceDate": "YYYY-MM-DD" or null,
  "expenseDescription": one-line summary or null,
  "expenseCategory": one of: "Food & Beverage", "Supplies", "Utilities", "Transport", "Marketing", "Equipment", "Maintenance", "Professional Services", "Other",
  "items": [
    {
      "extractedName": "exact product name as written on invoice",
      "sku": "item code / SKU / product number printed on the line, exactly as written, or null if none",
      "packSize": units per box/case/pack as a number ONLY when the line explicitly shows one (e.g. "12x330ml" -> 12, "24 CT" -> 24, "1X6X4OZ" -> 6), else null — NEVER guess or infer,
      "qty": quantity as a number (REQUIRED — read directly from invoice; default 1 only if completely absent),
      "unitCost": unit price as a number (if not shown, calculate lineTotal / qty),
      "lineTotal": line total as a number or null
    }
  ],
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "notes": any issues or null
}

IMPORTANT: Always read the actual quantity from each line item. Do not default to 1 unless the invoice truly shows no quantity. Return ONLY the JSON object.`;

    // Phase 1 uses Haiku — cheap OCR, no catalog reasoning required at this step.
    // Typed failures instead of opaque 500s: the client switches on `code`.
    // Per-request timeout stays under the client's 120s so the server doesn't
    // keep paying for a scan the browser already abandoned (the SDK retries
    // 429/5xx internally before we map the error).
    let message: Anthropic.Message;
    const startedAt = Date.now();
    try {
      message = await anthropic.messages.create(
        {
          model: SCAN_MODEL,
          max_tokens: 4096,
          messages: [
            {
              role: "user",
              content: [...fileContentBlocks, { type: "text", text: promptText }],
            },
          ],
        },
        { timeout: 110_000 },
      );
    } catch (err) {
      const status = (err as { status?: number })?.status;
      this.logger.error(`scanInvoice: Anthropic call failed (status ${status}): ${String(err)}`);
      if (status === 401 || status === 403) {
        throw new BadRequestException({
          message:
            "The Anthropic API key is invalid or expired. Go to Settings → AI & Integrations to update it.",
          code: "AI_KEY_INVALID",
        });
      }
      // Non-transient 4xx (bad/oversized/corrupt image, malformed request) —
      // retrying the SAME file will fail identically, unlike a real outage
      // or rate-limit (429/5xx), so don't tell the user to "try again".
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw new BadRequestException({
          message:
            "The scanner couldn't process this file. Try a clearer photo or re-export as JPEG.",
          code: "AI_SCAN_REJECTED",
        });
      }
      throw new ServiceUnavailableException({
        message: "The AI scanner is temporarily unavailable. Try again in a minute.",
        code: "AI_UNAVAILABLE",
      });
    }
    const scanDurationMs = Date.now() - startedAt;

    const content = message.content[0];
    if (content.type !== "text") {
      throw new UnprocessableEntityException({
        message: "The AI scanner returned an unexpected response. Try again.",
        code: "AI_PARSE_FAILED",
      });
    }

    let parsed: Record<string, unknown>;
    try {
      let text = content.text.trim();
      text = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
      if (!text.startsWith("{")) {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) text = match[0];
      }
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch (_e) {
      this.logger.error(`scanInvoice: failed to parse AI response. Raw output:\n${content.text}`);
      throw new UnprocessableEntityException({
        message: "Couldn't read the scan result. Try again — a retry usually works.",
        code: "AI_PARSE_FAILED",
      });
    }
    // Disclose pages that were skipped (unreadable HEIC) in the result notes.
    if (skippedPages.length > 0) {
      const skipNote = `Page${skippedPages.length === 1 ? "" : "s"} ${skippedPages.join(", ")} couldn't be read (HEIC conversion failed) and ${skippedPages.length === 1 ? "was" : "were"} skipped — re-export as JPEG if lines are missing.`;
      const priorNotes = typeof parsed.notes === "string" ? parsed.notes.trim() : "";
      parsed.notes = priorNotes ? `${priorNotes} ${skipNote}` : skipNote;
    }

    // ── Phase 2: Server-side supplier + product matching (free, instant) ──
    const { supplierId, items } = await this.matchItems(
      typeof parsed.supplier === "string" ? parsed.supplier : null,
      (parsed.items as any[]) ?? [],
    );

    const result = { ...parsed, items, supplierId };
    const scan = await this.persistScan({
      files,
      fileHash,
      parsed,
      items,
      result,
      scanDurationMs,
      scannedById,
      supplierId,
    });
    return { ...result, scanId: scan?.id ?? null };
  }

  /**
   * The stored payload for bytes already scanned, shaped exactly like a fresh
   * scan so existing clients see no difference beyond the extra `priorScan`
   * block. A read failure here is not worth failing on — the caller simply pays
   * for a re-scan.
   */
  private async findScanByHash(fileHash: string) {
    let scan;
    try {
      scan = await this.prisma.forTenant().invoiceScan.findFirst({
        where: { fileHash, status: { not: "DISCARDED" } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          createdAt: true,
          status: true,
          vendorBillId: true,
          supplierInvoiceNumber: true,
          total: true,
          extractedPayload: true,
          vendorBill: { select: { billNumber: true } },
        },
      });
    } catch (e) {
      this.logger.error(`scanInvoice: prior-scan lookup failed: ${(e as Error).message}`);
      return null;
    }
    const payload = scan?.extractedPayload;
    if (!scan || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return null;
    }

    const priorScan: PriorScanSummary = {
      scanId: scan.id,
      scannedAt: scan.createdAt,
      status: scan.status,
      vendorBillId: scan.vendorBillId ?? null,
      billNumber: scan.vendorBill?.billNumber ?? null,
      supplierInvoiceNumber: scan.supplierInvoiceNumber ?? null,
      total: scan.total == null ? null : Number(scan.total),
    };
    return { ...(payload as Record<string, unknown>), scanId: scan.id, priorScan } as Record<
      string,
      any
    >;
  }

  /**
   * A cached scan's payload was matched (or not) against whatever aliases and
   * mappings existed at scan time. A rescan is exactly the moment an operator
   * expects a just-taught correction to apply, so strip the stale match
   * fields and re-run `matchItems` in memory before returning — the stored
   * `extractedPayload` (fingerprints, scan history) is never rewritten.
   */
  private async rematchPriorScan(prior: Record<string, any>): Promise<Record<string, any>> {
    const rawItems: any[] = Array.isArray(prior.items) ? prior.items : [];
    const strippedItems = rawItems.map((item: any) => {
      const { matchedProductId, matchedProductName, confidence, candidates, matchSource, ...rest } =
        item ?? {};
      return rest;
    });
    const supplierRaw = typeof prior.supplier === "string" ? prior.supplier : null;
    const { supplierId, items } = await this.matchItems(supplierRaw, strippedItems);
    return { ...prior, items, supplierId };
  }

  /** Record the scan and file it under all three duplicate keys. Never throws. */
  private async persistScan(args: {
    files: ScanInvoiceFile[];
    fileHash: string;
    parsed: Record<string, unknown>;
    items: any[];
    result: Record<string, unknown>;
    scanDurationMs: number;
    scannedById?: string;
    supplierId?: string | null;
  }): Promise<{ id: string } | null> {
    const { files, fileHash, parsed, items, result } = args;
    try {
      const invoiceNumber = normalizeInvoiceNumber(
        typeof parsed.invoiceNumber === "string" ? parsed.invoiceNumber : null,
      );
      const scan = await this.prisma.forTenant().invoiceScan.create({
        data: {
          fileName: files[0]?.fileName ?? null,
          mimeType: files[0]?.mimeType ?? null,
          byteSize: files.reduce((sum, f) => sum + f.buffer.length, 0),
          pageCount: files.length,
          fileHash,
          extractedPayload: result as unknown as Prisma.InputJsonValue,
          model: SCAN_MODEL,
          scanDurationMs: args.scanDurationMs,
          supplierNameRaw: typeof parsed.supplier === "string" ? parsed.supplier : null,
          supplierId: args.supplierId ?? null,
          supplierInvoiceNumber: invoiceNumber || null,
          invoiceDate: this.parseDate(parsed.invoiceDate as string | null),
          subtotal: this.moneyOrNull(parsed.subtotal),
          tax: this.moneyOrNull(parsed.tax),
          total: this.moneyOrNull(parsed.total),
          lineCount: items.length,
          lineFingerprint: lineFingerprint(items, parsed.total as number | null),
          scannedById: args.scannedById ?? null,
        },
        select: { id: true },
      });

      const fileKey = await this.storeScanFiles(scan.id, files);
      if (fileKey) {
        await this.prisma
          .forTenant()
          .invoiceScan.update({ where: { id: scan.id }, data: { fileKey } });
      }
      return scan;
    } catch (e) {
      this.logger.error(`scanInvoice: failed to persist scan: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Store the pages as received (not the sharp-converted copies) and return the
   * FIRST page's key — `fileKey` is singular, so the remaining pages live
   * alongside it under the same `invoice-scans/<scanId>/` prefix and are found
   * by `pageCount`. Returns null on any failure: the extraction is what the
   * operator is waiting for, the file is a convenience.
   */
  private async storeScanFiles(scanId: string, files: ScanInvoiceFile[]): Promise<string | null> {
    try {
      const keys = await Promise.all(
        files.map((f, i) => {
          const ext = SCAN_FILE_EXTENSIONS[f.mimeType] ?? "bin";
          const key = `invoice-scans/${scanId}/${i + 1}.${ext}`;
          return this.storage.upload(key, f.buffer, f.mimeType);
        }),
      );
      return keys[0] ?? null;
    } catch (e) {
      this.logger.error(
        `scanInvoice: failed to store scan ${scanId} files: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /** Every document ever read, newest first — including the reviews nobody finished. */
  async listScans(status?: string, page = 1, limit = 20) {
    if (
      status &&
      !INVOICE_SCAN_STATUSES.includes(status as (typeof INVOICE_SCAN_STATUSES)[number])
    ) {
      throw new BadRequestException(
        `Unknown scan status "${status}" — expected one of ${INVOICE_SCAN_STATUSES.join(", ")}.`,
      );
    }
    const where = status ? { status: status as any } : {};
    const [data, total] = await Promise.all([
      this.prisma.forTenant().invoiceScan.findMany({
        where,
        select: INVOICE_SCAN_LIST_SELECT,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.forTenant().invoiceScan.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getScan(id: string) {
    const scan = await this.prisma.forTenant().invoiceScan.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true } },
        vendorBill: { select: { id: true, billNumber: true, status: true } },
      },
    });
    if (!scan) throw new NotFoundException("Invoice scan not found");
    // A missing or unreachable file must not hide the extraction behind it.
    const fileUrl = scan.fileKey
      ? await this.storage.presignedUrl(scan.fileKey).catch(() => null)
      : null;
    return { ...scan, fileUrl };
  }

  async recordPayment(id: string, dto: { amount: number; method: string; reference?: string }) {
    // F10-004: reject non-positive amounts. A negative/zero payment would reduce
    // totalPaid and could flip the bill's status, corrupting AP balances. The
    // controller DTO (@IsPositive) covers HTTP; this guards direct callers too.
    if (!(Number(dto.amount) > 0)) {
      throw new BadRequestException("Payment amount must be greater than zero.");
    }
    return this.prisma.tenantTransaction(async (tx) => {
      const bill = await tx.vendorBill.findUnique({ where: { id }, include: { payments: true } });
      if (!bill) throw new NotFoundException("Bill not found");
      const alreadyPaid = roundMoney(bill.payments.reduce((s, p) => s + Number(p.amount), 0));
      const remaining = roundMoney(Number(bill.totalOwed) - alreadyPaid);
      if (remaining <= 0) throw new BadRequestException("Bill already fully paid");
      if (Number(dto.amount) > remaining + 0.001) {
        throw new BadRequestException(
          `Payment amount exceeds the remaining balance of ${remaining.toFixed(2)}.`,
        );
      }
      await tx.billPayment.create({
        data: {
          vendorBillId: id,
          amount: dto.amount,
          method: dto.method as any,
          reference: dto.reference,
        },
      });
      const newPaid = roundMoney(alreadyPaid + Number(dto.amount));
      const newStatus = newPaid >= Number(bill.totalOwed) - 0.001 ? "PAID" : "PARTIAL";
      return tx.vendorBill.update({
        where: { id },
        data: { totalPaid: newPaid, status: newStatus as any },
        include: {
          supplier: { select: { id: true, name: true } },
          payments: { orderBy: { createdAt: "desc" } },
          items: {
            include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
          },
        },
      });
    });
  }

  async delete(id: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({ where: { id } });
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status === "RECEIVED" || bill.status === "PAID" || bill.status === "PARTIAL") {
      throw new BadRequestException(
        "Cannot delete a bill that has been received or paid. Void it instead.",
      );
    }
    await this.prisma.$transaction([
      this.prisma.forTenant().billPayment.deleteMany({ where: { vendorBillId: id } }),
      this.prisma.forTenant().vendorBillItem.deleteMany({ where: { vendorBillId: id } }),
      this.prisma.forTenant().vendorBill.delete({ where: { id } }),
    ]);
    return { success: true };
  }

  async bulkDelete(ids: string[]) {
    if (!ids || ids.length === 0) throw new BadRequestException("No IDs provided");
    // Only delete DRAFT or VOID bills
    const bills = await this.prisma.forTenant().vendorBill.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, billNumber: true },
    });
    const deletable = bills.filter((b) => b.status === "DRAFT" || b.status === "VOID");
    const skipped = bills.filter((b) => b.status !== "DRAFT" && b.status !== "VOID");
    if (deletable.length > 0) {
      const deletableIds = deletable.map((b) => b.id);
      await this.prisma.$transaction([
        this.prisma
          .forTenant()
          .billPayment.deleteMany({ where: { vendorBillId: { in: deletableIds } } }),
        this.prisma
          .forTenant()
          .vendorBillItem.deleteMany({ where: { vendorBillId: { in: deletableIds } } }),
        this.prisma.forTenant().vendorBill.deleteMany({ where: { id: { in: deletableIds } } }),
      ]);
    }
    return {
      deleted: deletable.length,
      skipped: skipped.map((b) => ({
        id: b.id,
        billNumber: b.billNumber,
        reason: "Cannot delete received/paid/partial bills",
      })),
    };
  }
}
