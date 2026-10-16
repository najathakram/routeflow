import { STOCK_TX_OPTIONS, setStockLockTimeout } from "../common/product-locks";
import { retryStockTx } from "../common/tx-retry";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { lockBillRows } from "./bill-locks";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { Prisma, MovementType, PaymentMethod } from "@prisma/client";
import { costDecimal, nextAverageCost, reverseAverageCost } from "../inventory/costing";
import { billReceiptNote, billReversalNote, pairedReceiptIds } from "../inventory/bill-revert";
import { documentStockDate, type DocumentStockDate } from "../inventory/stock-write-date";
import { assertBillWithinPo, type BillLinePieces } from "./po-bill-match";
import { assertPackSizeKnownOrLog } from "./pack-size-gate";
import { roundMoney } from "@routeflow/pricing";
import { assertMoneyInvariantsOrThrow } from "../common/money-invariants.util";
import { calendarFieldStamp } from "../common/calendar-date";
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
import { RecordSupplierPaymentDto } from "./dto/supplier-payment.dto";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertSellableLines } from "../products/sellable-lines";
import { tenantSafeParentView } from "../products/product-parent";

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

/** A receipt row `receive()` wrote for a bill, as `revertToDraft` reads it back (B846). */
interface LiveBillReceipt {
  id: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  effectiveAt: Date;
  supplierId: string | null;
}

/** L-207: a revert the ledger cannot explain is refused, never guessed (the tx rolls back). */
const ledgerGap = (productId: string, name: string, detail: string, stockDrift = 0) =>
  new ConflictException({
    code: API_ERROR_CODES.INVENTORY_LEDGER_GAP,
    message: `"${name}" can't be reverted to draft — ${detail} Ask an admin to look into this product first.`,
    productId,
    name,
    stockDrift,
  });

@Injectable()
export class VendorBillsService {
  private readonly logger = new Logger(VendorBillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly platformConfig: PlatformConfigService,
    private readonly duplicateMatch: DuplicateMatchService,
    private readonly storage: StorageService,
    private readonly inventory: InventoryService,
    private readonly productAlias: ProductAliasService,
  ) {}

  /**
   * A bill line's INVENTORY denomination. Suppliers price lines in whatever
   * unit the invoice prints — usually CASES for boxed goods — while
   * `Product.currentStock` and `Product.averageCost` are contractually per
   * PIECE (@routeflow/pricing `costPerSellingUnit`). A line with
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
   * A DTO bill line in the PURCHASE ORDER's denomination — pieces and a
   * per-piece cost, via the same lineInventoryDelta receive/revert/void use — so
   * the bill-vs-PO gate and a PO raised from the bill's lines compare like for
   * like. Mirrors create()'s line defaults (qty 1, unitCost/unitPrice, packSize).
   */
  private billLineToPieces(item: any): BillLinePieces & {
    sku: string | null;
    packSize: number | null;
  } {
    const packSize = Number.isFinite(Number(item.packSize))
      ? Math.trunc(Number(item.packSize))
      : null;
    const { qty, unitCost } = this.lineInventoryDelta({
      qty: new Prisma.Decimal(item.qty || 1),
      unitCost: new Prisma.Decimal(item.unitCost ?? item.unitPrice ?? 0),
      packSize,
    });
    return {
      productId: item.productId || null,
      description: item.description || item.name || "",
      qty,
      unitCost,
      sku: item.sku || null,
      packSize: packSize != null && packSize > 0 ? packSize : null,
    };
  }

  /**
   * Two requests racing for the same PO (the bill link is unique) or the same next
   * PO number lose on a unique constraint — surface that as a retryable 409 instead
   * of a 500. Anything else passes through untouched.
   */
  private translateLinkRace(e: unknown, linking: boolean): unknown {
    if (linking && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return new ConflictException({
        code: API_ERROR_CODES.PO_LINK_CONFLICT,
        message:
          "Another bill or purchase order was created at the same moment — please try again.",
      });
    }
    return e;
  }

  /**
   * Link a new bill to an EXISTING purchase order (units/PO step 7). The PO must
   * exist in the tenant, be open, belong to the bill's supplier and not already
   * have a bill (one bill per PO), and the bill may not exceed it — see
   * po-bill-match.ts. Returns the PO id to store on the bill.
   */
  private async linkExistingPurchaseOrder(
    tx: Prisma.TransactionClient,
    purchaseOrderId: string,
    supplierId: string | null,
    items: any[],
  ): Promise<string> {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status === "CLOSED") {
      throw new BadRequestException(
        `Purchase order ${po.poNumber} is closed — it can't be billed.`,
      );
    }
    if (supplierId && po.supplierId !== supplierId) {
      throw new BadRequestException(
        `Purchase order ${po.poNumber} belongs to a different supplier than this bill.`,
      );
    }
    const already = await tx.vendorBill.findFirst({
      where: { purchaseOrderId: po.id, status: { not: "VOID" as any } },
      select: { billNumber: true },
    });
    if (already) {
      throw new ConflictException({
        code: API_ERROR_CODES.PO_ALREADY_BILLED,
        message: `Purchase order ${po.poNumber} already has bill ${already.billNumber}.`,
      });
    }
    assertBillWithinPo(
      po.poNumber,
      po.items,
      items.map((i) => this.billLineToPieces(i)),
    );
    return po.id;
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

  /**
   * B285: serialise every writer of ONE bill's receipt (receive, revertToDraft, voidBill). Their
   * guards and plans are computed from a read taken OUTSIDE the transaction, so two concurrent
   * writers both passed them and both posted (a double receive doubled the stock; a revert racing
   * a top-up left stock counted twice). Lock the bill row, then refuse, readably, if the receipt
   * state the caller planned from is no longer the bill's.
   */
  private async lockBillAndAssertReceiptState(
    tx: Prisma.TransactionClient,
    bill: {
      id: string;
      status: string;
      receivedDate: Date | null;
      totalPaid?: unknown;
      totalOwed?: unknown;
      items: { id: string; qtyReceived: Prisma.Decimal | null }[];
    },
  ) {
    await lockBillRows(tx, this.prisma.getTenantId(), [bill.id]);
    const fresh = await tx.vendorBill.findUnique({
      where: { id: bill.id },
      select: {
        status: true,
        receivedDate: true,
        totalPaid: true,
        totalOwed: true,
        items: { select: { id: true, qtyReceived: true } },
      },
    });
    // The fingerprint of everything a bill writer plans from: status, receipt state, the money
    // columns (a void or edit writes totalPaid/totalOwed back from its pre-tx read), and the lines.
    const num = (v: unknown) => String(Number(v ?? 0));
    const state = (b: {
      status: string;
      receivedDate: Date | null;
      totalPaid?: unknown;
      totalOwed?: unknown;
      items: { id: string; qtyReceived: Prisma.Decimal | null }[];
    }) =>
      JSON.stringify([
        b.status,
        b.receivedDate?.getTime() ?? null,
        num(b.totalPaid),
        num(b.totalOwed),
        (b.items ?? [])
          .map((i) => [i.id, i.qtyReceived == null ? null : String(i.qtyReceived)])
          .sort(),
      ]);
    if (!fresh || state(fresh) !== state(bill)) {
      throw new ConflictException({
        code: API_ERROR_CODES.BILL_STATE_CHANGED,
        message:
          "This bill was just changed by someone else (received, reverted, voided, paid or edited) — reload it and try again.",
      });
    }
  }

