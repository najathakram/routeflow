import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { PrismaService } from "../prisma/prisma.service";
import { lockTenantForLedger } from "./addon-ledger";
import { CatchupCheckoutService, type CatchupReport } from "./catchup-checkout.service";
import {
  CATCHUP_MARKER_ACTIONS,
  CATCHUP_MARKERS_VERSION,
  type MarkerAuditRow,
} from "./catchup-markers";
import { CATCHUP_GO_LIVE } from "./catchup-plan";

/**
 * SA-1122 (i) / D14: the ONE writer of the three catch-up correction markers
 *
 *   TENANT_MANUAL_ACTIVATION_COVERAGE_VOID     { voidsMarkerId, reason, actor, ownerApprovedAt }
 *   TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE  { restoresMarkerId, reason, actor, ownerApprovedAt }
 *   TENANT_BILLING_START_OVERRIDE              { billingStart, reason, actor, ownerApprovedAt }
 *
 * Ported from the operator CLI's core (`billing-correct-activation-core.cjs`), unchanged in meaning; the CLI is now
 * an HTTP client of the routes in `CatchupAdminController`. A structural spec pins that this is the only source file
 * that WRITES these action names. History is append-only: a correction is a new row, never an edit; RESTORE undoes a
 * VOID and a later override replaces an earlier one. Nothing is charged, Stripe is not called, no invoice is touched.
 *
 * The AFTER of a preview is computed by `CatchupCheckoutService.plan` itself (hypothetical rows appended in memory),
 * so a correction can never be previewed against a different planner than the one the catch-up runs.
 */

export const CATCHUP_REASON_MIN = 10;
export const CATCHUP_REASON_MAX = 500;

export interface CorrectionRequest {
  voidCoverage?: string[];
  restoreCoverage?: string[];
  billingStart?: string;
}

export interface CorrectionApplyRequest extends CorrectionRequest {
  reason: string;
  expectedBefore: number | null;
  confirmTenantName: string;
}

interface Planned {
  voidCoverage: string[];
  restoreCoverage: string[];
  billingStart: Date | null;
}

/** floor / paid-through / the catch-up line, in the JSON shape of `CatchupPlanSummary` (packages/types). */
function summarise(r: CatchupReport) {
  const p = r.plan;
  if (!p.ok) return { summary: null, note: `cannot plan: ${p.reason}` };
  return {
    summary: {
      floor: p.floor.toISOString(),
      paidThrough: p.paidThrough.toISOString(),
      from: p.stub.from.toISOString(),
      to: p.stub.to.toISOString(),
      stubCents: p.stub.totalCents,
      voidInvoiceIds: p.voidInvoiceIds,
    },
    note: null,
  };
}

/**
 * A billing start is an ANCHOR 1st at exactly 12:00Z and not before go-live. "YYYY-MM-DD" means that day at 12:00Z;
 * a full timestamp must already be exactly 12:00:00.000Z (the legacy 00:00Z spelling is refused, never snapped).
 */
