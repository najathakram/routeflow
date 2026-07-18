import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ImportFileStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { DuplicateMatchService, formatSupplierInvoiceNote } from "./duplicate-match.service";
import type { UpdateBatchItemDto } from "./dto/update-batch-item.dto";

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
  /** Set once the operator has explicitly mapped or dismissed this line in the review UI. */
  reviewed?: boolean;
  sku?: string | null;
  /** Ranked weak-match suggestions when the scanner didn't auto-assign (see product-matcher.ts). */
  candidates?: Array<{ productId: string; name: string; sku: string | null; score: number }>;
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

interface SupplierCandidate {
  id: string;
  name: string;
}

/**
 * Scored supplier auto-match: exact name → unique startsWith → unique
 * substring (either direction). Several equally-plausible candidates or no
 * candidate at all → null, never a silent wrong pick — the item is routed to
 * NEEDS_REVIEW instead (see `deriveStatus`).
 */
function matchSupplier(detected: string, suppliers: SupplierCandidate[]): SupplierCandidate | null {
  const d = detected.trim().toLowerCase();
  if (!d) return null;
  const exact = suppliers.filter((s) => s.name.trim().toLowerCase() === d);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const starts = suppliers.filter(
    (s) => s.name.trim().toLowerCase().startsWith(d) || d.startsWith(s.name.trim().toLowerCase()),
  );
  if (starts.length === 1) return starts[0];
  if (starts.length > 1) return null;
  const contains = suppliers.filter((s) => {
    const n = s.name.trim().toLowerCase();
    return n.includes(d) || d.includes(n);
  });
  return contains.length === 1 ? contains[0] : null;
}

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

  /**
   * Derive the queue status from what's still outstanding. A dup always wins;
   * otherwise CLEAN requires every line matched, no low-confidence matches
   * left unconfirmed, AND — when the scan actually detected a supplier name —
   * that name resolved to exactly one Supplier record. A detected-but-unlinked
   * supplier is exactly as blocking as an unmatched line: posting silently
   * with no supplier is the defect this replaces.
   */
  private deriveStatus(params: {
    unmatchedLines: number;
    supplierUnresolved: boolean;
    lowConfidence?: boolean;
    dupId?: string | null;
  }): ImportFileStatus {
    if (params.dupId) return "DUPLICATE";
    if (params.unmatchedLines > 0 || params.supplierUnresolved || params.lowConfidence) {
      return "NEEDS_REVIEW";
    }
    return "CLEAN";
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

    // Resolve the extracted supplier name to a real Supplier so postBatch can
    // actually link the bill (previously this was never written — every
    // batch-imported bill posted with no supplier at all).
    const suppliers = await this.prisma.forTenant().supplier.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    const matchedSupplier = extracted.supplier
      ? matchSupplier(extracted.supplier, suppliers)
      : null;
    const supplierUnresolved = !!extracted.supplier && !matchedSupplier;

    // Supplier invoices must be checked against OUR vendor bills, never the
    // customer Invoice table (money owed BY us vs TO us — see
    // duplicate-match.service.ts's class doc for why the two must not cross).
    const dup = await this.dupMatch.findVendorBillDuplicate({
      supplierId: matchedSupplier?.id ?? null,
      number: invoiceNumber,
      total,
      issueDate,
    });

    const status = this.deriveStatus({
      unmatchedLines: unmatched,
      supplierUnresolved,
      lowConfidence,
      dupId: dup?.id ?? null,
    });

    const item = await this.prisma.forTenant().importQueueItem.update({
      where: { id: itemId },
      data: {
        status,
        extractedPayload: extracted as object,
        supplierName: extracted.supplier ?? null,
        supplierMatchId: matchedSupplier?.id ?? null,
        invoiceNumber,
        total: total.toFixed(2),
        unmatchedLines: unmatched,
        confidence: overallConfidence != null ? overallConfidence.toFixed(4) : null,
        // Denormalized pointer, no FK (see the model's schema comment) — now
        // points at the matched VendorBill, not a customer Invoice.
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

  /** Compute the client-facing "what's still pending" fields without persisting them. */
  private annotateItem<T extends { extractedPayload: unknown; supplierMatchId: string | null }>(
    item: T,
  ) {
    const payload = (item.extractedPayload ?? {}) as ExtractedInvoice;
    const lines = payload.items ?? [];
    const unreviewedLines = lines.filter((l) => !l.matchedProductId && !l.reviewed).length;
    const supplierUnresolved = !!payload.supplier && !item.supplierMatchId;
    return { ...item, unreviewedLines, supplierUnresolved };
  }

  /** Batch + its queue items (for the review UI). */
  async getBatch(id: string) {
    const batch = await this.getBatchOrThrow(id);
    const items = await this.prisma.forTenant().importQueueItem.findMany({
      where: { batchId: id },
      orderBy: { createdAt: "asc" },
    });
    return { batch, items: items.map((item) => this.annotateItem(item)) };
  }

  /** Recent batches, most-active first (restores the operator's place after a page refresh). */
  async listBatches() {
    const tenantId = this.requireTenant();
    return this.prisma.forTenant().importBatch.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  }

  /**
   * Apply the operator's per-line and per-item decisions from the review UI:
   * map a line to a product, explicitly keep it as a custom (non-stock) line,
   * and/or link the supplier. Recomputes status from what's still pending —
   * this is the ONLY way an unmatched line stops counting against readiness,
   * replacing the old blind "flip to CLEAN" resolve.
   */
  async updateItemLines(itemId: string, dto: UpdateBatchItemDto) {
    const item = await this.prisma
      .forTenant()
      .importQueueItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException("Queue item not found");
    if (item.status === "POSTED") throw new BadRequestException("Item already posted.");

    const payload = (item.extractedPayload ?? {}) as ExtractedInvoice;
    const lines: ScanLine[] = (payload.items ?? []).map((l) => ({ ...l }));

    if (dto.lines?.length) {
      const productIds = dto.lines.map((l) => l.productId).filter((id): id is string => !!id);
      const products = productIds.length
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, name: true },
          })
        : [];
      const productNameById = new Map(products.map((p) => [p.id, p.name]));

      for (const patch of dto.lines) {
        const line = lines[patch.index];
        if (!line) continue;
        if (patch.productId) {
          const name = productNameById.get(patch.productId);
          if (!name) throw new BadRequestException(`Product ${patch.productId} not found`);
          line.matchedProductId = patch.productId;
          line.matchedProductName = name;
          line.confidence = "high"; // operator-confirmed
          line.reviewed = true;
          // Teach the matcher: an operator pick on a batch-review line is exactly
          // as strong a signal as the web scanner's inline mapping-save — without
          // this, batch-review corrections taught the matcher nothing.
          const supplierName = payload.supplier?.trim();
          const rawDescription = line.extractedName?.trim();
          if (supplierName && rawDescription) {
            await this.vendorBills.saveProductMapping(
              supplierName,
              rawDescription,
              patch.productId,
            );
          }
        } else if (patch.keepCustom) {
          line.matchedProductId = null;
          line.matchedProductName = null;
          line.reviewed = true;
        }
      }
    }

    let supplierMatchId = item.supplierMatchId;
    if (dto.supplierId !== undefined) {
      if (dto.supplierId) {
        const supplier = await this.prisma
          .forTenant()
          .supplier.findUnique({ where: { id: dto.supplierId } });
        if (!supplier) throw new BadRequestException("Supplier not found");
        supplierMatchId = dto.supplierId;
      } else {
        supplierMatchId = null;
      }
    }

    const unmatchedLines = lines.filter((l) => !l.matchedProductId).length;
    const supplierUnresolved = !!payload.supplier && !supplierMatchId;
    const status = this.deriveStatus({
      unmatchedLines,
      supplierUnresolved,
      dupId: item.duplicateOfInvoiceId,
    });

    const updated = await this.prisma.forTenant().importQueueItem.update({
      where: { id: itemId },
      data: {
        extractedPayload: { ...payload, items: lines } as object,
        supplierMatchId,
        unmatchedLines,
        status,
      },
    });
    await this.recomputeBatch(item.batchId);
    return this.annotateItem(updated);
  }

  /**
   * Mark a NEEDS_REVIEW item resolved once every line has actually been
   * looked at (matched to a product OR explicitly kept custom via
   * `updateItemLines`) and, if the scan detected a supplier name, it's
   * linked. This is a real gate now, not a rubber stamp: a line that was
   * never touched in the review UI blocks resolution outright — there is no
   * "acknowledge and skip" bypass here (that already happened, per line, in
   * the review step; the old version let bills post with unreviewed lines
   * silently skipping stock/cost updates).
   */
  async resolveItem(itemId: string) {
    const item = await this.prisma
      .forTenant()
      .importQueueItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException("Queue item not found");
    if (item.status === "POSTED") throw new BadRequestException("Item already posted.");
    if (item.status === "DUPLICATE") {
      throw new BadRequestException(
        "This item matches an existing vendor bill — resolve the duplicate first.",
      );
    }

    const payload = (item.extractedPayload ?? {}) as ExtractedInvoice;
    const lines = payload.items ?? [];
    const unreviewed = lines.filter((l) => !l.matchedProductId && !l.reviewed).length;
    if (unreviewed > 0) {
      throw new BadRequestException(
        `${unreviewed} line${unreviewed === 1 ? "" : "s"} still need${unreviewed === 1 ? "s" : ""} review — open Review to map or dismiss them.`,
      );
    }
    if (payload.supplier && !item.supplierMatchId) {
      throw new BadRequestException("Pick a supplier for this invoice before resolving.");
    }

    const updated = await this.prisma.forTenant().importQueueItem.update({
      where: { id: itemId },
      data: { status: "CLEAN", unmatchedLines: lines.filter((l) => !l.matchedProductId).length },
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
      // Use the invoice's OWN date for costing/AP aging — falling back to
      // today only when the scan genuinely didn't extract one.
      const extractedDate = payload.invoiceDate ? new Date(payload.invoiceDate) : null;
      const billDate =
        extractedDate && !isNaN(extractedDate.getTime()) ? extractedDate : new Date();
      const notes = item.invoiceNumber
        ? formatSupplierInvoiceNote(item.invoiceNumber)
        : "Batch import";
      const bill = await this.vendorBills.create({
        requireSupplier: false,
        supplierId: item.supplierMatchId ?? undefined,
        totalOwed: item.total != null ? Number(item.total) : undefined,
        billDate,
        items: billItems,
        notes,
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
