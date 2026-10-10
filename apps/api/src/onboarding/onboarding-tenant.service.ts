import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  OnboardingAutoResult,
  TenantOnboardingResponse,
  TenantOnboardingStep,
  TenantOnboardingView,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { STEPS, SIGN_OFF_STEP_KEY, catalogStep, stageIndex } from "./onboarding-catalog";
import { API_ERROR_CODES } from "../common/api-error-codes";

type CaseRow = Prisma.OnboardingCaseGetPayload<{ include: { steps: true } }>;
type StepRow = CaseRow["steps"][number];

export const SIGNED_NAME_MAX = 120;

export interface SignOffActor {
  userId: string;
  tenantId: string;
  /** Set on an impersonation token — a super-admin acting as the workspace admin. */
  impersonatedBy?: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The workspace's own view of its onboarding case (#2159 S4): the "Getting started"
 * page, the dashboard banner, and the customer's written sign-off.
 *
 * PLATFORM-LEVEL rows, read with the BASE Prisma client like OnboardingService — but every
 * query here is keyed by the CALLER's `tenantId` (from the JWT), never by an id the client
 * sends, so a workspace can only ever see or sign its own case.
 *
 * What reaches the tenant is deliberately narrow: CUSTOMER-owned steps only, and none of
 * the back office's deal terms, notes, evidence, waiver reasons or admin ids.
 */
@Injectable()
export class OnboardingTenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getForTenant(tenantId: string): Promise<TenantOnboardingResponse> {
    const c = await this.prisma.onboardingCase.findUnique({
      where: { tenantId },
      include: { steps: true },
    });
    // A LOST case is the back office's business, not the workspace's.
    if (!c || c.status === "LOST") return { onboarding: null };
    return { onboarding: toView(c) };
  }

  async signOff(actor: SignOffActor, signedNameRaw: string): Promise<TenantOnboardingResponse> {
    // The playbook's "written sign-off" is the customer's own word. A super-admin
    // impersonating the workspace admin must never be able to give it on their behalf.
    if (actor.impersonatedBy) {
      throw new ForbiddenException(
        "Sign-off must be given by the workspace admin, not during impersonation",
      );
    }
    const signedName = (signedNameRaw ?? "").trim().replace(/\s+/g, " ");
    if (signedName.length < 2 || signedName.length > SIGNED_NAME_MAX) {
      throw new BadRequestException(
        `Type your full name to sign off (2–${SIGNED_NAME_MAX} characters)`,
      );
    }

    const caseId = await this.prisma.$transaction(async (tx) => {
      const found = await tx.onboardingCase.findUnique({
        where: { tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!found) throw new NotFoundException("No onboarding in progress for this workspace");
      await tx.$queryRaw`SELECT id FROM "OnboardingCase" WHERE id = ${found.id} FOR UPDATE`;
      const c = await tx.onboardingCase.findUnique({
        where: { id: found.id },
        include: { steps: true },
      });
      if (!c) throw new NotFoundException("No onboarding in progress for this workspace");
      const step = c.steps.find((s) => s.key === SIGN_OFF_STEP_KEY);
      if (step?.status === "DONE") return null; // already signed: idempotent, nothing rewritten
      if (!step || !signOffAvailable(c, step)) {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.ONBOARDING_SIGN_OFF_NOT_AVAILABLE,
          message: "Sign-off isn't open yet — your onboarding lead will let you know when it is",
        });
      }
      const at = new Date();
      await tx.onboardingStep.update({
        where: { id: step.id },
        data: {
          status: "DONE",
          doneById: actor.userId,
          doneAt: at,
          evidence: {
            signedName,
            signedByUserId: actor.userId,
            signedAt: at.toISOString(),
            ip: actor.ip,
            userAgent: actor.userAgent,
            via: "tenant",
          },
        },
      });
      await tx.onboardingEvent.create({
        data: {
          caseId: c.id,
          type: "step.completed",
          actorType: "CUSTOMER",
          actorId: actor.userId,
          payload: { key: SIGN_OFF_STEP_KEY, via: "tenant", signedName },
        },
      });
      return c.id;
    });

    if (caseId) {
      await this.audit.log({
        tenantId: actor.tenantId,
        userId: actor.userId,
        action: "ONBOARDING_SIGNED_OFF",
        entityType: "OnboardingCase",
        entityId: caseId,
        ip: actor.ip ?? undefined,
        meta: { signedName },
      });
    }
    return this.getForTenant(actor.tenantId);
  }
}

function signOffAvailable(c: CaseRow, step: StepRow): boolean {
  return c.status === "OPEN" && c.stage === step.stage && step.status === "PENDING";
}

function toView(c: CaseRow): TenantOnboardingView {
  const order = (key: string) => {
    const i = STEPS.findIndex((s) => s.key === key);
    return i < 0 ? Infinity : i;
  };
  const customerSteps = c.steps
    .filter((s) => catalogStep(s.key)?.owner === "CUSTOMER")
    .sort((a, b) => stageIndex(a.stage) - stageIndex(b.stage) || order(a.key) - order(b.key));

  const steps: TenantOnboardingStep[] = customerSteps.map((s) => {
    const auto = s.autoResult as unknown as OnboardingAutoResult | null;
    return {
      key: s.key,
      stage: s.stage,
      title: s.title,
      required: s.required,
      status: s.status,
      doneAt: s.status === "DONE" ? (s.doneAt?.toISOString() ?? null) : null,
      check: auto ? { ok: auto.ok, detail: auto.detail } : null,
    };
  });

  const sign = c.steps.find((s) => s.key === SIGN_OFF_STEP_KEY);
  const evidence = (sign?.evidence as { signedName?: unknown } | null) ?? null;
  return {
    stage: c.stage,
    status: c.status,
    targetGoLiveOn: c.targetGoLiveOn ? c.targetGoLiveOn.toISOString().slice(0, 10) : null,
    steps,
    signOff: sign
      ? {
          status: sign.status,
          signedAt: sign.status === "DONE" ? (sign.doneAt?.toISOString() ?? null) : null,
          signedName:
            sign.status === "DONE" && typeof evidence?.signedName === "string"
              ? evidence.signedName
              : null,
          available: signOffAvailable(c, sign),
        }
      : null,
  };
}