export function parseBillingStart(input: string): Date {
  const invalid = (message: string) =>
    new BadRequestException({ code: API_ERROR_CODES.CATCHUP_BILLING_START_INVALID, message });
  const raw = String(input ?? "").trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00.000Z`) : new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) throw invalid("The billing start is not a date.");
  if (
    d.getUTCDate() !== 1 ||
    d.getUTCHours() !== 12 ||
    d.getUTCMinutes() !== 0 ||
    d.getUTCSeconds() !== 0 ||
    d.getUTCMilliseconds() !== 0
  ) {
    throw invalid("The billing start must be the 1st of a month at 12:00Z.");
  }
  if (d.getTime() < CATCHUP_GO_LIVE.getTime()) {
    throw invalid("The billing start is before go-live (2026-10-01).");
  }
  return d;
}

/** The AuditLog rows an apply appends, in the order written (voids, restores, billing start). */
export function buildCorrectionRows(
  p: Planned,
  stamp: { reason: string; actor: string; ownerApprovedAt: string },
): { action: string; meta: Record<string, unknown> }[] {
  return [
    ...p.voidCoverage.map((id) => ({
      action: AdminAuditAction.TENANT_MANUAL_ACTIVATION_COVERAGE_VOID as string,
      meta: { voidsMarkerId: id, ...stamp },
    })),
    ...p.restoreCoverage.map((id) => ({
      action: AdminAuditAction.TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE as string,
      meta: { restoresMarkerId: id, ...stamp },
    })),
    ...(p.billingStart
      ? [
          {
            action: AdminAuditAction.TENANT_BILLING_START_OVERRIDE as string,
            meta: { billingStart: p.billingStart.toISOString(), ...stamp },
          },
        ]
      : []),
  ];
}

@Injectable()
export class CatchupCorrectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catchup: CatchupCheckoutService,
  ) {}

  /** What the screen lists: the activation markers with their state, the override, the claim, the plan summary. */
  async view(tenantId: string, now: Date = new Date()) {
    const r = await this.catchup.plan(tenantId, now);
    const { summary, note } = summarise(r);
    return {
      tenantId,
      markersVersion: CATCHUP_MARKERS_VERSION,
      claimState: r.claimState,
      markers: r.markers,
      billingStartOverride: r.billingStartOverride,
      summary,
      note,
    };
  }

  /** BEFORE and AFTER of a requested change by the real planner. Writes nothing. */
  async preview(tenantId: string, req: CorrectionRequest, now: Date = new Date()) {
    const planned = this.validate(req);
    const before = await this.catchup.plan(tenantId, now);
    this.assertKnownMarkers(before, planned);
    const after = await this.catchup.plan(tenantId, now, {
      extraMarkerRows: await this.hypothetical(tenantId, planned, now),
    });
    const stateAfter = (id: string, current: string) =>
      planned.voidCoverage.includes(id)
        ? "voided"
        : planned.restoreCoverage.includes(id)
          ? "restored"
          : current;
    const b = summarise(before);
    const a = summarise(after);
    return {
      tenantId,
      markersVersion: CATCHUP_MARKERS_VERSION,
      claimState: before.claimState,
      markers: before.markers.map((m) => ({
        ...m,
        stateBefore: m.state,
        state: stateAfter(m.id, m.state),
      })),
      before: b.summary,
      after: a.summary,
      notes: [b.note && `before: ${b.note}`, a.note && `after: ${a.note}`].filter(
        (n): n is string => !!n,
      ),
    };
  }

  /**
   * Append the rows. Order, all in one transaction under the Tenant row lock (the house lock order): the lock, then the
   * claim read (a held claim = 409 CATCHUP_CLAIM_HELD), then BEFORE recomputed and compared with `expectedBefore`
   * (409 CATCHUP_PREVIEW_STALE), then the rows. Any refusal writes nothing.
   */
  async apply(tenantId: string, req: CorrectionApplyRequest, actorId: string, now = new Date()) {
    const planned = this.validate(req);
    const reason = String(req.reason ?? "").trim();
    if (reason.length < CATCHUP_REASON_MIN || reason.length > CATCHUP_REASON_MAX) {
      throw new BadRequestException(
        `A reason of ${CATCHUP_REASON_MIN} to ${CATCHUP_REASON_MAX} characters is required.`,
      );
    }
    const report = await this.catchup.plan(tenantId, now);
    this.assertKnownMarkers(report, planned);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    if (!tenant || String(req.confirmTenantName ?? "").trim() !== tenant.name) {
      throw new BadRequestException("The tenant name did not match. Nothing was written.");
    }
    const rows = buildCorrectionRows(planned, {
      reason,
      actor: actorId,
      ownerApprovedAt: now.toISOString(),
    });

    const appended = await this.prisma.$transaction(
      async (tx) => {
        await lockTenantForLedger(tx, tenantId);
        const claim = await tx.tenantSubscription.findUnique({
          where: { tenantId },
          select: { catchupState: true },
        });
        // any claim state (SESSION_OPEN, AWAITING_FIRST_PAYMENT, RELEASING) holds the plan, as `claimRefusal` does
        const held = claim?.catchupState;
        if (held) {
          throw new ConflictException({
            code: API_ERROR_CODES.CATCHUP_CLAIM_HELD,
            message:
              "A payment link is open; corrections wait until it is paid or released. Nothing was written.",
            claimState: held,
          });
        }
        // The plan reads through the pool (a second connection) while this transaction holds the Tenant lock. That is
        // safe: every writer of what the plan reads (claim, invoices, markers) takes the same lock.
        const fresh = summarise(await this.catchup.plan(tenantId, now));
        if ((fresh.summary?.stubCents ?? null) !== (req.expectedBefore ?? null)) {
          throw new ConflictException({
            code: API_ERROR_CODES.CATCHUP_PREVIEW_STALE,
            message: "The catch-up changed since you looked. Review it again. Nothing was written.",
            current: fresh.summary?.stubCents ?? null,
          });
        }
        const ids: string[] = [];
        for (const r of rows) {
          const created = await tx.auditLog.create({
            data: {
              tenantId,
              userId: actorId,
              action: r.action,
              entityType: ADMIN_AUDIT_ENTITY,
              entityId: tenantId,
              meta: { platformAdmin: true, ...r.meta } as never,
            },
            select: { id: true },
          });
          ids.push(created.id);
        }
        return ids;
      },
      { timeout: 20_000 },
    );
    return { tenantId, appended };
  }

  /** The request's shape: at least one action, no marker in both lists, a real billing start. */
  private validate(req: CorrectionRequest): Planned {
    const uniq = (xs?: string[]) => [...new Set((xs ?? []).map(String))];
    const voidCoverage = uniq(req.voidCoverage);
    const restoreCoverage = uniq(req.restoreCoverage);
    if (voidCoverage.length + restoreCoverage.length === 0 && !req.billingStart) {
      throw new BadRequestException(
        "Name at least one change: a payment to mark not paid or count again, or a billing start.",
      );
    }
    const both = voidCoverage.find((id) => restoreCoverage.includes(id));
    if (both) {
      throw new BadRequestException({
        code: API_ERROR_CODES.CATCHUP_CORRECTION_CONFLICT,
        message: "One payment cannot be marked not paid and counted again in the same change.",
      });
    }
    return {
      voidCoverage,
      restoreCoverage,
      billingStart: req.billingStart ? parseBillingStart(req.billingStart) : null,
    };
  }

  /** Every marker named must be one of THIS tenant's activation markers (another tenant's id is a 404). */
  private assertKnownMarkers(report: CatchupReport, p: Planned): void {
    const known = new Set(report.markers.map((m) => m.id));
    for (const id of [...p.voidCoverage, ...p.restoreCoverage]) {
      if (!known.has(id)) throw new NotFoundException("That payment is not one of this tenant's.");
    }
  }

  /** In-memory rows strictly later than every stored marker row, so they win the latest-row rule in the AFTER. */
  private async hypothetical(tenantId: string, p: Planned, now: Date): Promise<MarkerAuditRow[]> {
    const latest = (await this.prisma.auditLog.findFirst({
      where: {
        tenantId,
        entityType: ADMIN_AUDIT_ENTITY,
        action: { in: [...CATCHUP_MARKER_ACTIONS] },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    })) as { createdAt: Date } | null;
    const t0 = Math.max(now.getTime(), latest?.createdAt.getTime() ?? 0) + 1000;
    return buildCorrectionRows(p, {
      reason: "preview",
      actor: "preview",
      ownerApprovedAt: now.toISOString(),
    }).map((r, i) => ({
      id: `~preview-${i}`,
      action: r.action,
      createdAt: new Date(t0 + i),
      meta: r.meta,
    }));
  }
}
