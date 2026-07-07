import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ImportEntityType, MigrationSource, StagingRecordStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { ExternalRefService } from "./external-ref.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { StagedRow } from "./connectors/source-connectors";

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  private readonly logger = new Logger(MigrationService.name);

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

      await this.prisma.forTenant().migrationStagingRecord.create({
        data: {
          tenantId,
          jobId,
          entityType,
          externalId: row.externalId ?? null,
          rawPayload: row.payload as object,
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
      const createdId = await this.commit(
        rec.entityType,
        rec.rawPayload as Record<string, unknown>,
      );
      if (createdId) {
        if (rec.externalId) {
          await this.externalRefs.record(rec.entityType, createdId, sourceKey, rec.externalId);
        }
        await this.prisma.forTenant().migrationStagingRecord.update({
          where: { id: rec.id },
          data: { status: "COMMITTED", createdEntityId: createdId },
        });
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

    let reversed = 0;
    for (const rec of committed) {
      await this.deleteCreated(
        rec.entityType,
        rec.createdEntityId as string,
        job.source.toLowerCase(),
      );
      await this.prisma.forTenant().migrationStagingRecord.update({
        where: { id: rec.id },
        data: { status: "REVERSED" },
      });
      reversed++;
    }
    await this.prisma.forTenant().migrationJob.update({
      where: { id: jobId },
      data: { status: "UNDONE", undoneAt: new Date() },
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
          name: String(payload.name ?? ""),
          sku: payload.sku ? String(payload.sku) : undefined,
          unit: payload.unit ? String(payload.unit) : "each",
          pricePerUnit: String(payload.pricePerUnit ?? payload.price ?? "0"),
          barcode: payload.barcode ? String(payload.barcode) : undefined,
          category: payload.category ? String(payload.category) : undefined,
          unitsPerBox: payload.unitsPerBox != null ? Number(payload.unitsPerBox) : undefined,
        });
        return created.id;
      }
      case "SUPPLIER": {
        const created = await this.prisma.forTenant().supplier.create({
          data: {
            tenantId: this.requireTenant(),
            name: String(payload.name ?? ""),
            contactName: payload.contactName ? String(payload.contactName) : undefined,
            email: payload.email ? String(payload.email) : undefined,
            phone: payload.phone ? String(payload.phone) : undefined,
          },
        });
        return created.id;
      }
      default:
        // CUSTOMER / INVOICE / PAYMENT commit reuses the existing CSV importers.
        return null;
    }
  }

  private async deleteCreated(entityType: ImportEntityType, id: string, sourceKey: string) {
    if (entityType === "PRODUCT") {
      await this.prisma.forTenant().product.deleteMany({ where: { id } });
    } else if (entityType === "SUPPLIER") {
      await this.prisma.forTenant().supplier.deleteMany({ where: { id } });
    }
    // Drop the external ref so a re-migration re-creates the row rather than
    // "upsert"-ing onto a now-deleted id.
    await this.prisma.forTenant().importExternalRef.deleteMany({
      where: { entityType, entityId: id },
    });
    this.logger.debug(`Reversed ${entityType} ${id} (source ${sourceKey}).`);
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
