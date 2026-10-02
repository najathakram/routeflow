import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  OnboardingAutoResult,
  OnboardingCaseDetail,
  OnboardingCaseSummary,
  OnboardingDealTerms,
  OnboardingEventView,
  OnboardingStage,
  OnboardingStageCounts,
  OnboardingStepView,
  DemoBookingListItem,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { LeaderCron } from "../common/cron-lock";
import {
  ADMIN_AUDIT_ENTITY,
  AdminAuditAction,
  type AdminAuditActionCode,
} from "../platform-admin/audit-actions.constant";
import {
  CATALOG_VERSION,
  STAGE_ORDER,
  STEPS,
  catalogStep,
  gateBlockers,
  nextStage,
  stageIndex,
} from "./onboarding-catalog";
import { runAutoCheck } from "./onboarding-auto-checks";
import type {
  CreateOnboardingCaseDto,
  ListDemoBookingsQueryDto,
  ListOnboardingCasesQueryDto,
  UpdateOnboardingCaseDto,
} from "./dto/onboarding.dto";
import { API_ERROR_CODES } from "../common/api-error-codes";

type Tx = Prisma.TransactionClient;
type CaseRow = Prisma.OnboardingCaseGetPayload<{ include: { steps: true } }>;
type StepRow = CaseRow["steps"][number];

const NOT_FOUND = "Onboarding case not found";

