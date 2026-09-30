// GoHighLevel poll service (TP3, T13-T21, T52, T54; spec R8-R13, R21-R23). Loads every
// enabled/CONNECTED tenant connection and pages through `searchOpportunities`, handing each
// new-or-retryable opportunity to `GoHighLevelHandoffService.handle()`. Idempotency and the
// startFrom cutoff live here; matching/creation lives in the handoff service.
//
// NOTE ON THE CRON SITE: `pollAll` is deliberately left UNDECORATED here — it is exercised
// directly by this file's spec with no mock of `../common/db-locks`, so wrapping it in the
// real LeaderCron/`withAdvisoryLock` machinery would attempt a genuine Postgres advisory
// lock connection inside a pure unit test. The actual LeaderCron entry point ("*/3 * * * *",
// job name "crm-gohighlevel.poll") is a thin wrapper registered in `crm.module.ts`
// that just calls `pollAll()` — see that file's `GoHighLevelCronRunner`.
//
// TENANT SCOPING (L-100): every Prisma `where` below carries an explicit `tenantId` taken
// from the method argument (or from the connection row loaded by it) — never inferred.
import { ConflictException, Logger, NotFoundException } from "@nestjs/common";

export interface GoHighLevelPollOptions {
  ignoreCutoff?: boolean;
  /** R23: "Import existing" runs BEFORE ongoing sync is enabled, so it bypasses `enabled`. */
  ignoreEnabledGate?: boolean;
  budgetMs?: number;
}

export interface ImportPreviewSample {
  opportunityName: string;
  contactName?: string;
  email?: string;
  phone?: string;
}

export interface ImportPreviewResult {
  count: number;
  sample: ImportPreviewSample[];
}

export interface CrmSyncCounts {
  fetched: number;
  new: number;
  created: number;
  linked: number;
  needsReview: number;
  dryRun: number;
  failed: number;
  /** R13: set when the tenant is still inside a 429 cooldown window and nothing was polled. */
  skipped?: "cooldown";
}

const TERMINAL_HANDOFF_STATUSES = new Set([
  "CREATED",
  "LINKED",
  "SKIPPED",
  "DRY_RUN",
  "NEEDS_REVIEW",
  "FAILED",
]);
const RETRYABLE_HANDOFF_STATUSES = new Set(["PENDING", "WRITEBACK_PENDING"]);
const REOPENABLE_ON_RETRY = new Set(["DRY_RUN", "NEEDS_REVIEW", "FAILED", "WRITEBACK_PENDING"]);
const DISMISSABLE_STATUSES = new Set(["NEEDS_REVIEW", "FAILED", "DRY_RUN"]);
const DEFAULT_BUDGET_MS = 120_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_SEC = 60;
const MAX_PAGES = 50;
const IMPORT_PREVIEW_SAMPLE_CAP = 20;

/** Handoff status -> the `CrmSyncCounts` key it increments (M1). */
const STATUS_COUNTER: Record<string, keyof CrmSyncCounts> = {
  CREATED: "created",
  LINKED: "linked",
  NEEDS_REVIEW: "needsReview",
  DRY_RUN: "dryRun",
  FAILED: "failed",
};

function emptyCounts(): CrmSyncCounts {
  return { fetched: 0, new: 0, created: 0, linked: 0, needsReview: 0, dryRun: 0, failed: 0 };
}

export class GoHighLevelPollService {
  private readonly logger = new Logger(GoHighLevelPollService.name);

  constructor(
    private readonly prisma: any,
    private readonly clientFactory: (connection: any) => any,
    private readonly handoffService: any,
    private readonly emailService: any,
    /** Optional: threads tenant context (ALS) through the tick. Omitted by every unit test. */
    private readonly tenantCtx?: { run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> },
  ) {}

