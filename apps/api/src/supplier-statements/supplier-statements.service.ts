import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { matchSupplier } from "../import/supplier-match";
import { roundMoney } from "@routeflow/pricing";
import { hashFile } from "../vendor-bills/invoice-scan.fingerprint";
import { matchStatementLines, type StatementLineMatch } from "./statement-matcher";
import { fetchMatchableBills } from "./matchable-bills";
import {
  STATEMENT_LINE_KINDS,
  type ParsedStatementLine,
  type ScanStatementFile,
  type StatementLineKind,
} from "./dto/statement.dto";

/**
 * Statements are far more variable than invoices — many suppliers, many
 * layouts, and a misread here moves money. Worth a more capable model than
 * the invoice scanner's; kept as its own constant so the two can diverge.
 */
const STATEMENT_MODEL = "claude-sonnet-5";

/** Extension per accepted upload type — the stored key keeps the original bytes readable. */
const STATEMENT_FILE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

const STATEMENT_SCAN_STATUSES = ["SCANNED", "APPLIED", "DISCARDED"] as const;

/** Promoted columns only — `extractedPayload` is far too large for a list response. */
const STATEMENT_SCAN_LIST_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  pageCount: true,
  byteSize: true,
  fileKey: true,
  supplierNameRaw: true,
  supplierId: true,
  periodStart: true,
  periodEnd: true,
  openingBalance: true,
  closingBalance: true,
  lineCount: true,
  status: true,
  appliedPaymentGroupId: true,
  appliedAt: true,
  appliedById: true,
  scannedById: true,
  createdAt: true,
} as const;

/**
 * Read a supplier statement (a model call, gated behind a fileHash
 * short-circuit) and match its lines against our own vendor bills — matching
 * is pure deterministic code in `statement-matcher.ts`, never the model. The
 * model proposes a reading of the document; the operator (via the review
 * screen this feeds) decides what, if anything, gets applied.
 */
