import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ImportEntityType, MigrationSource, Prisma, StagingRecordStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { productCategoryViolation, productNameViolation } from "../common/text-cell-guards";
import { ExternalRefService } from "./external-ref.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { StagedRow } from "./connectors/source-connectors";
import { parseImportMoney, parseImportNumber } from "./parse-import-number";

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Safely coerce an unknown JSON value to a string (objects/arrays → ""). */
/** The staging flag on a record whose product name starts with a spreadsheet formula character (B964-2). */
const UNSAFE_NAME_FLAG = "unsafe-name";
/** The staging flag on a record whose free-text product category starts with a spreadsheet formula character (B990). */
const UNSAFE_CATEGORY_FLAG = "unsafe-category";
/** The staging flag on a PRODUCT whose price is present but not a non-negative number (B205): skipped, never priced 0. */
const BAD_PRICE_FLAG = "bad-price";
/** The staging flag on a record whose commit threw at confirm (B334): skipped on its own, the job still confirms. */
const COMMIT_FAILED_FLAG = "commit-failed";

/** An optional "$", then plain digits or comma-grouped thousands (groups of three), then an optional ".dd..." tail. */
const PRICE_SHAPE = /^\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
/** Largest value a Decimal(10,2) price column holds. */
const MAX_PRICE = 99_999_999.99;

/**
 * A staged product's price as the canonical money string ("1,234.56" -> "1234.56"), "" when absent, or null when
 * present but not a non-negative number (B205). The Migration Hub's CSV path hands the cell text through verbatim.
 */
function normalizedPrice(payload: Record<string, unknown>): string | null {
  const raw = payload.pricePerUnit ?? payload.price;
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return "";
  // Strict shape: "12,50" (decimal comma), "12abc" and "1e3" must not parse to a different price.
  if (typeof raw === "string" && !PRICE_SHAPE.test(raw.trim())) return null;
  const n = parseImportMoney(raw);
  return Number.isFinite(n) && n >= 0 && n <= MAX_PRICE ? n.toFixed(2) : null;
}

/** The flag a staged PRODUCT payload earns (name first, then category), or null when it is safe to commit. */
function unsafeProductFlag(payload: Record<string, unknown>): string | null {
  if (productNameViolation({ name: str(payload.name) })) return UNSAFE_NAME_FLAG;
  if (productCategoryViolation(optStr(payload.category))) return UNSAFE_CATEGORY_FLAG;
  if (normalizedPrice(payload) === null) return BAD_PRICE_FLAG;
  return null;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}
