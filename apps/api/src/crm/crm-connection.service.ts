import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type CrmTriggerMode } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";
import { AuditService } from "../audit/audit.service";
import { CrmAuthError, GoHighLevelClient } from "./gohighlevel/gohighlevel.client";
import { GHL_CLIENT_FACTORY, type GhlClientFactory } from "./crm.types";
import { SaveCrmConnectionDto } from "./dto/save-crm-connection.dto";
import { UpdateCrmConfigDto } from "./dto/update-crm-config.dto";
import { ListHandoffsDto } from "./dto/list-handoffs.dto";

interface CrmConnectionRow {
  id?: string;
  tenantId?: string;
  status?: string;
  enabled?: boolean;
  dryRun?: boolean;
  triggerMode?: string;
  pipelineId?: string | null;
  stageId?: string | null;
  stageName?: string | null;
  locationId?: string;
  locationName?: string | null;
  secretCipher?: string | null;
  tokenLast4?: string | null;
  startFrom?: Date | string;
  writeBackFields?: boolean;
  writeBackTag?: boolean;
  writeBackNote?: boolean;
  markWon?: boolean;
  defaultRegion?: string;
  lastPollAt?: Date | string | null;
  lastSuccessAt?: Date | string | null;
  lastError?: string | null;
  attentionNotifiedAt?: Date | string | null;
  [key: string]: unknown;
}

/** The ONLY connection shape that ever crosses a controller boundary (R1/R7, F3). */
export interface CrmConnectionStatusView {
  status?: string;
  enabled?: boolean;
  dryRun?: boolean;
  triggerMode?: string;
  pipelineId: string | null;
  stageId: string | null;
  stageName: string | null;
  locationId?: string;
  locationName: string | null;
  tokenLast4: string | null;
  startFrom?: Date | string;
  writeBackFields?: boolean;
  writeBackTag?: boolean;
  writeBackNote?: boolean;
  markWon?: boolean;
  defaultRegion?: string;
  lastPollAt: Date | string | null;
  lastSuccessAt: Date | string | null;
  lastError: string | null;
}

/** Only the keys spec R4 lets `PATCH /config` write — assignable to both Prisma inputs. */
interface CrmConfigPatch {
  enabled?: boolean;
  dryRun?: boolean;
  triggerMode?: CrmTriggerMode;
  pipelineId?: string;
  stageId?: string;
  stageName?: string;
  startFrom?: Date;
  writeBackFields?: boolean;
  writeBackTag?: boolean;
  writeBackNote?: boolean;
  markWon?: boolean;
  defaultRegion?: string;
}

/** Spec R4 first-save defaults (owner ruling 2026-09-12: the pilot client's region is US). */
const CONFIG_DEFAULTS = {
  enabled: false,
  dryRun: true,
  triggerMode: "STAGE" as CrmTriggerMode,
  writeBackFields: true,
  writeBackTag: true,
  writeBackNote: true,
  markWon: false,
  defaultRegion: "US",
};

/**
 * R22 Activity-table projection (#7). Exactly the columns the web table renders — `payload`
 * (the raw GHL contact/opportunity snapshot) and `nextAttemptAt` stay server-side.
 */
const HANDOFF_LIST_SELECT = {
  id: true,
  opportunityId: true,
  opportunityName: true,
  contactId: true,
  contactName: true,
  status: true,
  matchedBy: true,
  reason: true,
  customerId: true,
  attempts: true,
  createdAt: true,
  processedAt: true,
} satisfies Prisma.CrmHandoffSelect;

/** ISO-3166 alpha-2, the only thing `defaultRegion` may ever hold (M12). */
const ISO_3166_ALPHA2 = /^[A-Z]{2}$/;

/**
 * CrmConnection CRUD + read-model for the GoHighLevel connector (spec R1-R7, R22). The
 * matching/write-back pipeline (WP3) reads `CrmConnection`/`CrmHandoff` directly; this
 * service is the tenant-facing surface behind `CrmController`.
 */