  /** R8: one tenant's failure never stops the others; each records its own `lastError`. */
  async pollAll(): Promise<void> {
    const now = new Date();
    const connections = await this.prisma.crmConnection.findMany({
      // M7: a tenant inside its 429 cooldown window is not selected for this tick.
      where: {
        enabled: true,
        status: "CONNECTED",
        OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }],
      },
      select: { id: true, tenantId: true },
    });

    for (const c of connections ?? []) {
      try {
        if (this.tenantCtx) {
          await this.tenantCtx.run(c.tenantId, () => this.pollTenant(c.tenantId));
        } else {
          await this.pollTenant(c.tenantId);
        }
      } catch (e) {
        this.logger.warn(`crm poll failed tenant=${c.tenantId}: ${(e as Error).message}`);
        if (c.id) {
          await this.prisma.crmConnection.update({
            where: { id: c.id },
            data: { lastError: (e as Error).message || "poll failed" },
          });
        }
      }
    }
  }

  private async updateConnection(connection: any, data: Record<string, unknown>): Promise<void> {
    await this.prisma.crmConnection.update({ where: { id: connection.id }, data });
    Object.assign(connection, data);
  }

  /** R12/R13: 401 -> NEEDS_ATTENTION + once-per-transition email; 429 -> cooldown; other -> lastError. */
  private async handlePollError(connection: any, e: Error): Promise<void> {
    const name = (e as { name?: string })?.name;
    if (name === "CrmAuthError") {
      const alreadyNotified = !!connection.attentionNotifiedAt;
      if (!alreadyNotified) {
        await this.notifyAttention(connection);
      }
      await this.updateConnection(connection, {
        status: "NEEDS_ATTENTION",
        lastError: e.message,
        attentionNotifiedAt: alreadyNotified ? connection.attentionNotifiedAt : new Date(),
      });
      return;
    }
    if (name === "CrmRateLimitError") {
      // M7: record a cooldown so the next tick skips this tenant entirely instead of
      // immediately re-hitting a rate-limited location.
      const retryAfterSec =
        (e as { retryAfterSec?: number | null }).retryAfterSec ?? DEFAULT_RATE_LIMIT_COOLDOWN_SEC;
      await this.updateConnection(connection, {
        lastError: `rate limit; retry after ${retryAfterSec}s`,
        nextPollAt: new Date(Date.now() + retryAfterSec * 1000),
      });
      return;
    }
    await this.updateConnection(connection, { lastError: e.message });
  }

  private async notifyAttention(connection: any): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId: connection.tenantId,
        role: { in: ["OPERATOR", "TENANT_ADMIN"] },
        status: "ACTIVE",
      },
      select: { email: true },
    });
    const recipients = (users ?? [])
      .map((u: { email?: string }) => u.email)
      .filter((e: unknown): e is string => typeof e === "string" && e.length > 0);
    if (recipients.length === 0) return;
    await this.emailService.send({
      to: recipients,
      subject: "RouteFlow lost access to GoHighLevel",
      html:
        "RouteFlow lost access to GoHighLevel — re-enter the token in Settings → GoHighLevel " +
        "to resume syncing leads.",
    });
  }

  private searchParams(connection: any, page: number): Record<string, unknown> {
    const triggerMode = connection.triggerMode ?? "STAGE";
    return {
      page,
      pipelineId: triggerMode === "STAGE" ? (connection.pipelineId ?? undefined) : undefined,
      stageId: triggerMode === "STAGE" ? (connection.stageId ?? undefined) : undefined,
      status: triggerMode === "WON" ? "won" : undefined,
    };
  }

  private triggerAt(connection: any, opp: Record<string, unknown>): Date {
    const triggerMode = connection.triggerMode ?? "STAGE";
    const raw =
      (triggerMode === "STAGE" ? opp.lastStageChangeAt : opp.lastStatusChangeAt) ??
      opp.updatedAt ??
      0;
    return new Date(raw as string | number);
  }

  /** M1: fold one `handle()` result into the tenant's running counters. */
  private bumpStatusCount(counts: CrmSyncCounts, status: unknown): void {
    const key = typeof status === "string" ? STATUS_COUNTER[status] : undefined;
    if (!key || key === "skipped") return;
    (counts[key] as number) += 1;
  }

  /**
   * R10/R11: cutoff + idempotency + P2002-as-already-handled, then delegates to `handle()`.
   * Returns `handle()`'s `{status}` (M1) so the caller can count it, or `null` when the
   * opportunity was skipped before any handoff was attempted.
   */
  private async processOpportunity(
    connection: any,
    opp: Record<string, unknown>,
    ignoreCutoff: boolean,
    counts: CrmSyncCounts,
    tagCache: Map<string, string>,
  ): Promise<{ status?: string } | null> {
    const startFrom = connection.startFrom ? new Date(connection.startFrom) : new Date(0);
    if (!ignoreCutoff && this.triggerAt(connection, opp) < startFrom) {
      return null;
    }

    const opportunityId = opp.id as string;
    const existing = await this.prisma.crmHandoff.findFirst({
      where: { tenantId: connection.tenantId, provider: "gohighlevel", opportunityId },
    });

    if (existing) {
      if (TERMINAL_HANDOFF_STATUSES.has(existing.status)) return null;
      const dueNow = !existing.nextAttemptAt || new Date(existing.nextAttemptAt) <= new Date();
      if (!RETRYABLE_HANDOFF_STATUSES.has(existing.status) || !dueNow) return null;
      counts.new++;
      return (await this.handoffService.handle(connection, opp, {
        handoffId: existing.id,
        tagCache,
      })) as { status?: string } | null;
    }

    try {
      await this.prisma.crmHandoff.create({
        data: {
          tenantId: connection.tenantId,
          provider: "gohighlevel",
          opportunityId,
          contactId: opp.contactId,
          opportunityName: opp.name,
          status: "PENDING",
        },
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") return null; // already handled elsewhere
      throw e;
    }

    counts.new++;
    return (await this.handoffService.handle(connection, opp, { tagCache })) as {
      status?: string;
    } | null;
  }

  /** R9: pages `searchOpportunities` (capped 50 pages / a wall-clock budget) per tenant. */
  async pollTenant(tenantId: string, opts: GoHighLevelPollOptions = {}): Promise<CrmSyncCounts> {
    const { ignoreCutoff = false, ignoreEnabledGate = false, budgetMs = DEFAULT_BUDGET_MS } = opts;
    const startedAt = Date.now();
    const counts = emptyCounts();

    const connection = await this.prisma.crmConnection.findFirst({ where: { tenantId } });
    // F12/F13: a usable token is always required; `enabled` only gates the ongoing sync, not
    // the operator-initiated "Import existing" pass that necessarily runs before enabling.
    if (!connection || !connection.secretCipher) return counts;
    if (!ignoreEnabledGate && !connection.enabled) return counts;
    // M7: honour an active 429 cooldown, manual sync included.
    if (connection.nextPollAt && new Date(connection.nextPollAt) > new Date()) {
      return { ...counts, skipped: "cooldown" };
    }

    const client = await this.clientFactory(connection);
    // M17: one tag map per tick — `ensureTags` fills it from a single `listTags()` call and
    // every subsequent opportunity in this tick reads it instead of refetching.
    const tagCache = new Map<string, string>();

    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      if (Date.now() - startedAt > budgetMs) {
        await this.updateConnection(connection, {
          // m1: operator-visible copy, not the internal "budget" token.
          lastError: `Stopped after ${Math.round(budgetMs / 1000)} s; will continue on the next check`,
          lastPollAt: new Date(),
        });
        return counts;
      }

      let result: { opportunities?: unknown[]; meta?: { nextPage?: number } };
      try {
        result = await client.searchOpportunities(this.searchParams(connection, page));
      } catch (e) {
        await this.handlePollError(connection, e as Error);
        return counts;
      }

      const opportunities = (result?.opportunities ?? []) as Array<Record<string, unknown>>;
      for (const opp of opportunities) {
        counts.fetched++;
        // M11: one bad opportunity must not abort the rest of the tenant's tick.
        try {
          const outcome = await this.processOpportunity(
            connection,
            opp,
            ignoreCutoff,
            counts,
            tagCache,
          );
          this.bumpStatusCount(counts, outcome?.status);
        } catch (e) {
          counts.failed++;
          this.logger.warn(
            `crm handoff failed tenant=${tenantId} opportunity=${String(opp?.id)}: ${(e as Error).message}`,
          );
        }
      }

      const nextPage = result?.meta?.nextPage;
      if (!nextPage) break;
      page = nextPage;
    }

    await this.updateConnection(connection, {
      lastPollAt: new Date(),
      lastSuccessAt: new Date(),
      lastError: null,
      nextPollAt: null,
    });
    return counts;
  }

  /** R22: reopens a DRY_RUN/NEEDS_REVIEW/FAILED/WRITEBACK_PENDING row and re-runs `handle()`. */
  async retryHandoff(tenantId: string, handoffId: string): Promise<{ status: string }> {
    // F8: scoped read — another tenant's handoff id is simply not found.
    const handoff = await this.prisma.crmHandoff.findFirst({
      where: { id: handoffId, tenantId },
    });
    if (!handoff) throw new NotFoundException("Handoff not found.");
    if (!REOPENABLE_ON_RETRY.has(handoff.status)) {
      throw new ConflictException(`Cannot retry a handoff in status ${handoff.status}.`);
    }

    // F5: `CrmHandoff` has no `connectionId` column — the connection is the tenant's one row.
    // Resolve it BEFORE mutating the handoff, so a missing connection cannot leave the row
    // reopened with nothing to process it.
    const connection = await this.prisma.crmConnection.findFirst({ where: { tenantId } });
    if (!connection) throw new NotFoundException("GoHighLevel connection not found.");

    const nextStatus = handoff.customerId ? "WRITEBACK_PENDING" : "PENDING";
    await this.prisma.crmHandoff.update({
      where: { id: handoffId },
      data: { status: nextStatus, attempts: 0, nextAttemptAt: new Date() },
    });

    // M8: the dry-run writer persists the full opportunity under `payload.opportunity`, so a
    // retried DRY_RUN row keeps its deal name/value/source. Older rows fall back to the
    // minimum the handoff row itself carries.
    const stored = (handoff.payload as { opportunity?: Record<string, unknown> } | null)
      ?.opportunity;
    const opportunity = stored ?? {
      id: handoff.opportunityId,
      contactId: handoff.contactId,
      name: handoff.opportunityName ?? undefined,
    };

    const result = (await this.handoffService.handle(connection, opportunity, {
      handoffId,
    })) as { status?: string } | null;
    return { status: result?.status ?? nextStatus };
  }

  /** R22: dismisses a non-terminal row (NEEDS_REVIEW/FAILED/DRY_RUN only). */
  async dismissHandoff(tenantId: string, handoffId: string): Promise<{ status: string }> {
    const handoff = await this.prisma.crmHandoff.findFirst({
      where: { id: handoffId, tenantId },
    });
    if (!handoff) throw new NotFoundException("Handoff not found.");
    if (!DISMISSABLE_STATUSES.has(handoff.status)) {
      throw new ConflictException(`Cannot dismiss a handoff in status ${handoff.status}.`);
    }
    await this.prisma.crmHandoff.update({
      where: { id: handoffId },
      data: { status: "SKIPPED", reason: "dismissed" },
    });
    return { status: "SKIPPED" };
  }

  /** R23: read-only, ignores the cutoff, writes nothing — a preview of "Import existing". */
  async previewImportExisting(
    tenantId: string,
    opts: { budgetMs?: number } = {},
  ): Promise<ImportPreviewResult> {
    const { budgetMs = DEFAULT_BUDGET_MS } = opts;
    const startedAt = Date.now();
    const connection = await this.prisma.crmConnection.findFirst({ where: { tenantId } });
    // F13: the same `secretCipher` guard `pollTenant` applies — an empty token would build a
    // client that throws `CrmAuthError` on the first call.
    if (!connection || !connection.secretCipher) return { count: 0, sample: [] };

    const client = await this.clientFactory(connection);
    let count = 0;
    const sample: ImportPreviewSample[] = [];
    let page = 1;

    for (let i = 0; i < MAX_PAGES; i++) {
      // m2: the same wall-clock budget `pollTenant` honours.
      if (Date.now() - startedAt > budgetMs) break;

      const result = await client.searchOpportunities(this.searchParams(connection, page));
      const opportunities = (result?.opportunities ?? []) as Array<Record<string, unknown>>;

      // m2: one batched lookup per page instead of one query per opportunity.
      const ids = opportunities
        .map((opp) => opp.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const existingRows = ids.length
        ? ((await this.prisma.crmHandoff.findMany({
            where: { tenantId, provider: "gohighlevel", opportunityId: { in: ids } },
            select: { opportunityId: true },
          })) ?? [])
        : [];
      const alreadyHandled = new Set(
        (existingRows as Array<{ opportunityId: string }>).map((r) => r.opportunityId),
      );

      for (const opp of opportunities) {
        if (alreadyHandled.has(opp.id as string)) continue;
        count++;
        if (sample.length < IMPORT_PREVIEW_SAMPLE_CAP) {
          sample.push({
            opportunityName: (opp.name as string) ?? "",
            contactName: opp.contactName as string | undefined,
            email: opp.email as string | undefined,
            phone: opp.phone as string | undefined,
          });
        }
      }

      const nextPage = result?.meta?.nextPage;
      if (!nextPage) break;
      page = nextPage;
    }

    return { count, sample };
  }

  /** R23: runs a real poll with the cutoff ignored (dry-run still honoured downstream). */
  async importExisting(tenantId: string): Promise<CrmSyncCounts> {
    // F12: "Import existing" is the action taken BEFORE ongoing sync is switched on.
    return this.pollTenant(tenantId, { ignoreCutoff: true, ignoreEnabledGate: true });
  }
}
