import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { TenantStatus } from "@prisma/client";
import type { FirstRunAnswer, FirstRunResult, FirstRunStatus } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AuditService } from "../audit/audit.service";
import {
  BusinessProfileApplyService,
  type ApplyIo,
} from "../billing/business-profile-apply.service";
import { fillsBlanks } from "../billing/business-capabilities";
import { BusinessProfileService, planFingerprint } from "../billing/business-profile.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { closeFirstRun, readFirstRun } from "../billing/first-run-marker";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { requireTenantContext } from "../settings-inventory/require-tenant-context";

const TICKS = ["delivery", "shipping", "counter"] as const;

const refuse = (code: string, message: string) =>
  new BadRequestException({ statusCode: 400, code, message });

/**
 * The first-question body, as the card sends it. `unknown` in: the service parses it into coded 400s. Only the three
 * ticks are accepted, each `true` or `false`: a body that carries door payments, opens-as or anything else is refused,
 * so the tenant path can never reach those writes. Nothing ticked is FIRST_RUN_EMPTY.
 */
export function parseFirstRunAnswer(body: unknown): Required<FirstRunAnswer> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw refuse(API_ERROR_CODES.FIRST_RUN_INVALID, "Send delivery, shipping and counter.");
  }
  const out = { delivery: false, shipping: false, counter: false };
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!(TICKS as readonly string[]).includes(key) || typeof value !== "boolean") {
      throw refuse(API_ERROR_CODES.FIRST_RUN_INVALID, "Send delivery, shipping and counter.");
    }
    out[key as (typeof TICKS)[number]] = value;
  }
  if (!out.delivery && !out.shipping && !out.counter) {
    throw refuse(API_ERROR_CODES.FIRST_RUN_EMPTY, "Choose at least one.");
  }
  return out;
}

const closed = () =>
  new ConflictException({
    statusCode: 409,
    code: API_ERROR_CODES.FIRST_RUN_CLOSED,
    message: "This question is not open for your account.",
  });

/** A write the fills-blanks rule means is never reached; reaching one is a bug, so it stops loudly. */
const unreachable = (what: string) => async (): Promise<never> => {
  throw new Error(`first-run: ${what} is unreachable under the fills-blanks rule`);
};

/**
 * W1: the new account's first question ("How do orders reach your customers?"), answered by its own admin.
 *
 * It goes through the planner and the ONE apply sequence the back office uses, but only FILLS BLANKS: it applies a
 * plan only if it stops no billing, changes no override, and every mode change starts from `unset`. Anything else
 * writes only the marker (`closed`), because the team, or an earlier partial apply with a different answer, already
 * set the account up. The marker is read inside the confirm lock and written last, so an apply that stopped halfway
 * is finished by the same answer, and two tabs cannot both apply.
 */
@Injectable()
export class FirstRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureConfig: FeatureConfigService,
    private readonly businessProfiles: BusinessProfileService,
    private readonly applyService: BusinessProfileApplyService,
    private readonly audit: AuditService,
  ) {}

  /** Tenant from the request context ONLY; the caller's token must be for that tenant. */
  private tenantOf(user: JwtPayload): string {
    const tenantId = requireTenantContext(this.prisma);
    if (user.tenantId !== tenantId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: API_ERROR_CODES.FULFILMENT_TENANT_MISMATCH,
        message: "This account does not belong to the current tenant.",
      });
    }
    return tenantId;
  }

  /** The card's one read. No marker (every existing account), or a read-only account, is `state: null`: no card. */
  async status(user: JwtPayload): Promise<FirstRunStatus> {
    const tenantId = this.tenantOf(user);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, status: true },
    });
    const workspaceId = tenant?.slug ?? user.tenantSlug ?? "";
    const none: FirstRunStatus = {
      state: null,
      workspaceId,
      delivery: false,
      shipping: false,
      counter: false,
      hasOrder: false,
    };
    const marker = await readFirstRun(this.prisma, tenantId);
    if (!marker) return none;
    if (!tenant || tenant.status === TenantStatus.READ_ONLY) return none;
    const caps = await this.businessProfiles.capabilities(tenantId);
    const firstOrder = await this.prisma.order.findFirst({
      where: { tenantId },
      select: { id: true },
    });
    return {
      state: marker,
      workspaceId,
      delivery: caps.delivery,
      shipping: caps.shipping,
      counter: caps.counter,
      hasOrder: firstOrder !== null,
    };
  }

  async answer(body: unknown, user: JwtPayload): Promise<FirstRunResult> {
    const ticks = parseFirstRunAnswer(body);
    const tenantId = this.tenantOf(user);
    return this.businessProfiles.withConfirmLock(tenantId, async () => {
      if ((await readFirstRun(this.prisma, tenantId)) !== "pending") throw closed();
      // Re-plan from the DB, not this replica's 30 s mode cache, as both back-office routes do.
      this.featureConfig.forgetCachedModes(tenantId);
      const resolved = await this.businessProfiles.planFirstRun(tenantId, ticks);

      if (!fillsBlanks(resolved.plan)) {
        await closeFirstRun(this.prisma, tenantId, "closed");
        await this.audit.log({
          tenantId,
          userId: user.sub,
          action: "FIRST_RUN_KEPT",
          entityType: "tenant",
          entityId: tenantId,
          meta: { answer: ticks },
        });
        return { outcome: "kept", state: "closed" };
      }

      const io: ApplyIo = {
        disableAddon: unreachable("a billing disable"),
        createOverride: unreachable("an override create"),
        revokeOverride: unreachable("an override revoke"),
        audit: (action, details) =>
          this.audit.log({
            tenantId,
            userId: user.sub,
            action,
            entityType: "tenant",
            entityId: tenantId,
            meta: details,
          }),
      };
      await this.applyService.applyResolvedLocked(
        tenantId,
        resolved,
        { planFingerprint: planFingerprint(resolved.plan) },
        { id: user.sub, kind: "TENANT_USER", source: "signup.setup" },
        io,
      );
      await closeFirstRun(this.prisma, tenantId, "answered");
      return { outcome: "applied", state: "answered" };
    });
  }
}
