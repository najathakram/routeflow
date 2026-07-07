import { BadRequestException, Injectable } from "@nestjs/common";
import { ImportEntityType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Idempotency by external source id (spec §2). Records the mapping from a
 * source's id (e.g. Zoho `inv_884412`) to the local row it created, in a side
 * table — so re-running a migration/import UPSERTS by external id and never
 * duplicates, WITHOUT adding columns to off-limits finance models. Consumed by
 * the migration (Phase 4) and batch (Phase 5) flows.
 */
@Injectable()
export class ExternalRefService {
  constructor(private readonly prisma: PrismaService) {}

  /** Parse a combined external ref "zoho:inv_884412" → { source, externalId }. */
  parse(ref: string): { source: string; externalId: string } | null {
    const raw = (ref ?? "").trim();
    const i = raw.indexOf(":");
    if (i <= 0 || i >= raw.length - 1) return null;
    return { source: raw.slice(0, i), externalId: raw.slice(i + 1) };
  }

  /** Record/refresh the mapping (source, externalId) → local entityId. Idempotent. */
  async record(
    entityType: ImportEntityType,
    entityId: string,
    externalSource: string,
    externalId: string,
  ): Promise<void> {
    const tenantId = this.requireTenant();
    await this.prisma.forTenant().importExternalRef.upsert({
      where: {
        tenantId_externalSource_externalId_entityType: {
          tenantId,
          externalSource,
          externalId,
          entityType,
        },
      },
      create: { tenantId, entityType, entityId, externalSource, externalId },
      update: { entityId },
    });
  }

  /** The local id previously mapped to (source, externalId), or null. */
  async findLocalId(
    entityType: ImportEntityType,
    externalSource: string,
    externalId: string,
  ): Promise<string | null> {
    const tenantId = this.requireTenant();
    const row = await this.prisma.forTenant().importExternalRef.findUnique({
      where: {
        tenantId_externalSource_externalId_entityType: {
          tenantId,
          externalSource,
          externalId,
          entityType,
        },
      },
      select: { entityId: true },
    });
    return row?.entityId ?? null;
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }
}
