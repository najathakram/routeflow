import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ImportFileStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { DuplicateMatchService } from "./duplicate-match.service";

/** The actual shape vendor-bills.scanInvoice returns (see its prompt schema + line matcher). */
type ScanConfidence = "high" | "medium" | "low" | "none";
interface ScanLine {
  extractedName?: string;
  qty?: number;
  unitCost?: number;
  lineTotal?: number | null;
  matchedProductId?: string | null;
  matchedProductName?: string | null;
  confidence?: ScanConfidence;
}
interface ExtractedInvoice {
  supplier?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
  items?: ScanLine[];
  notes?: string | null;
}

/** Numeric confidence per line, to store a representative (worst-case) value. */
const CONF_SCORE: Record<ScanConfidence, number> = { high: 1, medium: 0.66, low: 0.33, none: 0 };

/**
 * Batch invoice import (spec §4): upload many files, process them into a queue
 * with per-file status (CLEAN / NEEDS_REVIEW / DUPLICATE), then "Finish: post N
 * bills" — which creates a vendor bill per resolved item and RECEIVES it (stock +
 * costing come for free from the existing vendor-bill path). The AI extraction is
 * the existing vendor-bills.scanInvoice (reused, never edited); duplicate
 * detection reuses Phase 2's secondary match. A true background worker (Bull) is
 * a follow-up — the queue persists per-file status so processing is resumable.
 */
@Injectable()
export class BatchImportService {
  private readonly logger = new Logger(BatchImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vendorBills: VendorBillsService,
    private readonly dupMatch: DuplicateMatchService,
  ) {}

  /** Open a new batch. */
  async createBatch(dto: { kind?: string; createdById?: string }) {
    const tenantId = this.requireTenant();
    return this.prisma.forTenant().importBatch.create({
      data: {
        tenantId,
        kind: dto.kind ?? "BATCH_BILLS",
        status: "PROCESSING",
        createdById: dto.createdById ?? null,
      },
    });
  }

  /**
   * Scan one uploaded file into the batch queue and classify it. The client
   * uploads N files (each call scans one); the user can leave and review the
   * queue when done.
   */
  async scanAndRecord(
    batchId: string,
    files: Array<{ buffer: Buffer; mimeType: string }>,
    filename?: string,
  ) {
    const tenantId = this.requireTenant();
    await this.getBatchOrThrow(batchId);
    const item = await this.prisma.forTenant().importQueueItem.create({
      data: {
        tenantId,
        batchId,
        filename: filename ?? null,
        mimeType: files[0]?.mimeType ?? null,
        status: "PROCESSING",
      },
    });

    try {
      const extracted = (await this.vendorBills.scanInvoice(files)) as ExtractedInvoice;
      return await this.classifyAndPersist(item.id, batchId, extracted);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Extraction failed";
      await this.prisma.forTenant().importQueueItem.update({
        where: { id: item.id },
        data: { status: "FAILED", errorMessage: message },
      });
      await this.recomputeBatch(batchId);
      throw new BadRequestException(message);
    }
  }

  /** Classify an extracted scan into CLEAN / NEEDS_REVIEW / DUPLICATE and persist. */
  private async classifyAndPersist(itemId: string, batchId: string, extracted: ExtractedInvoice) {
    const invoiceNumber = extracted.invoiceNumber ?? null;
    const total = Number(extracted.total ?? 0);
    const issueDate = extracted.invoiceDate ? new Date(extracted.invoiceDate) : new Date();
    const lines = extracted.items ?? [];

    // A line is unmatched if the scanner found no product for it (confidence "none").
    const unmatched = lines.filter((l) => !l.matchedProductId).length;
    // Only auto-CLEAN when every matched line is a HIGH-confidence match; any
    // weaker (medium/low) match on a line is a "low-confidence" flag for review.
    const matched = lines.filter((l) => l.matchedProductId);
    const lowConfidence = matched.some((l) => (l.confidence ?? "none") !== "high");
    const overallConfidence = matched.length
      ? Math.min(...matched.map((l) => CONF_SCORE[l.confidence ?? "none"]))
      : null;

    const dup = await this.dupMatch.findInvoiceDuplicate({
      number: invoiceNumber,
      total,
      issueDate,
    });

    let status: ImportFileStatus;
    if (dup) {
      status = "DUPLICATE";
    } else if (unmatched === 0 && !lowConfidence) {
      status = "CLEAN";
    } else {
      status = "NEEDS_REVIEW";
    }

    const item = await this.prisma.forTenant().importQueueItem.update({
      where: { id: itemId },
      data: {
        status,
        extractedPayload: extracted as object,
        supplierName: extracted.supplier ?? null,
        invoiceNumber,
        total: total.toFixed(2),
        unmatchedLines: unmatched,
        confidence: overallConfidence != null ? overallConfidence.toFixed(4) : null,
        duplicateOfInvoiceId: dup?.id ?? null,
      },
    });
    // Each processed file counts against the AI-scan meter (cap check is a
    // billing-owned follow-up; the queue never loses files at the cap).
    await this.prisma.forTenant().importBatch.update({
      where: { id: batchId },
      data: { meteredScans: { increment: 1 } },
    });
    await this.recomputeBatch(batchId);
    return item;
  }