  private productIdsOf(items: { productId: string | null }[]): string[] {
    return items.flatMap((i) => (i.productId ? [i.productId] : []));
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
    // #2488: the literal calendar day, refused (400 naming the field) before any read or write.
    const dueDate = dto.dueDate ? calendarFieldStamp(dto.dueDate, "dueDate") : null;
    // supplierId is required when creating manually from the UI, but optional for import-created bills
    if (dto.requireSupplier !== false) {
      if (!dto.supplierId || typeof dto.supplierId !== "string" || dto.supplierId.trim() === "") {
        throw new BadRequestException("Please select a supplier before creating the bill.");
      }
    }
    const supplierId = dto.supplierId && dto.supplierId.trim() ? dto.supplierId.trim() : null;

    // Calculate totalOwed from line items if provided, otherwise use dto.totalOwed
    let preTaxOwed = dto.totalOwed ?? 0;
    if (dto.items && Array.isArray(dto.items) && dto.items.length > 0) {
      preTaxOwed = dto.items.reduce(
        (sum: number, item: any) =>
          sum + (Number(item.qty) || 1) * Number(item.unitCost ?? item.unitPrice ?? 0),
        0,
      );
    }
    const billTaxAmount = Number(dto.taxAmount) || 0;
    // Sales tax on the supplier invoice is owed too (the scan flow passes it as
    // taxAmount — line items only carry the pre-tax unit costs). totalOwed is a
    // monetary write, so round it.
    const totalOwed = roundMoney(preTaxOwed + billTaxAmount);

    // B451 gap 4: VendorBillItemDto.qty/unitCost/unitPrice now carry @Min(0),
    // but this method also accepts an internal caller's raw `dto.totalOwed`/
    // `dto.items` bypassing that DTO (see class comment) — the shared guard
    // covers both paths.
    assertMoneyInvariantsOrThrow({ subtotal: preTaxOwed, tax: billTaxAmount, total: totalOwed });

    // units/PO step 7 — a bill may link to an existing PO OR raise a new draft PO
    // from its own lines (the scan flow), never both. A raised PO needs a supplier
    // and every line mapped to a product: a PO line without a product can't exist.
    const wantsPurchaseOrder = dto.createPurchaseOrder === true;
    if (wantsPurchaseOrder && dto.purchaseOrderId) {
      throw new BadRequestException(
        "Choose an existing purchase order or raise a new one from this bill, not both.",
      );
    }
    if (wantsPurchaseOrder) {
      if (!supplierId) {
        throw new BadRequestException("Select a supplier before raising a purchase order.");
      }
      const lines: any[] = Array.isArray(dto.items) ? dto.items : [];
      if (lines.length === 0 || lines.some((i) => !i.productId)) {
        throw new BadRequestException(
          "Map every line to a product before raising a purchase order from this bill.",
        );
      }
      // B743: the raised PO's qtyOrdered/unitCost are taken DIRECTLY from
      // billLineToPieces's output and become the authoritative stock-mover
      // for this bill (receive() skips a PO-linked bill entirely) — so an
      // ambiguous pack here must be caught before the PO is ever raised,
      // not later at some unrelated PO receive screen.
      const products = await this.prisma.forTenant().product.findMany({
        where: { id: { in: [...new Set(lines.map((i) => i.productId))] } },
        select: {
          id: true,
          name: true,
          unitsPerBox: true,
          units: { select: { factorToBase: true } },
        },
      });
      const productsById = new Map(products.map((p) => [p.id, p]));
      assertPackSizeKnownOrLog(
        this.logger,
        this.prisma.getTenantId(),
        lines.map((item, lineIndex) => ({
          id: null,
          lineIndex,
          description: item.description || item.name || "",
          productId: item.productId,
          packSize: item.packSize,
          qty: Number(item.qty ?? 1),
          unitCost: Number(item.unitCost ?? item.unitPrice ?? 0),
          product: productsById.get(item.productId),
        })),
        !!dto.acknowledgePackSizeUnknown,
        { path: "raise-po", billId: null, billNumber: null },
      );
    }

    if (dto.purchaseOrderId && !supplierId) {
      // requireSupplier:false callers (internal imports) skip the supplier check above —
      // linking a PO without knowing the bill's supplier would skip the PO/supplier match.
      throw new BadRequestException("Select the supplier before linking a purchase order.");
    }
    if (dto.purchaseOrderId && (!Array.isArray(dto.items) || dto.items.length === 0)) {
      throw new BadRequestException("A bill linked to a purchase order needs at least one line.");
    }

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
          code: API_ERROR_CODES.DUPLICATE_VENDOR_BILL,
          message: this.duplicateMessage(supplierInvoiceNumber, match),
          duplicate,
        });
      }
    }

    if (!dto.allowDuplicate) {
      await this.assertNoPostedLineMatch(dto, totalOwed, supplierId ?? null);
    }

    const billNumber = await this.nextBillNumber();
    const billInclude = {
      supplier: { select: { id: true, name: true } },
      items: {
        include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
      },
      purchaseOrder: { select: { id: true, poNumber: true, status: true } },
    };

    // Wrapped in a transaction (not the plain forTenant() write this used to
    // be) so a fresh bill can auto-apply the supplier's available on-account
    // credit in the same atomic step — see applySupplierCreditToBill.
    const bill = await this.prisma
      .tenantTransaction(async (tx) => {
        // The linked PO is what MOVES STOCK (send → receive); the bill is money
        // only. Created/validated in this same transaction so the two documents
        // exist together or not at all.
        let purchaseOrderId: string | null = null;
        if (wantsPurchaseOrder) {
          const po = await this.inventory.createDraftPurchaseOrderInTx(tx, {
            supplierId: supplierId!,
            notes: dto.notes ?? null,
            lines: (dto.items as any[]).map((i) => {
              const l = this.billLineToPieces(i);
              return {
                productId: l.productId!,
                qtyOrdered: new Prisma.Decimal(l.qty),
                unitCost: new Prisma.Decimal(l.unitCost),
                // the bill line's own exact total (cases x case cost), not pieces x the 4 dp per-piece cost.
                // `qty || 1` is the bill's OWN rule for a missing/zero qty (totalOwed above, the stored line
                // and billLineToPieces all read it that way), so the PO line and the bill line agree.
                totalCost: roundMoney(
                  new Prisma.Decimal(i.qty || 1)
                    .mul(new Prisma.Decimal(i.unitCost ?? i.unitPrice ?? 0))
                    .toNumber(),
                ),
                sku: l.sku,
                packSize: l.packSize,
              };
            }),
          });
          purchaseOrderId = po.id;
        } else if (dto.purchaseOrderId) {
          purchaseOrderId = await this.linkExistingPurchaseOrder(
            tx,
            dto.purchaseOrderId,
            supplierId,
            Array.isArray(dto.items) ? dto.items : [],
          );
        }

        const created = await tx.vendorBill.create({
          data: {
            billNumber,
            ...(supplierId ? { supplierId } : {}),
            ...(purchaseOrderId ? { purchaseOrderId } : {}),
            status: "DRAFT",
            totalOwed,
            ...(supplierInvoiceNumber ? { supplierInvoiceNumber } : {}),
            // Kept alongside totalOwed (which already includes the tax) so an edit
            // recomputing totals from line items can no longer silently drop them.
            taxAmount: this.moneyOrNull(dto.taxAmount),
            subtotal: this.moneyOrNull(dto.subtotal),
            billDate,
            dueDate,
            // Persisted verbatim, never recomputed here — bills have no
            // due-date-computation machinery server side (see schema comment).
            termsLabel: dto.termsLabel ?? null,
            notes: dto.notes,
            items:
              dto.items && dto.items.length > 0
                ? {
                    createMany: {
                      data: dto.items.map((item: any) => ({
                        // Stamped explicitly: a nested write does not get the tenant extension's stamp.
                        tenantId: this.prisma.getTenantId(),
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
          include: billInclude,
        });

        // B710: the scan is claimed in THIS transaction, so a second post of one scan is refused
        // (409) and rolls back its bill, PO and credit draws instead of writing a second restock.
        if (dto.scanId) await this.claimScanInTx(tx, dto.scanId, created.id);

        if (!supplierId) return created;
        return this.applySupplierCreditToBill(tx, created, billInclude);
      })
      .catch((e: unknown) => {
        throw this.translateLinkRace(e, wantsPurchaseOrder || !!dto.purchaseOrderId);
      });

    return bill;
  }

  /**
   * Auto-apply a supplier's available on-account credit (`SupplierCredit`,
   * created by `recordSupplierPayment` when a payment overshoots what was
   * owed) to a bill the moment it's created — and again when a DRAFT bill is
   * edited, after `update()` has handed the previous draws back — oldest credit
   * first, never drawing more than the bill still owes. Each draw is its own
   * `BillPayment`
   * carrying `supplierCreditId` (method CREDIT_NOTE, `reference` tagged
   * `SUPPLIER_CREDIT-<id8>` for humans; the ID column is what code matches on)
   * inside the SAME transaction the bill was created in, so the bill can never
   * be observed with unapplied credit sitting next to it. A bill with no
   * supplier, no owed amount, or a supplier with no credit is returned
   * untouched.
   *
   * Only `totalPaid` moves — the bill STAYS DRAFT. Flipping a never-received
   * bill to PAID/PARTIAL here would lock it out of its whole draft lifecycle:
   * `update()` refuses a non-DRAFT bill, `revertToDraft()` refuses PAID (and
   * refuses PARTIAL with no `receivedDate`), `delete()`/`bulkDelete()` refuse
   * anything but DRAFT/VOID, and `findAll`'s needsMapping queue is scoped to
   * DRAFT — so a mis-scanned bill for a supplier holding any credit would be
   * uneditable, undeletable and invisible to product mapping. Paid-ness is
   * arithmetic (`totalOwed − totalPaid`) everywhere that matters (landmine 1);
   * status is the receipt lifecycle and stays that.
   */
  private async applySupplierCreditToBill(tx: any, bill: any, include: Record<string, unknown>) {
    // Credit is held per supplier, and `supplierId` is optional on a bill —
    // querying it as null would be a Prisma validation error, not an empty set.
    if (!bill.supplierId) return bill;
    // Arithmetic, never status (landmine 1) — and against what the bill STILL
    // owes, not its gross total: on the edit path the row can already carry
    // payments, and credit must never be drawn past the outstanding balance.
    const alreadyPaid = Number(bill.totalPaid ?? 0);
    const owedRemaining = roundMoney(Number(bill.totalOwed) - alreadyPaid);
    if (!(owedRemaining > 0.001)) return bill;

    const credits = await tx.supplierCredit.findMany({
      where: { supplierId: bill.supplierId, balance: { gt: 0 } },
      orderBy: { receivedAt: "asc" },
    });
    if (credits.length === 0) return bill;

    let remaining = owedRemaining;
    let applied = 0;
    for (const credit of credits) {
      if (remaining <= 0.001) break;
      const creditBalance = Number(credit.balance);
      const draw = roundMoney(Math.min(creditBalance, remaining));
      if (draw <= 0.001) continue;

      await tx.billPayment.create({
        data: {
          vendorBillId: bill.id,
          amount: draw,
          method: PaymentMethod.CREDIT_NOTE,
          supplierCreditId: credit.id,
          reference: `SUPPLIER_CREDIT-${credit.id.slice(0, 8)}`,
          notes: `Paid ${draw.toFixed(2)} from account credit`,
        },
      });
      await tx.supplierCredit.update({
        where: { id: credit.id },
        data: { balance: roundMoney(creditBalance - draw) },
      });

      remaining = roundMoney(remaining - draw);
      applied = roundMoney(applied + draw);
    }

    if (applied <= 0.001) return bill;

    // totalPaid only — status is deliberately untouched (see the note above).
    return tx.vendorBill.update({
      where: { id: bill.id },
      data: { totalPaid: roundMoney(alreadyPaid + applied) },
      include,
    });
  }

  /**
   * Hand back on-account credit a bill drew, when that bill is voided or
   * deleted. A draw is a `BillPayment` carrying `supplierCreditId`; voiding or
   * deleting the bill makes the draw meaningless, and without this the
   * supplier's prepaid money would simply vanish — `getSupplierStatement`
   * excludes VOID bills entirely, so neither the bill, the draw, nor the
   * credit balance would show it any more.
   *
   * Idempotent by construction: each refunded draw row is deleted as it is
   * refunded, so voiding a bill and later deleting it cannot refund twice. A
   * credit is never pushed above the `amount` that created it. Returns the
   * total handed back so the caller can correct the bill's `totalPaid`.
   */
  private async refundDrawnSupplierCredits(tx: any, vendorBillId: string): Promise<number> {
    const draws = await tx.billPayment.findMany({
      where: { vendorBillId, supplierCreditId: { not: null } },
    });
    if (!draws || draws.length === 0) return 0;

    let refunded = 0;
    for (const draw of draws) {
      const credit = await tx.supplierCredit.findUnique({ where: { id: draw.supplierCreditId } });
      if (!credit) continue;
      const restored = roundMoney(
        Math.min(Number(credit.amount), Number(credit.balance) + Number(draw.amount)),
      );
      await tx.supplierCredit.update({ where: { id: credit.id }, data: { balance: restored } });
      refunded = roundMoney(refunded + Number(draw.amount));
    }

    await tx.billPayment.deleteMany({ where: { id: { in: draws.map((d: any) => d.id) } } });
    return refunded;
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
      code: API_ERROR_CODES.DUPLICATE_VENDOR_BILL,
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
        .invoiceScan.findFirst({
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
    const bill = await this.prisma.forTenant().vendorBill.findFirst({
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
   * B710: close the loop from bill back to the scan it came from, inside the bill's own
   * transaction, as a guarded claim. A scan backs at most one live bill: it is claimable while
   * not yet POSTED, or once the bill it posted was deleted (the link is nulled) or VOIDed, since
   * voiding is how an operator undoes a bad post. Each claim is a conditional `updateMany`, so two
   * concurrent posts serialize on the row and the loser matches nothing: a 409 that rolls its
   * whole transaction back. A bad or foreign scanId still never fails a bill: the tenant-scoped
   * lookup finds nothing and the bill is kept, unlinked.
   */
  private async claimScanInTx(
    tx: Prisma.TransactionClient,
    scanId: string,
    vendorBillId: string,
  ): Promise<void> {
    const data = { status: "POSTED" as const, vendorBillId };
    const fresh = await tx.invoiceScan.updateMany({
      where: { id: scanId, OR: [{ status: { not: "POSTED" } }, { vendorBillId: null }] },
      data,
    });
    if (fresh.count > 0) return;

    const scan = await tx.invoiceScan.findFirst({
      where: { id: scanId },
      select: { vendorBillId: true, vendorBill: { select: { billNumber: true, status: true } } },
    });
    if (!scan) return;
    if (scan.vendorBill?.status === "VOID") {
      // Compare-and-swap on the void bill's id: a concurrent re-post that won first moved it on.
      const repost = await tx.invoiceScan.updateMany({
        where: { id: scanId, status: "POSTED", vendorBillId: scan.vendorBillId },
        data,
      });
      if (repost.count > 0) return;
    }
    const billNumber = scan.vendorBill?.billNumber ?? null;
    throw new ConflictException({
      code: API_ERROR_CODES.SCAN_ALREADY_POSTED,
      message: billNumber
        ? `This scan was already posted as bill ${billNumber}. Void that bill to post the scan again.`
        : "This scan was already posted. Refresh and check its bill before posting again.",
      vendorBillId: scan.vendorBillId ?? null,
      billNumber,
    });
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
          .supplier.findFirst({ where: { id: match.supplierId }, select: { name: true } })
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
    // #2488: 400 (naming the field) before any read or write.
    const dueDate = dto.dueDate ? calendarFieldStamp(dto.dueDate, "dueDate") : null;
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: { items: { select: { id: true, qtyReceived: true } } },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status !== "DRAFT") {
      throw new BadRequestException("Only DRAFT bills can be edited. Revert to draft first.");
    }
    if (
      bill.purchaseOrderId &&
      dto.supplierId !== undefined &&
      dto.supplierId !== bill.supplierId
    ) {
      throw new BadRequestException(
        "This bill is linked to a purchase order — its supplier can't be changed.",
      );
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

      // B451 gap 4: same guard as create() — a negative qty/unitCost line
      // (or a negative taxAmount) must not persist a negative totalOwed here
      // either.
      assertMoneyInvariantsOrThrow({ subtotal: itemsTotal, tax, total: totalOwed });
    }

    const billInclude = {
      supplier: { select: { id: true, name: true } },
      items: {
        include: { product: { select: { id: true, name: true, sku: true, unit: true } } },
      },
      payments: { orderBy: { createdAt: "desc" as const } },
    };

    return this.prisma.tenantTransaction(async (tx) => {
      // B285: the DRAFT check above ran outside this tx. Lock the bill first (the order receive,
      // revert and void use) and refuse if it changed since we read it.
      await this.lockBillAndAssertReceiptState(tx, bill);
      // A bill linked to a purchase order can't be edited past what the PO
      // authorised (checked before anything is deleted).
      if (bill.purchaseOrderId && Array.isArray(dto.items)) {
        if (dto.items.length === 0) {
          throw new BadRequestException(
            "A bill linked to a purchase order needs at least one line.",
          );
        }
        const linkedPo = await tx.purchaseOrder.findUnique({
          where: { id: bill.purchaseOrderId },
          include: { items: true },
        });
        // Fail CLOSED: a link to a PO that no longer resolves can't be checked.
        if (!linkedPo) {
          throw new ConflictException({
            code: API_ERROR_CODES.PO_LINK_BROKEN,
            message: "The purchase order this bill is linked to could not be found.",
          });
        }
        assertBillWithinPo(
          linkedPo.poNumber,
          linkedPo.items,
          dto.items.map((i: any) => this.billLineToPieces(i)),
        );
      }

      // Delete existing items and recreate if items provided
      if (dto.items !== undefined) {
        // Parent-scoped, not `tx.vendorBillItem.deleteMany`: lines created nested by create() carry
        // a NULL tenantId, so the tenant-scoped child delete cannot see them and the old line
        // stayed beside the new one. The bill's own tenant scope makes this nested delete safe.
        await tx.vendorBill.update({ where: { id }, data: { items: { deleteMany: {} } } });
      }

      // A DRAFT bill can already be carrying auto-applied supplier credit —
      // applySupplierCreditToBill leaves the bill DRAFT precisely so it stays
      // editable — and an edit moves both of the things that draw was sized and
      // addressed by. Hand every draw back BEFORE the write, then re-apply
      // against the edited bill. Without this, correcting the total downwards
      // strands the difference on a bill that no longer owes it (the supplier
      // statement's `outstanding` goes negative), and re-pointing `supplierId`
      // pays the new supplier's bill out of the old supplier's account.
      const refunded = await this.refundDrawnSupplierCredits(tx, id);

      const updated = await tx.vendorBill.update({
        where: { id },
        data: {
          ...this.totalPaidAfterRefund(bill, refunded),
          ...(dto.supplierId !== undefined && { supplierId: dto.supplierId }),
          ...(dto.billDate !== undefined && {
            billDate: dto.billDate ? new Date(dto.billDate) : null,
          }),
          ...(dto.dueDate !== undefined && { dueDate }),
          ...(dto.termsLabel !== undefined && { termsLabel: dto.termsLabel }),
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
                      tenantId: this.prisma.getTenantId(),
                      productId: item.productId || null,
                      description: item.description || item.name || "",
                      qty: new Prisma.Decimal(item.qty || 1),
                      unitCost: new Prisma.Decimal(item.unitCost ?? item.unitPrice ?? 0),
                      sku: item.sku || null,
                      packSize: this.billLineToPieces(item).packSize,
                      lineTotal: item.lineTotal != null ? new Prisma.Decimal(item.lineTotal) : null,
                    })),
                  },
                },
              }
            : {}),
        },
        include: billInclude,
      });

      return this.applySupplierCreditToBill(tx, updated, billInclude);
    });
  }

  async receive(id: string, dto?: ReceiveVendorBillDto, performedById?: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: {
        // `units` (B743): the units_v1 selling ladder is a second signal (alongside
        // `unitsPerBox`) that a product is known to be boxed — see pack-size-gate.ts.
        items: { include: { product: { include: { units: { select: { factorToBase: true } } } } } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    // A voided bill is closed: receiving it would silently un-void it and post its stock.
    if (bill.status === "VOID") {
      throw new ConflictException({
        code: API_ERROR_CODES.BILL_VOID,
        message: "This bill is void and cannot be received.",
      });
    }
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
      // A PO-linked bill moves no stock at all (guard e), so "these lines won't
      // update inventory" would be a warning about nothing.
      bill.purchaseOrderId == null &&
      !dto?.acknowledgeUnlinked &&
      (bill.items.length === 0 || unlinkedItems.length > 0)
    ) {
      throw new ConflictException({
        code: API_ERROR_CODES.UNLINKED_ITEMS,
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

    // B743: a bill line billed in the supplier's own denomination (cases when
    // packSize > 1) but with no pack stated silently posts as pieces at the
    // case price once it moves stock below — refuse (once enforced) or log
    // (while dark). Guard (e) already means a PO-linked bill posts no stock
    // here at all, so this only applies to bills receiving directly. First
    // receipt only per line — a partial top-up keeps the basis it was
    // already posted at, never re-asking.
    if (bill.purchaseOrderId == null) {
      assertPackSizeKnownOrLog(
        this.logger,
        this.prisma.getTenantId(),
        plan
          .filter(({ item }) => item.productId && this.lineReceivedQty(bill, item).lte(0))
          .map(({ item }) => ({
            id: item.id,
            // Opus review (B743 PR A, finding 3): this array is FILTERED
            // (see .filter above) — indexing it directly gave the position
            // in the filtered plan, not the line's real position on the
            // bill. Every line here already carries a real `item.id`
            // (unlike create()'s raise-PO path, where lineIndex is the only
            // identifier for a not-yet-persisted line) — findIndex against
            // the bill's own full item list is the line's true position.
            lineIndex: bill.items.findIndex((i) => i.id === item.id),
            description: item.description,
            productId: item.productId!,
            packSize: item.packSize,
            qty: Number(item.qty),
            unitCost: Number(item.unitCost),
            product: item.product,
          })),
        !!dto?.acknowledgePackSizeUnknown,
        { path: "receive", billId: bill.id, billNumber: bill.billNumber },
      );
    }

    // Fully received once every linked line's cumulative receipt covers its
    // qty. Status stays a lossy display blend (recordPayment overwrites it);
    // receipt truth lives in receivedDate + per-line qtyReceived.
    const fullyReceived = linked.every((item) => {
      const adding = plan.find((p) => p.item.id === item.id)?.receiveQty ?? new Prisma.Decimal(0);
      return this.lineReceivedQty(bill, item).add(adding).gte(new Prisma.Decimal(item.qty));
    });

    // SA-767 L-1: re-run the whole tx on a 40P01 / 40001 / P2034. Every local the body fills
    // (restockedIds, gapsDetected) is declared inside it, the plan was computed before it, and the
    // alerts below fire after the commit, so a rolled-back attempt leaves nothing behind.
    const runBody = async (tx: any) => {
      await setStockLockTimeout(tx); // SA-767 R6: bound the bill row lock wait too
      await this.lockBillAndAssertReceiptState(tx, bill);
      // Sync inventory for each line in the plan. The whole block works in
      // INVENTORY denomination: lineInventoryDelta converts a case-priced line
      // (packSize > 1) to pieces + per-piece cost so Product.averageCost keeps
      // its per-PIECE contract (margins previously inflated by unitsPerBox²).
      const effectiveDate = bill.billDate ?? new Date();
      const restockedIds: string[] = [];
      // B285: row-lock the products BEFORE the per-line read below. currentStock is written as
      // an increment, but averageCost and the movement's stockAfter are derived from that read,
      // so without the lock a concurrent PO receive (which takes the same locks, sorted) is a
      // lost update on the average. Sorted ids inside lockProducts keep two writers deadlock-free.
      await this.inventory.lockProducts(
        tx,
        plan.flatMap((p) => (p.item.productId ? [p.item.productId] : [])),
      );
      // B846 / SA-808: a regulated product whose bill month is already filed books at `now`, never
      // back into the filed period (a re-receive would otherwise add Q' to a month that was filed on Q).
      const stockDates =
        bill.purchaseOrderId == null
          ? await documentStockDate(tx, {
              tenantId: this.prisma.getTenantId(),
              productIds: plan.flatMap((p) => (p.item.productId ? [p.item.productId] : [])),
              documentDate: effectiveDate,
              now: new Date(),
            })
          : new Map<string, { effectiveAt: Date }>();
      // B562 follow-up: a bill is received in ONE transaction across every
      // line. If one product's ledger has a gap (see recomputeProductInTx),
      // that must not abort lines that are perfectly fine — receiving stock
      // is never the dangerous part, only recomputing the average is. Each
      // gapped line still gets its quantity + immediate weighted-average
      // update below (same as recordPurchase); only the backdated ledger
      // replay/backfill is skipped for it, and it's reported here — same
      // shape as recomputeCosts's `gapsDetected` — so the caller can flag it.
      const gapsDetected: { productId: string; name: string; stockDrift: number }[] = [];
      for (const { item, receiveQty } of plan) {
        if (!item.productId || !item.product) continue;
        // Guard (e): a bill linked to a purchase order NEVER touches stock — the
        // PO's own receive is the stock mover, and posting here too would count a
        // scanned delivery twice. The bill's receipt state below still advances.
        if (bill.purchaseOrderId != null) continue;

        const { qty, unitCost } = this.lineInventoryDelta({
          qty: receiveQty,
          unitCost: item.unitCost,
          packSize: item.packSize,
        });
        const rowDate = stockDates.get(item.productId)?.effectiveAt ?? effectiveDate;

        // Read fresh state inside the tx so multi-line bills of the same
        // product compound correctly instead of using the pre-tx snapshot
        const product = await tx.product.findFirst({
          where: { id: item.productId },
          select: {
            name: true,
            kind: true,
            currentStock: true,
            averageCost: true,
            costingMethod: true,
          },
        });
        if (!product) continue;
        assertSellableLines([{ id: item.productId, ...product }]); // WS8: a FAMILY is never stocked

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
            purchaseDate: rowDate,
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
            notes: billReceiptNote(bill.billNumber),
            performedById: performedById ?? null,
            // Stamp the movement at the BILL date, matching the lot — a
            // backdated bill's cost snapshot must sit at the right point in
            // the ledger (the lot and the movement used to disagree). B562:
            // on effectiveAt (the accounting date); createdAt stays write-once.
            effectiveAt: rowDate,
          },
        });

        await tx.product.update({
          where: { id: item.productId },
          data: {
            currentStock: { increment: qty },
            ...(updatesAverage ? { averageCost: newAvgCost } : {}),
          },
        });

        // Backdated bill: the average later rows imply may have moved — replay the
        // product like recordPurchase (a dated COST_BASIS correction, SA-136 §4).
        // `throwOnGap: false` — a gap here must flag this ONE line, never
        // abort the whole bill (see the comment above the loop).
        const newer = await tx.stockMovement.count({
          where: { productId: item.productId, effectiveAt: { gt: rowDate } },
        });
        if (newer > 0) {
          const replay = await this.inventory.recomputeProductInTx(tx, item.productId, {
            throwOnGap: false,
            trigger: `BILL:${id}`,
            performedById: performedById ?? null,
          });
          if (replay?.gapDetected) {
            gapsDetected.push({
              productId: item.productId,
              name: item.product.name,
              stockDrift: replay.stockDrift,
            });
          }
        }

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

      return { updatedBill, restockedIds, gapsDetected };
    };
    const updated = await retryStockTx("vendorBills.receive", () =>
      this.prisma.tenantTransaction(runBody, STOCK_TX_OPTIONS),
    );

    // Bill receive is the main restock path — fire the same low-stock-cleared
    // alerts a manual purchase does (it never did).
    if (updated.restockedIds.length > 0) {
      this.inventory.fireStockAlerts([...new Set(updated.restockedIds)]);
    }

    // gapsDetected is additive — every line was still received; these are
    // just the ones whose cost history couldn't be safely recomputed (B562).
    return { ...updated.updatedBill, gapsDetected: updated.gapsDetected };
  }

  /**
   * B846 / SA-808: the receipt rows `receive()` wrote for this bill that no reversal row has paired
   * yet, split per plan line (oldest first). Found structurally: type PURCHASE, the bill's product,
   * reference = bill number AND the exact system receive note (a person's purchase never carries it),
   * quantity > 0 — never by the free-text reference alone. Refuses (L-207) when a product's live rows
   * do not add up to the lines' received quantity, or a row straddles two lines.
   */
  private async loadLiveBillReceipts(
    tx: Prisma.TransactionClient,
    bill: { billNumber: string },
    lines: { productId: string; name: string; qty: Prisma.Decimal }[],
  ) {
    const out: LiveBillReceipt[][] = lines.map(() => []);
    for (const productId of new Set(lines.map((l) => l.productId))) {
      const idx = lines.flatMap((l, i) => (l.productId === productId ? [i] : []));
      const name = lines[idx[0]].name;
      const want = idx.reduce((t, i) => t.add(lines[i].qty), new Prisma.Decimal(0));
      const paired = new Set(await pairedReceiptIds(tx, productId));
      const receipts = (await tx.stockMovement.findMany({
        where: {
          productId,
          type: MovementType.PURCHASE,
          reference: bill.billNumber,
          notes: billReceiptNote(bill.billNumber),
          quantity: { gt: 0 },
        },
        orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, quantity: true, unitCost: true, effectiveAt: true, supplierId: true },
      })) as LiveBillReceipt[];
      const rows = receipts.filter((r) => !paired.has(r.id));
      const posted = rows.reduce((t, r) => t.add(r.quantity), new Prisma.Decimal(0));
      if (!posted.eq(want)) {
        throw ledgerGap(
          productId,
          name,
          `its stock records for bill ${bill.billNumber} (${posted.toString()}) do not match what the bill says was received (${want.toString()}).`,
          Number(posted.sub(want)),
        );
      }
      for (const i of idx) {
        let taken = new Prisma.Decimal(0);
        while (taken.lt(lines[i].qty) && rows.length > 0) {
          const next = rows.shift() as LiveBillReceipt;
          out[i].push(next);
          taken = taken.add(next.quantity);
        }
        if (!taken.eq(lines[i].qty)) {
          throw ledgerGap(
            productId,
            name,
            `its stock records for bill ${bill.billNumber} do not line up with the bill's lines.`,
            Number(taken.sub(lines[i].qty)),
          );
        }
      }
    }
    return out;
  }

  async revertToDraft(id: string, performedById?: string) {
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

    // Guard (e): a PO-linked bill never posted stock (receive skips it), so
    // there is nothing to reverse — the PO owns its own movements and lots.
    const movesStock = bill.purchaseOrderId == null;

    // SA-767 L-1: the whole reversal tx re-runs on a 40P01 / 40001 / P2034 (nothing leaves the tx).
    const runBody = async (tx: any) => {
      await setStockLockTimeout(tx); // SA-767 R6: bound the bill row lock wait too
      await this.lockBillAndAssertReceiptState(tx, bill);
      // B285: the reversal below read-modify-writes the product's average — lock it first.
      await this.inventory.lockProducts(tx, this.productIdsOf(bill.items));
      // Reverse inventory for each product-linked item — in the SAME
      // inventory denomination receive() applied (case lines converted to
      // pieces + per-piece cost), and only the quantity ACTUALLY received
      // (partial receipts reverse partially), or the reversal stops matching
      // the receipt.
      // B846: nothing deletes a StockMovement (B562 / SA-136). Each receipt row this bill wrote is
      // answered by one signed PURCHASE row of the opposite sign; find the live ones up front and
      // refuse (L-207) if they do not add up to what the lines say was received.
      const plan: {
        item: (typeof bill.items)[number];
        name: string;
        qty: Prisma.Decimal;
        unitCost: Prisma.Decimal;
      }[] = [];
      for (const item of movesStock ? bill.items : []) {
        if (!item.productId) continue;
        const receivedQty = this.lineReceivedQty(bill, item);
        if (receivedQty.lte(0)) continue;
        const { qty, unitCost } = this.lineInventoryDelta({
          qty: receivedQty,
          unitCost: item.unitCost,
          packSize: item.packSize,
        });
        plan.push({
          item,
          name: item.product?.name ?? item.description ?? item.productId,
          qty,
          unitCost,
        });
      }
      const receiptsByLine = await this.loadLiveBillReceipts(
        tx,
        bill,
        plan.map((p) => ({ productId: p.item.productId as string, name: p.name, qty: p.qty })),
      );
      const now = new Date();
      const tenantId = this.prisma.getTenantId();
      const reversedReceipts: (LiveBillReceipt & { productId: string; name: string })[] = [];
      const earliestReversal = new Map<string, Date>();
      const gapsDetected: { productId: string; name: string; stockDrift: number }[] = [];
      // One filed-period decision per (product, distinct date), not one per row.
      const dateMemo = new Map<string, DocumentStockDate>();
      const stockDateOf = async (productId: string, documentDate: Date) => {
        const key = `${productId}|${documentDate.getTime()}`;
        if (!dateMemo.has(key)) {
          const got = await documentStockDate(tx, {
            tenantId,
            productIds: [productId],
            documentDate,
            now,
          });
          dateMemo.set(key, got.get(productId) as DocumentStockDate);
        }
        return dateMemo.get(key) as DocumentStockDate;
      };

      for (const [lineNo, { item, name, qty, unitCost }] of plan.entries()) {
        const productId = item.productId as string;
        const mine = receiptsByLine[lineNo];

        // Read current product state within the transaction for accurate AVCO reversal
        const product = await tx.product.findFirst({
          where: { id: productId },
          select: { currentStock: true, averageCost: true },
        });
        if (!product) continue;

        // Exact AVCO reversal; null ⇒ reversal empties stock — KEEP the
        // previous average so the product's cost basis survives the revert
        const reversedAvg =
          product.averageCost != null
            ? reverseAverageCost(product.currentStock, product.averageCost, qty, unitCost)
            : null;

        const updated = await tx.product.update({
          where: { id: productId },
          data: {
            currentStock: { decrement: qty },
            ...(reversedAvg !== null ? { averageCost: reversedAvg } : {}),
          },
          select: { currentStock: true },
        });

        // One reversing row per receipt row, written AFTER the update from the counter it returned
        // (SA-136 §1). With several rows on one line the counter walks down to `updated` on the last.
        let stockAfter = new Prisma.Decimal(updated.currentStock).add(qty);
        for (const original of mine) {
          stockAfter = stockAfter.sub(original.quantity);
          // SA-808 §3 (A): dated at the receipt's own instant so every period nets, UNLESS that
          // instant is in a filed period for this product — then dated now, and the note says so.
          const when = await stockDateOf(productId, original.effectiveAt);
          reversedReceipts.push({ ...original, productId, name });
          const prior = earliestReversal.get(productId);
          if (!prior || when.effectiveAt < prior) earliestReversal.set(productId, when.effectiveAt);
          await tx.stockMovement.create({
            data: {
              productId,
              type: MovementType.PURCHASE,
              quantity: new Prisma.Decimal(original.quantity).negated(),
              unitCost: original.unitCost,
              avgCostAfter: reversedAvg ?? product.averageCost ?? null,
              stockAfter,
              supplierId: original.supplierId,
              reference: bill.billNumber,
              notes: billReversalNote(original.id, when.movedFromPeriod),
              performedById: performedById ?? null,
              effectiveAt: when.effectiveAt,
            },
          });
        }
      }

      // Like receive(): rows newer than a (backdated) reversal can move the average they imply —
      // replay the product (a dated COST_BASIS correction, SA-136 §4). A gap never aborts a revert.
      for (const [productId, at] of earliestReversal) {
        const newer = await tx.stockMovement.count({
          where: { productId, effectiveAt: { gt: at } },
        });
        if (newer > 0) {
          const replay = await this.inventory.recomputeProductInTx(tx, productId, {
            throwOnGap: false,
            trigger: `BILL:${id}`,
            performedById: performedById ?? null,
          });
          if (replay?.gapDetected) {
            const name = plan.find((p) => p.item.productId === productId)?.name ?? productId;
            gapsDetected.push({ productId, name, stockDrift: replay.stockDrift });
          }
        }
      }

      // Reverse the lots this bill created (one per received line)
      if (movesStock) await this.reverseBillLots(tx, bill.billNumber, reversedReceipts);

      // Revert bill status to DRAFT and clear per-line receipt progress — the
      // bill is back to never-received. Nested updateMany, not a direct
      // vendorBillItem call: nested-created items have null tenantId, so the
      // tenant-scoped model method can't see them; the parent's scope can.
      const updatedBill = await tx.vendorBill.update({
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
      return { updatedBill, gapsDetected };
    };
    const out = await retryStockTx("vendorBills.revertToDraft", () =>
      this.prisma.tenantTransaction(runBody, STOCK_TX_OPTIONS),
    );
    // gapsDetected is additive (as in receive): lines whose cost history could not be recomputed.
    return { ...out.updatedBill, gapsDetected: out.gapsDetected };
  }

  /**
   * Remove the StockLots a bill's receive created. Untouched lots are deleted outright;
   * partially-consumed lots can only surrender what remains, so they are zeroed and annotated.
   *
   * Without `receipts` (voidBill) every lot with reference = billNumber goes. With them (B846 /
   * SA-808, revertToDraft) each paired receipt row's lot is matched by its FULL tuple (product,
   * purchaseDate = effectiveAt, qty, unit cost, reference), never by reference alone. Bills received
   * before 2026-08-12 stamped the lot and the movement at different instants, so a tuple miss falls
   * back to (product, reference, qty, unit cost) and reverses ONLY a single candidate; none or
   * several is refused (INVENTORY_LEDGER_GAP) rather than leave a phantom FIFO lot or guess.
   */
  private async reverseBillLots(
    tx: Prisma.TransactionClient,
    billNumber: string,
    receipts?: (LiveBillReceipt & { productId: string; name: string })[],
  ) {
    let lots: Awaited<ReturnType<typeof tx.stockLot.findMany>> = [];
    if (!receipts) {
      lots = await tx.stockLot.findMany({ where: { reference: billNumber } });
    } else {
      for (const r of receipts) {
        const base = {
          productId: r.productId,
          reference: billNumber,
          qty: r.quantity,
          ...(r.unitCost != null ? { unitCost: r.unitCost } : {}),
        };
        const free = async (extra: object) =>
          ((await tx.stockLot.findMany({ where: { ...base, ...extra } })) ?? []).filter(
            (l) => !(l.notes ?? "").includes("(bill reversed;") && !lots.some((x) => x.id === l.id),
          );
        let found = await free({ purchaseDate: r.effectiveAt });
        if (found.length === 0) {
          found = await free({});
          if (found.length !== 1) {
            throw ledgerGap(
              r.productId,
              r.name,
              `its stock lot for bill ${billNumber} cannot be identified.`,
            );
          }
        }
        lots.push(found[0]);
      }
    }
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
    // Guard (e): a PO-linked bill posted no stock, so a void has none to reverse.
    const needsReversal =
      (bill.status === "RECEIVED" || bill.status === "PARTIAL" || bill.status === "PAID") &&
      bill.receivedDate != null &&
      bill.purchaseOrderId == null;
    if (needsReversal) {
      // SA-767 L-1: the whole reversal tx re-runs on a 40P01 / 40001 / P2034 (nothing leaves the tx).
      const runBody = async (tx: any) => {
        await setStockLockTimeout(tx); // SA-767 R6: bound the bill row lock wait too
        await this.lockBillAndAssertReceiptState(tx, bill);
        await this.inventory.lockProducts(tx, this.productIdsOf(bill.items));
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

          const product = await tx.product.findFirst({
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

        const refunded = await this.refundDrawnSupplierCredits(tx, id);
        return tx.vendorBill.update({
          where: { id },
          data: {
            status: "VOID" as any,
            ...this.totalPaidAfterRefund(bill, refunded),
            ...(await this.unlinkPurchaseOrderOnVoid(tx, bill)),
          },
        });
      };
      return retryStockTx("vendorBills.voidBill", () =>
        this.prisma.tenantTransaction(runBody, STOCK_TX_OPTIONS),
      );
    }

    // Transactional (it used to be a bare update) so the credit refund and the
    // void land together — a void that took the credit back but failed to void
    // would be worse than either alone.
    return this.prisma.tenantTransaction(async (tx) => {
      // B285: a first receive committing between our pre-read and this write would leave its
      // stock on a VOID bill (nothing here reverses it) — lock and re-check like the branch above.
      await this.lockBillAndAssertReceiptState(tx, bill);
      const refunded = await this.refundDrawnSupplierCredits(tx, id);
      return tx.vendorBill.update({
        where: { id },
        data: {
          status: "VOID" as any,
          ...this.totalPaidAfterRefund(bill, refunded),
          ...(await this.unlinkPurchaseOrderOnVoid(tx, bill)),
        },
      });
    });
  }

  /**
   * A voided bill lets go of its purchase order. The link is unique (one bill per PO),
   * so a VOID bill that kept it would leave the PO permanently unbillable — and the
   * operator's only way to bill the delivery again would be an UNLINKED bill, which
   * posts stock of its own on top of what the PO already received (a double count).
   * The old link is kept in the bill's notes so the audit trail isn't lost.
   */
  private async unlinkPurchaseOrderOnVoid(
    tx: Prisma.TransactionClient,
    bill: { purchaseOrderId: string | null; notes: string | null },
  ): Promise<{ purchaseOrderId?: null; notes?: string }> {
    if (!bill.purchaseOrderId) return {};
    const po = await tx.purchaseOrder.findUnique({
      where: { id: bill.purchaseOrderId },
      select: { poNumber: true },
    });
    const note = `Voided — unlinked from purchase order ${po?.poNumber ?? bill.purchaseOrderId}.`;
    return { purchaseOrderId: null, notes: bill.notes ? `${bill.notes}\n${note}` : note };
  }

  /** Keep the denormalised `totalPaid` in step with draws handed back to credit. */
  private totalPaidAfterRefund(bill: { totalPaid: unknown }, refunded: number) {
    if (refunded <= 0.001) return {};
    return { totalPaid: Math.max(0, roundMoney(Number(bill.totalPaid ?? 0) - refunded)) };
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
        purchaseOrder: { select: { id: true, poNumber: true, status: true } },
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

    const [catalogRows, mappingRows, aliasMap] = await Promise.all([
      this.prisma.forTenant().product.findMany({
        select: {
          id: true,
          name: true,
          sku: true,
          barcode: true,
          unitSku: true,
          parentProductId: true,
          // tenantId only for the cross-tenant check below (B1211).
          parent: { select: { name: true, tenantId: true } },
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
              parent: { select: { name: true, tenantId: true } },
            },
          },
        },
      }),
      this.productAlias.resolveMany(
        supplierId,
        items.map((item) => item.extractedName ?? ""),
      ),
    ]);

    // B1211: a parent that belongs to another tenant never lends its name to a composed product name.
    const tenantId = this.prisma.getTenantId();
    const products = catalogRows.map((p) => ({
      ...p,
      parent: tenantSafeParentView(p.parent, tenantId),
    }));
    const allMappings = mappingRows.map((m) => ({
      ...m,
      product: m.product
        ? { ...m.product, parent: tenantSafeParentView(m.product.parent, tenantId) }
        : m.product,
    }));

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

    // Key priority: tenant key (SystemConfig) → platform key → env var.
    const tenantKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey = await this.platformConfig.resolveAnthropicKey(tenantKey);
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
      await this.platformConfig.recordAiUsage({
        tenantId: this.prisma.getTenantId(),
        feature: "ocr.vendor_bill",
        model: SCAN_MODEL,
        success: false,
      });
      if (status === 401 || status === 403) {
        throw new BadRequestException({
          message:
            "The Anthropic API key is invalid or expired. Go to Settings → AI & Integrations to update it.",
          code: API_ERROR_CODES.AI_KEY_INVALID,
        });
      }
      // Non-transient 4xx (bad/oversized/corrupt image, malformed request) —
      // retrying the SAME file will fail identically, unlike a real outage
      // or rate-limit (429/5xx), so don't tell the user to "try again".
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw new BadRequestException({
          message:
            "The scanner couldn't process this file. Try a clearer photo or re-export as JPEG.",
          code: API_ERROR_CODES.AI_SCAN_REJECTED,
        });
      }
      throw new ServiceUnavailableException({
        message: "The AI scanner is temporarily unavailable. Try again in a minute.",
        code: API_ERROR_CODES.AI_UNAVAILABLE,
      });
    }
    const scanDurationMs = Date.now() - startedAt;

    // The call succeeded, so the spend is real — record it even if parsing
    // the response fails below.
    await this.platformConfig.recordAiUsage({
      tenantId: this.prisma.getTenantId(),
      feature: "ocr.vendor_bill",
      model: SCAN_MODEL,
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    });

    const content = message.content[0];
    if (content.type !== "text") {
      throw new UnprocessableEntityException({
        message: "The AI scanner returned an unexpected response. Try again.",
        code: API_ERROR_CODES.AI_PARSE_FAILED,
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
        code: API_ERROR_CODES.AI_PARSE_FAILED,
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

  async recordPayment(
    id: string,
    dto: { amount: number; method: string; reference?: string; notes?: string },
  ) {
    // F10-004: reject non-positive amounts. A negative/zero payment would reduce
    // totalPaid and could flip the bill's status, corrupting AP balances. The
    // controller DTO (@IsPositive) covers HTTP; this guards direct callers too.
    if (!(roundMoney(Number(dto.amount)) > 0)) {
      throw new BadRequestException({
        code: API_ERROR_CODES.SUPPLIER_PAYMENT_NOT_POSITIVE,
        message: "Payment amount must be greater than zero.",
      });
    }
    return this.prisma.tenantTransaction(async (tx) => {
      // B285: lock the bill BEFORE reading its payments — two concurrent payments both read the
      // same alreadyPaid, both passed the remaining-balance check, and one overwrote totalPaid;
      // a void racing a payment un-voided the bill. Everything below reads fresh under the lock.
      await lockBillRows(tx, this.prisma.getTenantId(), [id]);
      const bill = await tx.vendorBill.findUnique({ where: { id }, include: { payments: true } });
      if (!bill) throw new NotFoundException("Bill not found");
      if (bill.status === "VOID") {
        throw new ConflictException({
          code: API_ERROR_CODES.BILL_VOID,
          message: "This bill is void and can't take a payment.",
        });
      }
      const alreadyPaid = roundMoney(bill.payments.reduce((s, p) => s + Number(p.amount), 0));
      const remaining = roundMoney(Number(bill.totalOwed) - alreadyPaid);
      // `billId` is a REQUEST ECHO (SA-634 exception): the path id the caller sent, read from no row.
      if (remaining <= 0) {
        throw new BadRequestException({
          code: API_ERROR_CODES.SUPPLIER_PAYMENT_FULLY_PAID,
          message: "Bill already fully paid",
          billId: id,
        });
      }
      const amount = roundMoney(Number(dto.amount));
      if (amount > remaining + 0.001) {
        throw new BadRequestException({
          code: API_ERROR_CODES.SUPPLIER_PAYMENT_OVER_BALANCE,
          message: `Payment amount exceeds the remaining balance of ${remaining.toFixed(2)}.`,
          remaining,
        });
      }
      await tx.billPayment.create({
        data: {
          vendorBillId: id,
          amount,
          method: dto.method as any,
          reference: dto.reference,
          // Was silently discarded here — the DTO accepted it but this create()
          // never read it back off dto, so every note an operator typed vanished.
          notes: dto.notes ?? null,
        },
      });
      const newPaid = roundMoney(alreadyPaid + amount);
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

  /**
   * The AP mirror of `InvoicesService.recordStandalonePayment`: one lump-sum
   * supplier payment allocated across N of that supplier's bills, all sharing
   * one `paymentGroupId` so the group reads as a single event. Any amount left
   * unallocated becomes a `SupplierCredit` rather than a rejection — the
   * operator paid what they paid.
   *
   * Landmine 1: eligibility per bill is `totalOwed − totalPaid > 0.001`,
   * ALWAYS arithmetic against the ledger (this bill's own `BillPayment` rows),
   * never `VendorBillStatus` — PARTIAL is written both for a short receipt and
   * for a part payment, so it cannot tell you what's actually owed.
   *
   * Everything happens in one transaction: an allocation to a bill belonging
   * to a different supplier, or exceeding what a bill can still take, or the
   * allocations summing past `totalAmount`, throws and rolls back the whole
   * group — nothing is half-written.
   */
  async recordSupplierPayment(dto: RecordSupplierPaymentDto) {
    // Resolve the supplier through the tenant-scoped client first, exactly as
    // getSupplierStatement does. Without it an unknown id surfaces as a raw
    // Prisma FK error (500) from the SupplierCredit write below, and another
    // tenant's id would mint a credit row nobody can ever see or spend.
    const supplier = await this.prisma.forTenant().supplier.findUnique({
      where: { id: dto.supplierId },
    });
    if (!supplier) throw new NotFoundException("Supplier not found");

    const requestedTotal = roundMoney(dto.allocations.reduce((s, a) => s + Number(a.amount), 0));
    if (requestedTotal > dto.totalAmount + 0.001) {
      // SA-634: `allocatedTotal` is THIS pre-transaction `requestedTotal` (not the in-transaction accumulator of the same name
      // further down), and `totalAmount` is the request's UNROUNDED value, so a half-cent overage stays visible.
      throw new BadRequestException({
        code: API_ERROR_CODES.SUPPLIER_ALLOCATIONS_EXCEED_PAYMENT,
        message: `Allocations total ${requestedTotal.toFixed(2)} exceed the payment amount of ${Number(dto.totalAmount).toFixed(2)}.`,
        allocatedTotal: requestedTotal,
        totalAmount: Number(dto.totalAmount),
      });
    }

    const paymentGroupId = randomUUID();
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();

    return this.prisma.tenantTransaction(async (tx) => {
      // B285: lock EVERY allocated bill (sorted) before reading any payments, so a recordPayment /
      // voidBill racing this apply can't leave a stale alreadyPaid or a payment on a void bill.
      await lockBillRows(
        tx,
        this.prisma.getTenantId(),
        dto.allocations.map((a) => a.vendorBillId),
      );
      const payments: any[] = [];
      const bills: { id: string; status: string; totalPaid: number }[] = [];
      let allocatedTotal = 0;

      for (const alloc of dto.allocations) {
        const amount = roundMoney(Number(alloc.amount));
        if (amount <= 0.001) continue;

        const bill = await tx.vendorBill.findUnique({
          where: { id: alloc.vendorBillId },
          include: { payments: true },
        });
        if (!bill) throw new NotFoundException(`Bill ${alloc.vendorBillId} not found`);
        // Highest-risk guard in this method: money must never land on another
        // supplier's bill. Checked per allocation, not once for the group.
        if (bill.supplierId !== dto.supplierId) {
          throw new BadRequestException({
            code: API_ERROR_CODES.SUPPLIER_ALLOCATION_WRONG_SUPPLIER,
            message: `Bill ${bill.billNumber} does not belong to the selected supplier.`,
            billId: bill.id,
            billNumber: bill.billNumber,
          });
        }
        // The ONE status comparison this method makes, and the only one it may:
        // VOID is unambiguous. A voided bill keeps its totalOwed and gets no
        // offsetting payment rows, so the arithmetic below still reports a
        // balance — and the update further down would overwrite VOID with
        // PAID/PARTIAL, resurrecting a cancelled bill (whose stock was already
        // reversed) into AP with real cash on it. Reachable as a race: another
        // operator voids the bill between the modal loading it and submitting.
        // Mirrors bookkeeping.payBillFully and invoices' recordStandalonePayment.
        if (bill.status === "VOID") {
          throw new BadRequestException({
            code: API_ERROR_CODES.SUPPLIER_ALLOCATION_BILL_VOID,
            message: `Bill ${bill.billNumber} is void and cannot be paid.`,
            billId: bill.id,
            billNumber: bill.billNumber,
          });
        }

        // The ledger, exactly as recordPayment does — never the denormalised
        // totalPaid column, and never bill.status (landmine 1).
        const alreadyPaid = roundMoney(
          bill.payments.reduce((s: number, p: any) => s + Number(p.amount), 0),
        );
        const remaining = roundMoney(Number(bill.totalOwed) - alreadyPaid);
        if (amount > remaining + 0.001) {
          throw new BadRequestException({
            code: API_ERROR_CODES.SUPPLIER_ALLOCATION_OVER_BALANCE,
            message: `Allocation of ${amount.toFixed(2)} to bill ${bill.billNumber} exceeds its remaining balance of ${remaining.toFixed(2)}.`,
            billId: bill.id,
            billNumber: bill.billNumber,
            amount,
            remaining,
          });
        }

        const payment = await tx.billPayment.create({
          data: {
            vendorBillId: bill.id,
            amount,
            method: dto.method,
            paidAt,
            reference: dto.reference ?? null,
            notes: dto.notes ?? null,
            paymentGroupId,
          },
        });
        payments.push(payment);
        allocatedTotal = roundMoney(allocatedTotal + amount);

        const newPaid = roundMoney(alreadyPaid + amount);
        // Same rule as recordPayment — arithmetic, never a status precondition.
        const newStatus = newPaid >= Number(bill.totalOwed) - 0.001 ? "PAID" : "PARTIAL";
        const updated = await tx.vendorBill.update({
          where: { id: bill.id },
          data: { totalPaid: newPaid, status: newStatus as any },
        });
        bills.push({
          id: updated.id,
          status: updated.status,
          totalPaid: Number(updated.totalPaid),
        });
      }

      // Overpayment is on-account credit, not a rejection: the operator paid
      // what they paid. Mirrors recordStandalonePayment's excess -> AdvancePayment.
      const excess = roundMoney(dto.totalAmount - allocatedTotal);
      if (excess > 0.001) {
        await tx.supplierCredit.create({
          data: {
            supplierId: dto.supplierId,
            amount: excess,
            balance: excess,
            method: dto.method,
            reference: dto.reference ?? null,
            notes: dto.notes ?? null,
            receivedAt: paidAt,
          },
        });
      }

      return { paymentGroupId, payments, excess: Math.max(0, excess), bills };
    });
  }

  /**
   * Pure read: a running-balance timeline for one supplier — bills (up) and
   * real cash movements (down) merged and sorted by date. `outstanding` is
   * `Σ(totalOwed − totalPaid)` over non-VOID bills — arithmetic, never status
   * (landmine 1); VOID itself is unambiguous so it's the one status this file
   * ever filters on.
   *
   * A `SupplierCredit`'s ORIGINAL amount is counted as a "down" movement the
   * moment it is created (that cash genuinely left the operator's hand then).
   * When it is later drawn against a bill (auto-apply), the resulting
   * `BillPayment` carries `supplierCreditId` and is deliberately EXCLUDED from
   * the timeline's payment rows — it is not new money, just the same dollars
   * already counted being matched to a bill, and counting both would
   * double-subtract it. The test is the FK, never the `reference` text: that
   * field is operator-typed on both money paths, so matching a
   * `"SUPPLIER_CREDIT-"` prefix would let a real cash payment disappear from
   * the timeline while still counting toward `totalPaid`. The bill's own
   * `totalPaid` still reflects the draw (via the normal per-bill payments
   * relation), so `outstanding` stays correct either way.
   */
  async getSupplierStatement(supplierId: string) {
    const supplier = await this.prisma.forTenant().supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException("Supplier not found");

    const [bills, credits] = await Promise.all([
      this.prisma.forTenant().vendorBill.findMany({
        where: { supplierId, status: { not: "VOID" as any } },
        include: { payments: true },
        orderBy: [{ billDate: "asc" }, { createdAt: "asc" }],
      }),
      this.prisma.forTenant().supplierCredit.findMany({
        where: { supplierId },
        orderBy: { receivedAt: "asc" },
      }),
    ]);

    type Row = {
      id: string;
      date: Date;
      type: "BILL" | "PAYMENT" | "CREDIT";
      description: string;
      amount: number; // signed: bills +, payments/credits -
      billId?: string;
      billNumber?: string;
      paymentGroupId?: string | null;
    };
    const rows: Row[] = [];

    let totalOwed = 0;
    let totalPaid = 0;
    for (const b of bills) {
      const owed = Number(b.totalOwed);
      const paid = roundMoney(b.payments.reduce((s: number, p: any) => s + Number(p.amount), 0));
      totalOwed = roundMoney(totalOwed + owed);
      totalPaid = roundMoney(totalPaid + paid);

      rows.push({
        id: b.id,
        date: b.billDate ?? b.createdAt,
        type: "BILL",
        description: `Bill ${b.billNumber}`,
        amount: owed,
        billId: b.id,
        billNumber: b.billNumber,
      });

      for (const payment of b.payments as any[]) {
        if (payment.supplierCreditId) continue;
        rows.push({
          id: payment.id,
          date: payment.paidAt,
          type: "PAYMENT",
          description: `Payment on ${b.billNumber}`,
          amount: -Number(payment.amount),
          billId: b.id,
          billNumber: b.billNumber,
          paymentGroupId: payment.paymentGroupId ?? null,
        });
      }
    }

    let creditBalance = 0;
    for (const credit of credits) {
      creditBalance = roundMoney(creditBalance + Number(credit.balance));
      rows.push({
        id: credit.id,
        date: credit.receivedAt,
        type: "CREDIT",
        description: credit.notes || "Overpayment held as account credit",
        amount: -Number(credit.amount),
      });
    }

    rows.sort((a, b) => a.date.getTime() - b.date.getTime());

    let running = 0;
    const timeline = rows.map((row) => {
      running = roundMoney(running + row.amount);
      return { ...row, balance: running };
    });

    return {
      supplierId,
      timeline,
      totalOwed,
      totalPaid,
      outstanding: roundMoney(totalOwed - totalPaid),
      creditBalance,
    };
  }

  async delete(id: string) {
    const bill = await this.prisma.forTenant().vendorBill.findUnique({
      where: { id },
      include: { items: { select: { id: true, qtyReceived: true } } },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    if (bill.status === "RECEIVED" || bill.status === "PAID" || bill.status === "PARTIAL") {
      throw new BadRequestException(
        "Cannot delete a bill that has been received or paid. Void it instead.",
      );
    }
    await this.prisma.tenantTransaction(async (tx) => {
      // B285: same lock + re-check as receive — a receive committing after our DRAFT check would
      // otherwise leave its stock behind a deleted bill.
      await this.lockBillAndAssertReceiptState(tx, bill);
      // A DRAFT bill can legitimately carry auto-applied credit draws — give
      // that money back before its payment rows are destroyed with the bill.
      await this.refundDrawnSupplierCredits(tx, id);
      await tx.billPayment.deleteMany({ where: { vendorBillId: id } });
      // Parent-scoped like update() (consistency, and defensive: the FK already cascades, but a
      // child-scoped delete would miss NULL-tenant legacy lines).
      await tx.vendorBill.update({ where: { id }, data: { items: { deleteMany: {} } } });
      await tx.vendorBill.delete({ where: { id } });
    });
    return { success: true };
  }

  async bulkDelete(ids: string[]) {
    if (!ids || ids.length === 0) throw new BadRequestException("No IDs provided");
    // Only DRAFT or VOID bills go. B285: decided INSIDE the tx, behind the bill row locks — a
    // receive committing after a pre-tx status read would otherwise leave its stock behind a
    // deleted bill.
    return this.prisma.tenantTransaction(async (tx) => {
      await lockBillRows(tx, this.prisma.getTenantId(), ids);
      const bills = await tx.vendorBill.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, billNumber: true },
      });
      const deletable = bills.filter((b) => b.status === "DRAFT" || b.status === "VOID");
      const skipped = bills.filter((b) => b.status !== "DRAFT" && b.status !== "VOID");
      if (deletable.length > 0) {
        const deletableIds = deletable.map((b) => b.id);
        // Same reason as delete(): auto-applied credit goes back before the
        // draw rows are destroyed. Already-VOID bills refunded nothing left.
        for (const billId of deletableIds) {
          await this.refundDrawnSupplierCredits(tx, billId);
        }
        await tx.billPayment.deleteMany({ where: { vendorBillId: { in: deletableIds } } });
        for (const billId of deletableIds) {
          await tx.vendorBill.update({
            where: { id: billId },
            data: { items: { deleteMany: {} } },
          });
        }
        await tx.vendorBill.deleteMany({ where: { id: { in: deletableIds } } });
      }
      return {
        deleted: deletable.length,
        skipped: skipped.map((b) => ({
          id: b.id,
          billNumber: b.billNumber,
          reason: "Cannot delete received/paid/partial bills",
        })),
      };
    });
  }
}