/** Revokes every still-active intake link of a case (S2 token lifecycle: LOST or LIVE). */
async function revokeIntakeLinks(tx: Tx, caseId: string): Promise<void> {
  await tx.intakeAccessToken.updateMany({
    where: { caseId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
const EVENTS_SHOWN = 200;

/**
 * Wholesaler onboarding cases (#2159 S1) — the back-office tracker that makes the
 * playbook's stage gates enforceable.
 *
 * PLATFORM-LEVEL: every read and write uses the BASE Prisma client. The tenant extension
 * (`forTenant()`) injects a `tenantId` into every model it wraps, and these rows belong to
 * no tenant (a case exists before its workspace does). Only the auto-checks read tenant
 * data, and they filter by the case's own `tenantId` explicitly.
 *
 * CONCURRENCY: every mutation takes a row lock on the case (`SELECT … FOR UPDATE`) inside
 * one transaction, so an advance can never slip past a step being reopened at the same moment.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ─── Reads ────────────────────────────────────────────────────────────────────

  async list(q: ListOnboardingCasesQueryDto): Promise<OnboardingCaseSummary[]> {
    const term = q.q?.trim();
    const rows = await this.prisma.onboardingCase.findMany({
      where: {
        ...(q.stage ? { stage: q.stage } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.ownerAdminId ? { ownerAdminId: q.ownerAdminId } : {}),
        ...(term
          ? {
              OR: [
                { companyName: { contains: term, mode: "insensitive" } },
                { contactName: { contains: term, mode: "insensitive" } },
                { contactEmail: { contains: term, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { steps: true },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
    return rows.map((r) => this.toSummary(r));
  }

  async counts(): Promise<OnboardingStageCounts> {
    const [open, closed] = await Promise.all([
      this.prisma.onboardingCase.groupBy({
        by: ["stage"],
        where: { status: { in: ["OPEN", "ON_HOLD"] } },
        _count: { _all: true },
      }),
      this.prisma.onboardingCase.groupBy({
        by: ["status"],
        where: { status: { in: ["LIVE", "LOST"] } },
        _count: { _all: true },
      }),
    ]);
    const out = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0])) as Record<
      OnboardingStage,
      number
    >;
    for (const g of open) out[g.stage] = g._count._all;
    const closedBy = (s: string) => closed.find((g) => g.status === s)?._count._all ?? 0;
    return { ...out, LIVE_TOTAL: closedBy("LIVE"), LOST_TOTAL: closedBy("LOST") };
  }

  async get(id: string): Promise<OnboardingCaseDetail> {
    const row = await this.prisma.onboardingCase.findUnique({
      where: { id },
      include: { steps: true },
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    const events = await this.prisma.onboardingEvent.findMany({
      where: { caseId: id },
      orderBy: { createdAt: "desc" },
      take: EVENTS_SHOWN,
    });
    return this.toDetail(row, events);
  }

  async listDemoBookings(q: ListDemoBookingsQueryDto): Promise<DemoBookingListItem[]> {
    const rows = await this.prisma.demoBooking.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.from || q.to
          ? {
              startsAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lt: new Date(q.to) } : {}),
              },
            }
          : {}),
      },
      include: { onboardingCase: { select: { id: true } } },
      orderBy: { startsAt: "desc" },
      take: 500,
    });
    return rows.map((b) => ({
      id: b.id,
      name: b.name,
      email: b.email,
      company: b.company,
      phone: b.phone,
      notes: b.notes,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      timeZone: b.timeZone,
      status: b.status,
      meetUrl: b.meetUrl,
      createdAt: b.createdAt.toISOString(),
      onboardingCaseId: b.onboardingCase?.id ?? null,
    }));
  }

  // ─── Case lifecycle ───────────────────────────────────────────────────────────

  async create(dto: CreateOnboardingCaseDto, adminId: string): Promise<OnboardingCaseDetail> {
    let fromBooking: { company: string; name: string; email: string; phone: string | null } | null =
      null;
    if (dto.demoBookingId) {
      fromBooking = await this.prisma.demoBooking.findUnique({
        where: { id: dto.demoBookingId },
        select: { company: true, name: true, email: true, phone: true },
      });
      if (!fromBooking) throw new BadRequestException("Demo booking not found");
    }
    const companyName = (dto.companyName ?? fromBooking?.company ?? "").trim();
    const contactName = (dto.contactName ?? fromBooking?.name ?? "").trim();
    const contactEmail = (dto.contactEmail ?? fromBooking?.email ?? "").trim();
    if (!companyName || !contactName || !contactEmail) {
      throw new BadRequestException("companyName, contactName and contactEmail are required");
    }

    let created: { id: string; tenantId: string | null };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const c = await tx.onboardingCase.create({
          data: {
            companyName,
            contactName,
            contactEmail,
            contactPhone: dto.contactPhone ?? fromBooking?.phone ?? null,
            demoBookingId: dto.demoBookingId ?? null,
            ownerAdminId: dto.ownerAdminId ?? adminId,
            targetGoLiveOn: dto.targetGoLiveOn ? new Date(`${dto.targetGoLiveOn}T00:00:00Z`) : null,
            fitNotes: (dto.fitNotes as Prisma.InputJsonValue) ?? undefined,
            dealTerms: { ...(dto.dealTerms ?? {}) },
            catalogVersion: CATALOG_VERSION,
            createdById: adminId,
          },
          select: { id: true, tenantId: true },
        });
        // Materialise the catalog at CATALOG_VERSION — the case keeps these rules for life.
        await tx.onboardingStep.createMany({
          data: STEPS.map((s) => ({
            caseId: c.id,
            key: s.key,
            stage: s.stage,
            title: s.title,
            required: s.required,
            autoCheck: s.autoCheck ?? null,
          })),
        });
        await this.event(tx, c.id, "case.created", adminId, {
          catalogVersion: CATALOG_VERSION,
          demoBookingId: dto.demoBookingId ?? null,
        });
        return c;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.ONBOARDING_BOOKING_HAS_CASE,
          message: "An onboarding case already exists for that demo booking",
        });
      }
      throw err;
    }
    await this.adminAudit(created.tenantId, adminId, AdminAuditAction.ONBOARDING_CASE_CREATED, {
      caseId: created.id,
      companyName,
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    dto: UpdateOnboardingCaseDto,
    adminId: string,
  ): Promise<OnboardingCaseDetail> {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lockCase(tx, id);
      if (c.status === "LIVE" || c.status === "LOST") {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.ONBOARDING_CASE_CLOSED,
          message: `This case is ${c.status} and can no longer be changed`,
        });
      }
      const data: Prisma.OnboardingCaseUpdateInput = {};
      if (dto.companyName !== undefined) data.companyName = dto.companyName.trim();
      if (dto.contactName !== undefined) data.contactName = dto.contactName.trim();
      if (dto.contactEmail !== undefined) data.contactEmail = dto.contactEmail.trim();
      if (dto.contactPhone !== undefined) data.contactPhone = dto.contactPhone;
      if (dto.ownerAdminId !== undefined) data.ownerAdminId = dto.ownerAdminId;
      if (dto.targetGoLiveOn !== undefined) {
        data.targetGoLiveOn = dto.targetGoLiveOn
          ? new Date(`${dto.targetGoLiveOn}T00:00:00Z`)
          : null;
      }
      if (dto.cutoverAt !== undefined)
        data.cutoverAt = dto.cutoverAt ? new Date(dto.cutoverAt) : null;
      if (dto.fitNotes !== undefined) {
        data.fitNotes =
          dto.fitNotes === null ? Prisma.DbNull : (dto.fitNotes as Prisma.InputJsonValue);
      }
      if (dto.dealTerms !== undefined) data.dealTerms = { ...dto.dealTerms };
      if (dto.status !== undefined && dto.status !== c.status) {
        if (dto.status === "LOST") {
          const reason = dto.lostReason?.trim();
          if (!reason) throw new BadRequestException("lostReason is required to mark a case LOST");
          data.lostReason = reason;
          data.closedAt = new Date();
        }
        data.status = dto.status;
      }
      await tx.onboardingCase.update({ where: { id }, data });
      // S2: a LOST case's intake link dies with it (plan §4 token lifecycle).
      if (data.status === "LOST") await revokeIntakeLinks(tx, id);
      const changed = Object.keys(dto).filter(
        (k) => (dto as Record<string, unknown>)[k] !== undefined,
      );
      await this.event(
        tx,
        id,
        dto.status && dto.status !== c.status ? "case.status" : "case.updated",
        adminId,
        {
          fields: changed,
          ...(dto.status && dto.status !== c.status ? { from: c.status, to: dto.status } : {}),
        },
      );
    });
    return this.get(id);
  }

  /**
   * The gate. Refuses (409, with the blocker list) unless every REQUIRED step of the
   * current stage is DONE or WAIVED; then moves exactly one stage on. Advancing out of
   * HYPERCARE marks the case LIVE.
   */
  async advance(id: string, adminId: string): Promise<OnboardingCaseDetail> {
    let tenantId: string | null = null;
    let from: OnboardingStage = "FOLLOW_UP";
    let to: OnboardingStage | "LIVE" = "LIVE";
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lockCase(tx, id);
      this.assertOpen(c);
      tenantId = c.tenantId;
      from = c.stage;
      const blockers = gateBlockers(c.steps, c.stage);
      if (blockers.length > 0) {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.ONBOARDING_GATE_BLOCKED,
          message: `${blockers.length} required step${blockers.length === 1 ? "" : "s"} still open in ${c.stage}`,
          stage: c.stage,
          blockers,
        });
      }
      const next = nextStage(c.stage);
      if (next) {
        to = next;
        await tx.onboardingCase.update({ where: { id }, data: { stage: next } });
        await this.event(tx, id, "stage.advanced", adminId, { from: c.stage, to: next });
      } else {
        to = "LIVE";
        await tx.onboardingCase.update({
          where: { id },
          data: { status: "LIVE", closedAt: new Date() },
        });
        await revokeIntakeLinks(tx, id); // S2: a LIVE case's intake link is revoked

        await this.event(tx, id, "case.live", adminId, { from: c.stage });
      }
    });
    await this.adminAudit(tenantId, adminId, AdminAuditAction.ONBOARDING_STAGE_ADVANCED, {
      caseId: id,
      from,
      to,
    });
    return this.get(id);
  }

  // ─── Steps ────────────────────────────────────────────────────────────────────

  async completeStep(
    id: string,
    key: string,
    evidence: Record<string, unknown> | undefined,
    adminId: string,
  ): Promise<OnboardingCaseDetail> {
    await this.prisma.$transaction(async (tx) => {
      const { step } = await this.lockStep(tx, id, key);
      if (step.status === "DONE") return; // idempotent
      if (step.status === "WAIVED") {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.ONBOARDING_STEP_WAIVED,
          message: "This step was waived — reopen it before completing it",
        });
      }
      await tx.onboardingStep.update({
        where: { id: step.id },
        data: {
          status: "DONE",
          doneById: adminId,
          doneAt: new Date(),
          ...(evidence ? { evidence: evidence as Prisma.InputJsonValue } : {}),
        },
      });
      await this.event(tx, id, "step.completed", adminId, { key });
    });
    return this.get(id);
  }

  async waiveStep(
    id: string,
    key: string,
    reasonRaw: string,
    adminId: string,
  ): Promise<OnboardingCaseDetail> {
    const reason = (reasonRaw ?? "").trim();
    if (!reason) throw new BadRequestException("A reason is required to waive a step");
    let tenantId: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      const { c, step } = await this.lockStep(tx, id, key);
      tenantId = c.tenantId;
      if (step.status !== "PENDING") {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.ONBOARDING_STEP_NOT_PENDING,
          message: `This step is already ${step.status} — reopen it first`,
        });
      }
      await tx.onboardingStep.update({
        where: { id: step.id },
        data: { status: "WAIVED", waivedReason: reason, waivedById: adminId, waivedAt: new Date() },
      });
      await this.event(tx, id, "step.waived", adminId, { key, reason });
    });
    await this.adminAudit(tenantId, adminId, AdminAuditAction.ONBOARDING_STEP_WAIVED, {
      caseId: id,
      key,
      reason,
    });
    return this.get(id);
  }

  /** Back to PENDING — only inside the current stage (a passed gate is never re-opened). */
  async reopenStep(id: string, key: string, adminId: string): Promise<OnboardingCaseDetail> {
    await this.prisma.$transaction(async (tx) => {
      const { c, step } = await this.lockStep(tx, id, key);
      if (step.stage !== c.stage) {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.ONBOARDING_STEP_BEHIND_GATE,
          message: "Only steps in the current stage can be reopened",
        });
      }
      if (step.status === "PENDING") return;
      await tx.onboardingStep.update({
        where: { id: step.id },
        data: {
          status: "PENDING",
          doneById: null,
          doneAt: null,
          waivedReason: null,
          waivedById: null,
          waivedAt: null,
        },
      });
      await this.event(tx, id, "step.reopened", adminId, { key, was: step.status });
    });
    return this.get(id);
  }

  /** Adds catalog keys this case lacks as PENDING and stamps the current version. Never deletes. */
  async adoptCatalog(id: string, adminId: string): Promise<OnboardingCaseDetail> {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lockCase(tx, id);
      this.assertOpen(c);
      const have = new Set(c.steps.map((s) => s.key));
      const missing = STEPS.filter((s) => !have.has(s.key));
      if (missing.length > 0) {
        await tx.onboardingStep.createMany({
          data: missing.map((s) => ({
            caseId: id,
            key: s.key,
            stage: s.stage,
            title: s.title,
            required: s.required,
            autoCheck: s.autoCheck ?? null,
          })),
          skipDuplicates: true,
        });
      }
      if (missing.length > 0 || c.catalogVersion !== CATALOG_VERSION) {
        await tx.onboardingCase.update({
          where: { id },
          data: { catalogVersion: CATALOG_VERSION },
        });
        await this.event(tx, id, "catalog.adopted", adminId, {
          from: c.catalogVersion,
          to: CATALOG_VERSION,
          added: missing.map((s) => s.key),
        });
      }
    });
    return this.get(id);
  }

  // ─── Auto-checks ──────────────────────────────────────────────────────────────

  async runAutoChecks(id: string, adminId: string | null): Promise<OnboardingCaseDetail> {
    const c = await this.prisma.onboardingCase.findUnique({
      where: { id },
      include: { steps: true },
    });
    if (!c) throw new NotFoundException(NOT_FOUND);
    await this.refreshCase(c, adminId);
    return this.get(id);
  }

  /** Hourly: refresh every OPEN case that has a workspace. One failing case never stops the rest. */
  @LeaderCron("0 * * * *", "onboarding.refreshAutoChecks")
  async refreshAllAutoChecks(): Promise<void> {
    const cases = await this.prisma.onboardingCase.findMany({
      where: { status: "OPEN", tenantId: { not: null } },
      include: { steps: true },
    });
    for (const c of cases) {
      try {
        await this.refreshCase(c, null);
      } catch (err) {
        this.logger.warn(
          `onboarding auto-checks failed for case ${c.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async refreshCase(c: CaseRow, adminId: string | null): Promise<void> {
    const tenantId = c.tenantId;
    if (!tenantId) return; // nothing to check until the workspace exists (S3a links it)
    const checkSteps = c.steps.filter((s) => s.autoCheck);
    const now = new Date();
    const results = await this.tenantCtx.run(tenantId, async () => {
      const out: { stepId: string; key: string; result: OnboardingAutoResult }[] = [];
      for (const s of checkSteps) {
        const r = await runAutoCheck(s.autoCheck!, { db: this.prisma, tenantId, now });
        out.push({ stepId: s.id, key: s.key, result: { ...r, checkedAt: now.toISOString() } });
      }
      return out;
    });
    await this.prisma.$transaction(async (tx) => {
      for (const r of results) {
        await tx.onboardingStep.update({
          where: { id: r.stepId },
          data: { autoResult: r.result as unknown as Prisma.InputJsonValue },
        });
      }
      if (adminId) {
        await this.event(tx, c.id, "autochecks.run", adminId, {
          ok: results.filter((r) => r.result.ok).map((r) => r.key),
          failing: results.filter((r) => !r.result.ok).map((r) => r.key),
        });
      }
    });
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  private async lockCase(tx: Tx, id: string): Promise<CaseRow> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "OnboardingCase" WHERE id = ${id} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundException(NOT_FOUND);
    const c = await tx.onboardingCase.findUnique({ where: { id }, include: { steps: true } });
    if (!c) throw new NotFoundException(NOT_FOUND);
    return c;
  }

  /** Locks the case, checks it is OPEN, and refuses a step in a stage not yet reached. */
  private async lockStep(tx: Tx, id: string, key: string): Promise<{ c: CaseRow; step: StepRow }> {
    const c = await this.lockCase(tx, id);
    this.assertOpen(c);
    const step = c.steps.find((s) => s.key === key);
    if (!step) throw new NotFoundException("Onboarding step not found");
    if (stageIndex(step.stage) > stageIndex(c.stage)) {
      throw new ConflictException({
        statusCode: 409,
        code: API_ERROR_CODES.ONBOARDING_STEP_NOT_REACHED,
        message: `This step belongs to ${step.stage}; the case is at ${c.stage}`,
      });
    }
    return { c, step };
  }

  private assertOpen(c: { status: string }): void {
    if (c.status !== "OPEN") {
      throw new ConflictException({
        statusCode: 409,
        code: API_ERROR_CODES.ONBOARDING_CASE_NOT_OPEN,
        message: `This case is ${c.status}; reopen it before changing steps or stages`,
      });
    }
  }

  private async event(
    tx: Tx,
    caseId: string,
    type: string,
    adminId: string | null,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await tx.onboardingEvent.create({
      data: {
        caseId,
        type,
        actorType: adminId ? "ADMIN" : "SYSTEM",
        actorId: adminId,
        payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /** Same row shape as PlatformAdminService.recordAdminAction; tenantId is null before Activate. */
  private async adminAudit(
    tenantId: string | null,
    adminId: string,
    action: AdminAuditActionCode,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.log({
      tenantId,
      userId: adminId,
      action,
      entityType: ADMIN_AUDIT_ENTITY,
      entityId: tenantId,
      meta: { platformAdmin: true, ...meta },
    });
  }

  private toSummary(r: CaseRow): OnboardingCaseSummary {
    const done = r.steps.filter((s) => s.status === "DONE").length;
    const waived = r.steps.filter((s) => s.status === "WAIVED").length;
    return {
      id: r.id,
      companyName: r.companyName,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      stage: r.stage,
      status: r.status,
      tenantId: r.tenantId,
      demoBookingId: r.demoBookingId,
      ownerAdminId: r.ownerAdminId,
      targetGoLiveOn: r.targetGoLiveOn ? r.targetGoLiveOn.toISOString().slice(0, 10) : null,
      stepCounts: { total: r.steps.length, done, waived, pending: r.steps.length - done - waived },
      blockerCount:
        r.status === "OPEN" || r.status === "ON_HOLD" ? gateBlockers(r.steps, r.stage).length : 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private toDetail(
    r: CaseRow,
    events: Prisma.OnboardingEventGetPayload<Record<string, never>>[],
  ): OnboardingCaseDetail {
    const steps: OnboardingStepView[] = [...r.steps]
      .sort((a, b) => {
        const d = stageIndex(a.stage) - stageIndex(b.stage);
        if (d !== 0) return d;
        const ia = STEPS.findIndex((s) => s.key === a.key);
        const ib = STEPS.findIndex((s) => s.key === b.key);
        return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
      })
      .map((s) => {
        const cat = catalogStep(s.key);
        return {
          id: s.id,
          key: s.key,
          stage: s.stage,
          title: s.title,
          required: s.required,
          autoCheck: s.autoCheck,
          owner: cat?.owner ?? null,
          evidenceHint: cat?.evidenceHint ?? null,
          status: s.status,
          autoResult: (s.autoResult as unknown as OnboardingAutoResult | null) ?? null,
          evidence: (s.evidence as Record<string, unknown> | null) ?? null,
          doneById: s.doneById,
          doneAt: s.doneAt?.toISOString() ?? null,
          waivedReason: s.waivedReason,
          waivedById: s.waivedById,
          waivedAt: s.waivedAt?.toISOString() ?? null,
        };
      });
    const eventViews: OnboardingEventView[] = events.map((e) => ({
      id: e.id,
      type: e.type,
      actorType: e.actorType,
      actorId: e.actorId,
      payload: (e.payload as Record<string, unknown> | null) ?? null,
      createdAt: e.createdAt.toISOString(),
    }));
    return {
      ...this.toSummary(r),
      catalogVersion: r.catalogVersion,
      currentCatalogVersion: CATALOG_VERSION,
      fitNotes: (r.fitNotes as Record<string, unknown> | null) ?? null,
      dealTerms: (r.dealTerms as OnboardingDealTerms | null) ?? {},
      cutoverAt: r.cutoverAt?.toISOString() ?? null,
      lostReason: r.lostReason,
      closedAt: r.closedAt?.toISOString() ?? null,
      createdById: r.createdById,
      steps,
      blockers: r.status === "OPEN" || r.status === "ON_HOLD" ? gateBlockers(r.steps, r.stage) : [],
      events: eventViews,
    };
  }
}