/** Coerce to a non-empty string, or undefined. */
function optStr(v: unknown): string | undefined {
  const s = str(v);
  return s.length > 0 ? s : undefined;
}
/** Coerce to a finite number, or undefined. */
function optNum(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = parseImportNumber(v); // "1,000" -> 1000 (a bare Number() gave NaN and dropped it)
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Two-phase migration (spec §3): fetch/parse a source into a STAGING area
 * (nothing live), review counts + dedup flags, then CONFIRM to live with a 24h
 * undo window. Re-running upserts by external id (never duplicates). Product +
 * supplier committers are wired end-to-end; customer/invoice/payment records are
 * staged and dedup-flagged, and their commit reuses the existing CSV importers
 * (framework-ready follow-up — `commit()` returns null so they are marked SKIPPED
 * rather than silently dropped).
 */
@Injectable()
export class MigrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly externalRefs: ExternalRefService,
    private readonly dupMatch: DuplicateMatchService,
  ) {}

  /** Start a migration run for a source. */
  async createJob(dto: { source: MigrationSource; createdById?: string }) {
    const tenantId = this.requireTenant();
    return this.prisma.forTenant().migrationJob.create({
      data: {
        tenantId,
        source: dto.source,
        status: "FETCHING",
        createdById: dto.createdById ?? null,
      },
    });
  }

  /**
   * Add staged rows to a job (from a CSV/paper upload or a connector fetch),
   * running dedup so each record carries a verdict + link BEFORE anything is live.
   */
  async stageRecords(jobId: string, rows: StagedRow[]) {
    const tenantId = this.requireTenant();
    const job = await this.getJobOrThrow(jobId);
    const sourceKey = job.source.toLowerCase();

    for (const row of rows) {
      const entityType = row.entityType as ImportEntityType;
      const flags: string[] = [];
      let matchedEntityId: string | null = null;
      let status: StagingRecordStatus = "PENDING";

      // 1) external-id dedup — a re-run of the same source.
      if (row.externalId) {
        const existing = await this.externalRefs.findLocalId(entityType, sourceKey, row.externalId);
        if (existing) {
          matchedEntityId = existing;
          flags.push("duplicate");
          status = "DUPLICATE";
        }
      }
      // 2) secondary invoice match — same document via a second path (§2).
      if (!matchedEntityId && entityType === "INVOICE") {
        const p = row.payload as { number?: string; total?: number; issueDate?: string };
        const dup = await this.dupMatch.findInvoiceDuplicate({
          number: p.number,
          total: Number(p.total ?? 0),
          issueDate: p.issueDate ? new Date(p.issueDate) : new Date(),
        });
        if (dup) {
          matchedEntityId = dup.id;
          flags.push("duplicate");
          status = "DUPLICATE";
        }
      }

      // B964-2: a formula-led product name can never be committed (products.create refuses it), so it is staged SKIPPED
      // now: the preview shows it as skipped, and confirmJob never meets it.
      const unsafe =
        status === "PENDING" && entityType === "PRODUCT"
          ? unsafeProductFlag(row.payload as Record<string, unknown>)
          : null;
      if (unsafe) {
        status = "SKIPPED";
        flags.push(unsafe);
      }

      // B205: a thousands-comma price is stored canonical ("1,234.56" -> "1234.56"), so preview and commit agree.
      let payload = row.payload as Record<string, unknown>;
      if (entityType === "PRODUCT" && status === "PENDING") {
        const price = normalizedPrice(payload);
        if (price) payload = { ...payload, pricePerUnit: price };
      }

      await this.prisma.forTenant().migrationStagingRecord.create({
        data: {
          tenantId,
          jobId,
          entityType,
          externalId: row.externalId ?? null,
          rawPayload: payload as object,
          status,
          flags,
          matchedEntityId,
        },
      });
    }

    await this.recomputeScope(jobId);
    return this.getJob(jobId);
  }

  /** Job with per-status counts + a linked list of detected duplicates. */
  async getJob(jobId: string) {
    const job = await this.getJobOrThrow(jobId);
    const byStatus = await this.prisma.forTenant().migrationStagingRecord.groupBy({
      by: ["status"],
      where: { jobId },
      _count: true,
    });
    const duplicates = await this.prisma.forTenant().migrationStagingRecord.findMany({
      where: { jobId, status: "DUPLICATE" },
      select: { id: true, entityType: true, externalId: true, matchedEntityId: true },
      take: 100,
    });
    const statusCounts: Record<string, number> = {};
    for (const s of byStatus) statusCounts[s.status] = s._count as unknown as number;
    return { job, statusCounts, duplicates };
  }

  /** Recent migration runs (import history). */
  async listJobs() {
    return this.prisma.forTenant().migrationJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  /** Commit PENDING records to live, tag external refs, open the 24h undo window. */
  async confirmJob(jobId: string) {
    const job = await this.getJobOrThrow(jobId);
    if (job.status === "CONFIRMED") throw new ConflictException("Migration already confirmed.");
    if (job.status === "UNDONE") throw new BadRequestException("Migration was undone.");
    const sourceKey = job.source.toLowerCase();

    const pending = await this.prisma.forTenant().migrationStagingRecord.findMany({
      where: { jobId, status: "PENDING" },
    });

    let committed = 0;
    let skipped = 0;
    for (const rec of pending) {
      // B964-2: a record staged before the stage-time check (or edited since) is skipped here without calling
      // products.create (it would refuse a formula-led name or a bad price), like any other uncommittable record.
      const unsafe =
        rec.entityType === "PRODUCT"
          ? unsafeProductFlag(rec.rawPayload as Record<string, unknown>)
          : null;
      if (unsafe) {
        const prior = Array.isArray(rec.flags) ? (rec.flags as string[]) : [];
        await this.prisma.forTenant().migrationStagingRecord.update({
          where: { id: rec.id },
          data: { status: "SKIPPED", flags: [...prior, unsafe] },
        });
        skipped++;
        continue;
      }
      // B334: one row that cannot be created (a duplicate name, a vanished category) is skipped on its own, with a
      // code and never the server's text. Earlier rows stay live, the job still reaches CONFIRMED, and the undo
      // window covers them; a throw here used to leave the job STAGED for good (undo needs CONFIRMED).
      let createdId: string | null;
      try {
        createdId = await this.commit(rec.entityType, rec.rawPayload as Record<string, unknown>);
      } catch (e) {
        // Only a row-level refusal (an HTTP 4xx from the service, a Prisma constraint error) skips the row; an outage
        // or timeout must surface, or every remaining row would be SKIPPED and the job could never be retried.
        const rowLevel =
          e instanceof HttpException ||
          (e instanceof Prisma.PrismaClientKnownRequestError &&
            ["P2002", "P2003"].includes(e.code));
        if (!rowLevel) throw e;
        const prior = Array.isArray(rec.flags) ? (rec.flags as string[]) : [];
        await this.prisma.forTenant().migrationStagingRecord.update({
          where: { id: rec.id },
          data: { status: "SKIPPED", flags: [...prior, COMMIT_FAILED_FLAG] },
        });
        skipped++;
        continue;
      }
      if (createdId) {
        // The entity is live: COMMITTED + createdEntityId must land even if the external-ref write fails, so undo can
        // remove it and a second confirm cannot create it again.
        await this.prisma.forTenant().migrationStagingRecord.update({
          where: { id: rec.id },
          data: { status: "COMMITTED", createdEntityId: createdId },
        });
        if (rec.externalId) {
          try {
            await this.externalRefs.record(rec.entityType, createdId, sourceKey, rec.externalId);
          } catch {
            // best effort: the ref only helps later re-imports match this row
          }
        }
        committed++;
      } else {
        const flags = Array.isArray(rec.flags) ? (rec.flags as string[]) : [];
        await this.prisma.forTenant().migrationStagingRecord.update({
          where: { id: rec.id },
          data: { status: "SKIPPED", flags: [...flags, "commit-not-wired"] },
        });
        skipped++;
      }
    }

    const confirmedAt = new Date();
    const undoDeadline = new Date(confirmedAt.getTime() + UNDO_WINDOW_MS);
    await this.prisma.forTenant().migrationJob.update({
      where: { id: jobId },
      data: { status: "CONFIRMED", confirmedAt, undoDeadline },
    });
    return { committed, skipped, undoDeadline };
  }

  /**
   * Reverse a confirmed migration within 24h — delete exactly the rows it created
   * and drop their external refs so a fresh re-run re-imports cleanly (spec §3/§5).
   */
  async undoJob(jobId: string) {
    const job = await this.getJobOrThrow(jobId);
    if (job.status !== "CONFIRMED") {
      throw new BadRequestException("Only a confirmed migration can be undone.");
    }
    if (job.undoDeadline && new Date() > job.undoDeadline) {
      throw new BadRequestException("The 24-hour undo window has passed.");
    }
    const committed = await this.prisma.forTenant().migrationStagingRecord.findMany({
      where: { jobId, status: "COMMITTED", createdEntityId: { not: null } },
    });

    // Atomic: either the whole migration reverses or nothing changes. A row that
    // can't be deleted (e.g. a migrated product already used on an order) rolls the
    // undo back with a clear error rather than leaving a half-reversed, stuck job.
    const reversed = await this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      let n = 0;
      for (const rec of committed) {
        const id = rec.createdEntityId as string;
        try {
          if (rec.entityType === "PRODUCT") await tx.product.delete({ where: { id } });
          else if (rec.entityType === "SUPPLIER") await tx.supplier.delete({ where: { id } });
        } catch {
          throw new ConflictException(
            `Cannot undo: a migrated ${rec.entityType.toLowerCase()} is already in use. Nothing was reversed.`,
          );
        }
        // Drop the external ref so a fresh re-migration re-creates the row.
        await tx.importExternalRef.deleteMany({
          where: { entityType: rec.entityType, entityId: id },
        });
        await tx.migrationStagingRecord.update({
          where: { id: rec.id },
          data: { status: "REVERSED" },
        });
        n++;
      }
      await tx.migrationJob.update({
        where: { id: jobId },
        data: { status: "UNDONE", undoneAt: new Date() },
      });
      return n;
    });
    return { reversed };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Create the live row for a staged record; null when the type isn't wired yet. */
  private async commit(
    entityType: ImportEntityType,
    payload: Record<string, unknown>,
  ): Promise<string | null> {
    switch (entityType) {
      case "PRODUCT": {
        const created = await this.products.create({
          name: str(payload.name),
          sku: optStr(payload.sku),
          unit: str(payload.unit) || "each",
          pricePerUnit: normalizedPrice(payload) || "0",
          barcode: optStr(payload.barcode),
          category: optStr(payload.category),
          unitsPerBox: optNum(payload.unitsPerBox),
        });
        return created.id;
      }
      case "SUPPLIER": {
        const created = await this.prisma.forTenant().supplier.create({
          data: {
            tenantId: this.requireTenant(),
            name: str(payload.name),
            contactName: optStr(payload.contactName),
            email: optStr(payload.email),
            phone: optStr(payload.phone),
          },
        });
        return created.id;
      }
      default:
        // CUSTOMER / INVOICE / PAYMENT commit reuses the existing CSV importers.
        return null;
    }
  }

  private async recomputeScope(jobId: string) {
    const counts = await this.prisma.forTenant().migrationStagingRecord.groupBy({
      by: ["entityType"],
      where: { jobId },
      _count: true,
    });
    const scopeCounts: Record<string, number> = {};
    for (const c of counts) scopeCounts[c.entityType] = c._count as unknown as number;
    await this.prisma.forTenant().migrationJob.update({
      where: { id: jobId },
      data: { status: "STAGED", scopeCounts },
    });
  }

  private async getJobOrThrow(jobId: string) {
    const job = await this.prisma.forTenant().migrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException("Migration job not found");
    return job;
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