@Injectable()
export class CrmConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly client: GoHighLevelClient,
    @Inject(GHL_CLIENT_FACTORY) private readonly clientFactory: GhlClientFactory,
  ) {}

  /** The only place `EncryptionService.decrypt` is called for a CRM connection (spec R1). */
  async decryptToken(row: CrmConnectionRow): Promise<string> {
    if (!row.secretCipher) {
      throw new CrmAuthError("No GoHighLevel token is saved for this connection.");
    }
    return this.encryption.decrypt(row.secretCipher);
  }

  /**
   * Projects a raw `CrmConnection` row onto the safe view (F3). Never carries
   * `secretCipher`, and `tokenLast4` is the only trace of the token that survives —
   * defense in depth: even if a raw `token` field somehow ended up on the row, only its
   * last 4 characters leave this method.
   */
  private toStatusView(row: CrmConnectionRow): CrmConnectionStatusView {
    const tokenLast4 =
      typeof row.tokenLast4 === "string"
        ? row.tokenLast4
        : typeof row.token === "string"
          ? (row.token as string).slice(-4)
          : null;

    return {
      status: row.status,
      enabled: row.enabled,
      dryRun: row.dryRun,
      triggerMode: row.triggerMode,
      pipelineId: row.pipelineId ?? null,
      stageId: row.stageId ?? null,
      stageName: row.stageName ?? null,
      locationId: row.locationId,
      locationName: row.locationName ?? null,
      tokenLast4,
      startFrom: row.startFrom,
      writeBackFields: row.writeBackFields,
      writeBackTag: row.writeBackTag,
      writeBackNote: row.writeBackNote,
      markWon: row.markWon,
      defaultRegion: row.defaultRegion,
      lastPollAt: row.lastPollAt ?? null,
      lastSuccessAt: row.lastSuccessAt ?? null,
      lastError: row.lastError ?? null,
    };
  }

  // spec R7: `GET /crm/gohighlevel` — connection status + counts, never the secret.
  async getStatus(tenantId: string): Promise<{
    connection: CrmConnectionStatusView | null;
    counts: {
      pending: number;
      needsReview: number;
      created: number;
      linked: number;
      dryRun: number;
      failed: number;
    };
  }> {
    const row = (await this.prisma.crmConnection.findUnique({
      where: { tenantId },
    })) as CrmConnectionRow | null;

    // M13: aggregate in the database — never load every handoff row just to count them.
    const grouped = ((await this.prisma.crmHandoff.groupBy({
      by: ["status"],
      where: { tenantId },
      _count: { _all: true },
    })) ?? []) as unknown as Array<{
      status: string;
      _count?: number | { _all?: number };
    }>;
    const countOf = (status: string): number => {
      const hit = grouped.find((g) => g?.status === status);
      if (!hit) return 0;
      return typeof hit._count === "number" ? hit._count : (hit._count?._all ?? 0);
    };
    const counts = {
      pending: countOf("PENDING") + countOf("WRITEBACK_PENDING"),
      needsReview: countOf("NEEDS_REVIEW"),
      created: countOf("CREATED"),
      linked: countOf("LINKED"),
      dryRun: countOf("DRY_RUN"),
      failed: countOf("FAILED"),
    };

    if (!row) return { connection: null, counts };
    return { connection: this.toStatusView(row), counts };
  }

  // spec R1: encrypted storage, raw token never persisted/logged, audited.
  async saveConnection(
    tenantId: string,
    dto: SaveCrmConnectionDto,
    userId: string,
  ): Promise<CrmConnectionStatusView> {
    const secretCipher = this.encryption.encrypt(dto.token);
    const data = {
      locationId: dto.locationId,
      secretCipher,
      tokenLast4: dto.token.slice(-4),
      status: "DISCONNECTED" as const,
    };

    // F11: one atomic upsert — the old update→catch(P2025)→create pair raced under
    // concurrent saves and only ever set `connectedById` on the create branch.
    const row = (await this.prisma.crmConnection.upsert({
      where: { tenantId },
      create: { tenantId, ...data, connectedById: userId },
      update: { ...data, connectedById: userId },
    })) as CrmConnectionRow;

    await this.audit.log({
      tenantId,
      userId,
      action: "crm.connection.saved",
      entityType: "crm_connection",
      entityId: row?.id ?? tenantId,
    });
    return this.toStatusView(row);
  }

  // spec R2: 2xx -> CONNECTED + locationName (+defaultRegion from country); 401 -> NEEDS_ATTENTION.
  async testConnection(tenantId: string): Promise<{
    ok: boolean;
    locationName?: string;
    reason?: string;
    connection: CrmConnectionStatusView | null;
  }> {
    const conn = (await this.prisma.crmConnection.findUnique({
      where: { tenantId },
    })) as CrmConnectionRow | null;
    if (!conn) {
      return { ok: false, reason: "not-connected", connection: null };
    }

    try {
      const token = await this.decryptToken(conn);
      const result = (await this.client.getLocation({ token, locationId: conn.locationId })) as {
        location?: { name?: string; country?: string };
      };
      const locationName = result?.location?.name ?? null;
      const country = result?.location?.country;
      const row = (await this.prisma.crmConnection.update({
        where: { tenantId },
        data: {
          status: "CONNECTED",
          locationName,
          lastError: null,
          attentionNotifiedAt: null,
          // M12: a garbage `country` must never reach `defaultRegion` — it silently breaks
          // phone matching for every later lead.
          ...(typeof country === "string" && ISO_3166_ALPHA2.test(country)
            ? { defaultRegion: country }
            : {}),
        },
      })) as CrmConnectionRow;
      return {
        ok: true,
        locationName: locationName ?? undefined,
        connection: this.toStatusView(row),
      };
    } catch (e) {
      // M5: only a connection that WAS working can "lose access" — retesting a deliberately
      // disconnected one must not claim GoHighLevel revoked the token.
      if (e instanceof CrmAuthError && conn.status === "CONNECTED") {
        const row = (await this.prisma.crmConnection.update({
          where: { tenantId },
          data: { status: "NEEDS_ATTENTION", lastError: e.message },
        })) as CrmConnectionRow;
        return { ok: false, reason: e.message, connection: this.toStatusView(row) };
      }
      return { ok: false, reason: (e as Error).message, connection: this.toStatusView(conn) };
    }
  }

  // spec R5: wipes the secret, disconnects; history/ExternalRefs are kept.
  async disconnect(tenantId: string, userId: string): Promise<CrmConnectionStatusView> {
    const row = (await this.prisma.crmConnection.update({
      where: { tenantId },
      data: {
        secretCipher: null,
        status: "DISCONNECTED",
        enabled: false,
        // M2: everything that describes the now-removed key/location goes with it, or the
        // UI keeps showing a stale key + location after Disconnect.
        tokenLast4: null,
        locationName: null,
        lastError: null,
        attentionNotifiedAt: null,
        // `customFieldIds` is a nullable Json column: SQL NULL is `Prisma.DbNull`, not `null`.
        customFieldIds: Prisma.DbNull,
      },
    })) as CrmConnectionRow;

    await this.audit.log({
      tenantId,
      userId,
      action: "crm.connection.removed",
      entityType: "crm_connection",
      entityId: row?.id ?? tenantId,
    });
    return this.toStatusView(row);
  }

  // spec R4: config patch; STAGE mode requires pipelineId+stageId before it can be enabled.
  async updateConfig(
    tenantId: string,
    dto: UpdateCrmConfigDto,
    userId: string,
  ): Promise<CrmConnectionStatusView> {
    const conn = (await this.prisma.crmConnection.findUnique({
      where: { tenantId },
    })) as CrmConnectionRow | null;

    const effectiveEnabled = dto.enabled ?? conn?.enabled ?? false;
    const effectiveTriggerMode = dto.triggerMode ?? conn?.triggerMode ?? "STAGE";
    const effectivePipelineId = dto.pipelineId ?? conn?.pipelineId ?? null;
    const effectiveStageId = dto.stageId ?? conn?.stageId ?? null;

    if (
      effectiveEnabled &&
      effectiveTriggerMode === "STAGE" &&
      (!effectivePipelineId || !effectiveStageId)
    ) {
      throw new BadRequestException(
        "Bad Request: select a pipeline and stage before enabling GoHighLevel sync in Stage mode.",
      );
    }

    const patch: CrmConfigPatch = {};
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.dryRun !== undefined) patch.dryRun = dto.dryRun;
    if (dto.triggerMode !== undefined) patch.triggerMode = dto.triggerMode;
    if (dto.pipelineId !== undefined) patch.pipelineId = dto.pipelineId;
    if (dto.stageId !== undefined) patch.stageId = dto.stageId;
    if (dto.stageName !== undefined) patch.stageName = dto.stageName;
    if (dto.startFrom !== undefined) patch.startFrom = new Date(dto.startFrom);
    if (dto.writeBackFields !== undefined) patch.writeBackFields = dto.writeBackFields;
    if (dto.writeBackTag !== undefined) patch.writeBackTag = dto.writeBackTag;
    if (dto.writeBackNote !== undefined) patch.writeBackNote = dto.writeBackNote;
    if (dto.markWon !== undefined) patch.markWon = dto.markWon;
    if (dto.defaultRegion !== undefined) patch.defaultRegion = dto.defaultRegion;

    // F9: a first config change on a tenant with no row used to hit `update` and 500 on
    // P2025. One upsert carries the R4 defaults on the create branch instead.
    const row = (await this.prisma.crmConnection.upsert({
      where: { tenantId },
      create: {
        tenantId,
        // `locationId` is required and has no schema default; the real one arrives with the
        // token via `saveConnection` (R1).
        locationId: conn?.locationId ?? "",
        ...CONFIG_DEFAULTS,
        startFrom: new Date(),
        ...patch,
        connectedById: userId,
      },
      update: { ...patch, connectedById: userId },
    })) as CrmConnectionRow;

    await this.audit.log({
      tenantId,
      userId,
      action: "crm.config.updated",
      entityType: "crm_connection",
      entityId: row?.id ?? tenantId,
    });
    return this.toStatusView(row);
  }

  // spec R3: proxies GET /opportunities/pipelines; drops stage objects missing id/name.
  async listPipelines(tenantId: string): Promise<
    Array<{
      id: string;
      name: string;
      stages: Array<{ id: string; name: string; position?: number }>;
    }>
  > {
    // F4: the tenant's OWN credentials. The shared empty-creds client cannot carry a
    // locationId, so proxying pipelines through it 401s for every tenant, always.
    const conn = (await this.prisma.crmConnection.findUnique({
      where: { tenantId },
    })) as CrmConnectionRow | null;
    if (!conn || !conn.secretCipher) {
      throw new NotFoundException("Connect GoHighLevel before loading pipelines.");
    }

    const client = this.clientFactory.forConnection({
      secretCipher: conn.secretCipher,
      locationId: conn.locationId ?? "",
    });
    const pipelines = (await client.listPipelines()) as Array<{
      id: string;
      name: string;
      stages?: Array<{ id?: string; name?: string; position?: number }>;
    }>;
    return (pipelines ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      stages: (p.stages ?? []).filter(
        (s): s is { id: string; name: string; position?: number } =>
          typeof s.id === "string" && typeof s.name === "string",
      ),
    }));
  }

  // spec R22: newest-first, status filter, limit clamped to <=100, envelope for the web.
  async listHandoffs(
    tenantId: string,
    dto: ListHandoffsDto,
  ): Promise<{ data: unknown[]; total: number; page: number; limit: number }> {
    const limit = Math.min(dto.limit ?? 25, 100);
    const page = dto.page && dto.page > 0 ? dto.page : 1;
    // L-100: tenantId comes from the method argument, never inferred from request context.
    const where: Record<string, unknown> = { tenantId };
    if (dto.status) where.status = dto.status;

    const [data, total] = await Promise.all([
      this.prisma.crmHandoff.findMany({
        where,
        // #7 / R22: an explicit projection — `payload` holds the raw GHL contact/opportunity
        // snapshot and must never be shipped to the Activity table.
        select: HANDOFF_LIST_SELECT,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.crmHandoff.count({ where }),
    ]);

    return { data: (data ?? []) as unknown[], total: total ?? 0, page, limit };
  }
}