@Injectable()
export class SupplierStatementsService {
  private readonly logger = new Logger(SupplierStatementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly platformConfig: PlatformConfigService,
    // Standalone module, imported directly — importing ImportModule or
    // VendorBillsModule here would deadlock the injector (see
    // duplicate-match.module.ts).
    private readonly duplicateMatch: DuplicateMatchService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Extract a supplier statement, and keep every part of it: the document,
   * the verbatim model output, and the deterministic match against our bills.
   *
   * Re-uploading bytes already scanned returns the stored payload — rematched
   * against whatever the bills look like right now — WITHOUT calling the
   * model: instant, free, and the strongest duplicate signal there is.
   */
  async scanStatement(files: ScanStatementFile[], scannedById?: string) {
    const fileHash = hashFile(files.map((f) => f.buffer));
    const prior = await this.findScanByHash(fileHash);
    if (prior) return this.rematchStoredScan(prior);

    // Key priority: tenant key (SystemConfig) → platform key → env var.
    const tenantKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey = await this.platformConfig.resolveAnthropicKey(tenantKey);
    if (!apiKey || apiKey.length === 0) {
      throw new BadRequestException(
        "AI statement scanning is not available. Please contact your system administrator to configure the ANTHROPIC_API_KEY.",
      );
    }

    // ── Phase 0: normalise inputs ───────────────────────────────────────────
    // Multi-page statements arrive as N images or one PDF. HEIC isn't a Claude
    // vision media type, so convert it to JPEG server-side with sharp before
    // sending. PDFs go through as-is via the `document` content block.
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
          this.logger.error(`scanStatement: HEIC→JPEG conversion failed: ${(e as Error).message}`);
          skippedPages.push(pageNo + 1);
          continue;
        }
      }
      fileContentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: buf.toString("base64") },
      });
    }
    if (fileContentBlocks.length === 0) {
      throw new BadRequestException(
        "Couldn't read any of the uploaded images. Try exporting them as JPEG and re-uploading.",
      );
    }

    // maxRetries:0 — the SDK's default retry (2, each getting its own fresh
    // 110s window) would let a single scan run ~3x past the timeout below,
    // well past the client's 120s abandon point. The review screen's own
    // Retry action (offered only for AI_UNAVAILABLE) is the intended retry
    // path.
    const anthropic = new Anthropic({ apiKey, maxRetries: 0 });

    const promptText = `Extract data from this supplier statement and return JSON only (no markdown, no explanation).

The statement may span MULTIPLE pages — each input image/PDF is one page of the same statement. Combine all lines across all pages into one lines[] array, oldest first.

Return exactly this structure:
{
  "supplier": string or null,
  "periodStart": "YYYY-MM-DD" or null,
  "periodEnd": "YYYY-MM-DD" or null,
  "openingBalance": number or null,
  "closingBalance": number or null,
  "lines": [
    {
      "date": "YYYY-MM-DD" or null,
      "kind": one of "INVOICE", "PAYMENT", "CREDIT", "ADJUSTMENT",
      "refNumber": the invoice/document number as printed, or null,
      "amount": the line's face amount as a positive number,
      "runningBalance": the balance printed after this line, or null
    }
  ],
  "notes": any issues or null
}

IMPORTANT: "amount" is always a positive magnitude — use "kind" to say whether it is money we owe (INVOICE) or money that reduced the balance (PAYMENT, CREDIT). Read every line exactly as printed; do not summarise or omit lines. Return ONLY the JSON object.`;

    let message: Anthropic.Message;
    const startedAt = Date.now();
    try {
      message = await anthropic.messages.create(
        {
          model: STATEMENT_MODEL,
          max_tokens: 4096,
          messages: [
            { role: "user", content: [...fileContentBlocks, { type: "text", text: promptText }] },
          ],
        },
        { timeout: 110_000 },
      );
    } catch (err) {
      const status = (err as { status?: number })?.status;
      this.logger.error(`scanStatement: Anthropic call failed (status ${status}): ${String(err)}`);
      await this.platformConfig.recordAiUsage({
        tenantId: this.prisma.getTenantId(),
        feature: "ocr.supplier_statement",
        model: STATEMENT_MODEL,
        success: false,
      });
      if (status === 401 || status === 403) {
        throw new BadRequestException({
          message:
            "The Anthropic API key is invalid or expired. Go to Settings → AI & Integrations to update it.",
          code: "AI_KEY_INVALID",
        });
      }
      // Non-transient 4xx (bad/oversized/corrupt image, malformed request) —
      // retrying the SAME file will fail identically, unlike a real outage or
      // rate-limit (429/5xx), so don't tell the user to "try again".
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

    // The call succeeded, so the spend is real — record it even if parsing
    // the response fails below.
    await this.platformConfig.recordAiUsage({
      tenantId: this.prisma.getTenantId(),
      feature: "ocr.supplier_statement",
      model: STATEMENT_MODEL,
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    });

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
      this.logger.error(`scanStatement: failed to parse AI response. Raw output:\n${content.text}`);
      throw new UnprocessableEntityException({
        message: "Couldn't read the scan result. Try again — a retry usually works.",
        code: "AI_PARSE_FAILED",
      });
    }
    if (skippedPages.length > 0) {
      const skipNote = `Page${skippedPages.length === 1 ? "" : "s"} ${skippedPages.join(", ")} couldn't be read (HEIC conversion failed) and ${skippedPages.length === 1 ? "was" : "were"} skipped — re-export as JPEG if lines are missing.`;
      const priorNotes = typeof parsed.notes === "string" ? parsed.notes.trim() : "";
      parsed.notes = priorNotes ? `${priorNotes} ${skipNote}` : skipNote;
    }

    // ── Phase 2: deterministic matching (free, instant, model-free) ────────
    const lines = this.normalizeLines(parsed.lines);
    const supplierRaw = typeof parsed.supplier === "string" ? parsed.supplier : null;
    const supplierId = await this.resolveSupplierId(supplierRaw);
    const matches = await this.matchAgainstBills(
      supplierId,
      lines,
      parsed.openingBalance,
      parsed.closingBalance,
    );

    const result = { ...parsed, lines, matches, supplierId };
    const scan = await this.persistScan({
      files,
      fileHash,
      parsed,
      lines,
      result,
      scanDurationMs,
      scannedById,
      supplierId,
    });
    return { ...result, scanId: scan?.id ?? null };
  }

  /** Every statement ever read, newest first. */
  async listScans(status?: string, page = 1, limit = 20) {
    if (
      status &&
      !STATEMENT_SCAN_STATUSES.includes(status as (typeof STATEMENT_SCAN_STATUSES)[number])
    ) {
      throw new BadRequestException(
        `Unknown scan status "${status}" — expected one of ${STATEMENT_SCAN_STATUSES.join(", ")}.`,
      );
    }
    const where = status ? { status: status as any } : {};
    const [data, total] = await Promise.all([
      this.prisma.forTenant().supplierStatementScan.findMany({
        where,
        select: STATEMENT_SCAN_LIST_SELECT,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.forTenant().supplierStatementScan.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /** One statement, rematched against the bills as they stand right now. */
  async getScan(id: string) {
    const scan = await this.prisma.forTenant().supplierStatementScan.findUnique({ where: { id } });
    if (!scan) throw new NotFoundException("Supplier statement scan not found");
    return this.rematchStoredScan(scan);
  }

  /** Read-only lookup by hash — never throws, so a lookup failure just costs a re-scan. */
  private async findScanByHash(fileHash: string) {
    try {
      return await this.prisma.forTenant().supplierStatementScan.findFirst({
        where: { fileHash, status: { not: "DISCARDED" } },
        orderBy: { createdAt: "desc" },
      });
    } catch (e) {
      this.logger.error(`scanStatement: prior-scan lookup failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * A stored scan's payload was matched against whatever bills existed at
   * scan time. Every read (a cache-hit re-upload, or a plain GET) re-runs the
   * pure matcher against the CURRENT bills instead of trusting a stale
   * `matches` array — a bill paid or voided since the scan must be reflected
   * immediately, and matching is free.
   */
  private async rematchStoredScan(scan: Record<string, any>) {
    const payload = scan.extractedPayload;
    const parsed: Record<string, unknown> =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const lines = this.normalizeLines(parsed.lines);
    const supplierId: string | null = scan.supplierId ?? null;
    const matches = await this.matchAgainstBills(
      supplierId,
      lines,
      parsed.openingBalance,
      parsed.closingBalance,
    );
    // A missing or unreachable file must not hide the extraction behind it.
    const fileUrl = scan.fileKey
      ? await this.storage.presignedUrl(scan.fileKey).catch(() => null)
      : null;
    const appliedPayments = await this.fetchAppliedPayments(scan.appliedPaymentGroupId ?? null);
    return {
      ...parsed,
      lines,
      matches,
      supplierId,
      scanId: scan.id,
      status: scan.status ?? null,
      fileKey: scan.fileKey ?? null,
      fileName: scan.fileName ?? null,
      fileUrl,
      createdAt: scan.createdAt ?? null,
      appliedAt: scan.appliedAt ?? null,
      appliedPaymentGroupId: scan.appliedPaymentGroupId ?? null,
      appliedPayments,
    };
  }

  /**
   * Everything one apply wrote, read back off the payment group it stamped.
   * The scan row keeps only the group id, so without this a statement
   * re-opened tomorrow shows a bare "already applied" date with nothing to
   * check — AC 9 says the whole apply must be reconstructable from the scan
   * row plus its payment group, and this is the read half of that.
   *
   * Never throws: the extraction and its matches are what the operator came
   * for, and a failed lookup here must not hide them.
   */
  private async fetchAppliedPayments(paymentGroupId: string | null) {
    if (!paymentGroupId) return [];
    try {
      const payments = await this.prisma.forTenant().billPayment.findMany({
        where: { paymentGroupId },
        select: {
          id: true,
          amount: true,
          reference: true,
          paidAt: true,
          vendorBill: { select: { id: true, billNumber: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      return payments.map((p: any) => ({
        id: p.id,
        billId: p.vendorBill?.id ?? null,
        billNumber: p.vendorBill?.billNumber ?? null,
        amount: Number(p.amount),
        // `statement-apply.service.ts` stamps the implied-paid loop's rows with
        // their own reference prefix — the only thing that tells a bill the
        // operator confirmed off a statement line apart from one the separate
        // implied-paid panel marked settled.
        impliedPaid:
          typeof p.reference === "string" && p.reference.startsWith("STATEMENT-IMPLIED-"),
        paidAt: p.paidAt ?? null,
      }));
    } catch (e) {
      this.logger.error(`getScan: applied-payment lookup failed: ${(e as Error).message}`);
      return [];
    }
  }

  /** Record the scan and file it under its fileHash. Never throws. */
  private async persistScan(args: {
    files: ScanStatementFile[];
    fileHash: string;
    parsed: Record<string, unknown>;
    lines: ParsedStatementLine[];
    result: Record<string, unknown>;
    scanDurationMs: number;
    scannedById?: string;
    supplierId: string | null;
  }): Promise<{ id: string } | null> {
    const { files, fileHash, parsed, lines, result } = args;
    try {
      const scan = await this.prisma.forTenant().supplierStatementScan.create({
        data: {
          fileName: files[0]?.fileName ?? null,
          mimeType: files[0]?.mimeType ?? null,
          byteSize: files.reduce((sum, f) => sum + f.buffer.length, 0),
          pageCount: files.length,
          fileHash,
          extractedPayload: result as unknown as Prisma.InputJsonValue,
          model: STATEMENT_MODEL,
          scanDurationMs: args.scanDurationMs,
          supplierNameRaw: typeof parsed.supplier === "string" ? parsed.supplier : null,
          supplierId: args.supplierId ?? null,
          periodStart: this.parseDate(parsed.periodStart as string | null),
          periodEnd: this.parseDate(parsed.periodEnd as string | null),
          openingBalance: this.moneyOrNull(parsed.openingBalance),
          closingBalance: this.moneyOrNull(parsed.closingBalance),
          lineCount: lines.length,
          scannedById: args.scannedById ?? null,
        },
        select: { id: true },
      });

      const fileKey = await this.storeScanFiles(scan.id, files);
      if (fileKey) {
        await this.prisma
          .forTenant()
          .supplierStatementScan.update({ where: { id: scan.id }, data: { fileKey } });
      }
      return scan;
    } catch (e) {
      this.logger.error(`scanStatement: failed to persist scan: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Store the pages as received and return the FIRST page's key — `fileKey`
   * is singular, so the remaining pages live alongside it under the same
   * `supplier-statements/<scanId>/` prefix. Returns null on any failure: the
   * extraction is what the operator is waiting for, the file is a convenience.
   */
  private async storeScanFiles(scanId: string, files: ScanStatementFile[]): Promise<string | null> {
    try {
      const keys = await Promise.all(
        files.map((f, i) => {
          const ext = STATEMENT_FILE_EXTENSIONS[f.mimeType] ?? "bin";
          const key = `supplier-statements/${scanId}/${i + 1}.${ext}`;
          return this.storage.upload(key, f.buffer, f.mimeType);
        }),
      );
      return keys[0] ?? null;
    } catch (e) {
      this.logger.error(
        `scanStatement: failed to store scan ${scanId} files: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /** Best-effort resolve of the statement's raw supplier text to a real Supplier. */
  private async resolveSupplierId(supplierRaw: string | null): Promise<string | null> {
    if (!supplierRaw) return null;
    const suppliers = await this.prisma.forTenant().supplier.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    return matchSupplier(supplierRaw, suppliers)?.id ?? null;
  }

  /**
   * Fetch the resolved supplier's non-VOID bills and run the pure matcher.
   * No supplier resolved ⇒ no candidates ⇒ every line comes back UNMATCHED,
   * which is the correct, honest answer rather than a guess.
   */
  private async matchAgainstBills(
    supplierId: string | null,
    lines: ParsedStatementLine[],
    openingBalance: unknown,
    closingBalance: unknown,
  ): Promise<StatementLineMatch[]> {
    // REG-B117: the shared, uncapped helper (matchable-bills.ts) — this
    // service's own capped copy of the candidate-pool query is retired; the
    // guard spec fails if it ever grows back. The injected normalizer is
    // passed through so the existing DI-based coverage on this path is
    // undisturbed.
    const bills = await fetchMatchableBills(this.prisma, supplierId, (raw) =>
      this.duplicateMatch.normalizeNumber(raw),
    );
    return matchStatementLines(lines, bills, {
      openingBalance: this.numberOrNull(openingBalance),
      closingBalance: this.numberOrNull(closingBalance),
    });
  }

  private normalizeLines(raw: unknown): ParsedStatementLine[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => {
      const line = (entry ?? {}) as Record<string, unknown>;
      const kind: StatementLineKind = STATEMENT_LINE_KINDS.includes(line.kind as StatementLineKind)
        ? (line.kind as StatementLineKind)
        : "ADJUSTMENT";
      const amount = Number(line.amount);
      const runningBalance = Number(line.runningBalance);
      return {
        date: typeof line.date === "string" ? line.date : null,
        kind,
        refNumber:
          typeof line.refNumber === "string" && line.refNumber.trim().length > 0
            ? line.refNumber.trim()
            : null,
        amount: Number.isFinite(amount) ? amount : 0,
        runningBalance: Number.isFinite(runningBalance) ? runningBalance : null,
      };
    });
  }

  private numberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private moneyOrNull(value: unknown): Prisma.Decimal | null {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? new Prisma.Decimal(roundMoney(n)) : null;
  }

  private parseDate(value?: string | Date | null): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
}