  /** Batch + its queue items (for the review UI). */
  async getBatch(id: string) {
    const batch = await this.getBatchOrThrow(id);
    const items = await this.prisma.forTenant().importQueueItem.findMany({
      where: { batchId: id },
      orderBy: { createdAt: "asc" },
    });
    return { batch, items };
  }

  /** Mark a NEEDS_REVIEW item resolved (operator fixed the flagged lines). */
  async resolveItem(itemId: string) {
    const item = await this.prisma
      .forTenant()
      .importQueueItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException("Queue item not found");
    if (item.status === "POSTED") throw new BadRequestException("Item already posted.");
    const updated = await this.prisma.forTenant().importQueueItem.update({
      where: { id: itemId },
      data: { status: "CLEAN", unmatchedLines: 0 },
    });
    await this.recomputeBatch(item.batchId);
    return updated;
  }

  /**
   * "Finish: post N bills" — post every CLEAN item: create a vendor bill and
   * receive it (stock + costing via the existing path). Non-product lines are
   * acknowledged (acknowledgeUnlinked) once mapped. Idempotent per item (skips
   * already-POSTED ones).
   */
  async postBatch(id: string, performedById?: string) {
    await this.getBatchOrThrow(id);
    const clean = await this.prisma.forTenant().importQueueItem.findMany({
      where: { batchId: id, status: "CLEAN" },
    });

    let posted = 0;
    for (const item of clean) {
      const payload = (item.extractedPayload ?? {}) as ExtractedInvoice;
      // Map scan lines to the vendor-bill item shape: the scanner emits the
      // resolved product under `matchedProductId`, which create() expects as
      // `productId` (so receive() updates stock + costing).
      const billItems = (payload.items ?? []).map((l) => ({
        productId: l.matchedProductId ?? null,
        name: l.extractedName,
        description: l.extractedName,
        qty: l.qty,
        unitCost: l.unitCost,
      }));
      const supplierInv = item.invoiceNumber ? ` · supplier inv ${item.invoiceNumber}` : "";
      const bill = await this.vendorBills.create({
        requireSupplier: false,
        supplierId: item.supplierMatchId ?? undefined,
        totalOwed: item.total != null ? Number(item.total) : undefined,
        billDate: new Date(),
        items: billItems,
        notes: `Batch import${supplierInv}`,
      });
      const billId = (bill as { id: string }).id;
      await this.vendorBills.receive(billId, { acknowledgeUnlinked: true }, performedById);
      await this.prisma.forTenant().importQueueItem.update({
        where: { id: item.id },
        data: { status: "POSTED", vendorBillId: billId },
      });
      posted++;
    }

    const batch = await this.recomputeBatch(id);
    return { posted, batchStatus: batch.status };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async recomputeBatch(batchId: string) {
    const counts = await this.prisma.forTenant().importQueueItem.groupBy({
      by: ["status"],
      where: { batchId },
      _count: true,
    });
    const by: Record<string, number> = {};
    let total = 0;
    for (const c of counts) {
      const n = c._count as unknown as number;
      by[c.status] = n;
      total += n;
    }
    const cleanCount = by.CLEAN ?? 0;
    const reviewCount = by.NEEDS_REVIEW ?? 0;
    const dupeCount = by.DUPLICATE ?? 0;
    const postedCount = by.POSTED ?? 0;
    const processing = (by.QUEUED ?? 0) + (by.PROCESSING ?? 0);

    let status: "PROCESSING" | "READY" | "POSTED" | "PARTIALLY_POSTED";
    if (processing > 0) status = "PROCESSING";
    else if (postedCount > 0 && postedCount < total) status = "PARTIALLY_POSTED";
    else if (postedCount > 0 && postedCount === total) status = "POSTED";
    else status = "READY";

    return this.prisma.forTenant().importBatch.update({
      where: { id: batchId },
      data: {
        totalFiles: total,
        cleanCount,
        reviewCount,
        dupeCount,
        postedCount,
        status,
        ...(status === "POSTED" || status === "PARTIALLY_POSTED" ? { postedAt: new Date() } : {}),
      },
    });
  }

  private async getBatchOrThrow(id: string) {
    const batch = await this.prisma.forTenant().importBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException("Import batch not found");
    return batch;
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
