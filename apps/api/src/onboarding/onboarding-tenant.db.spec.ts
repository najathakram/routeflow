/**
 * Real-Postgres pins for the tenant-side "Getting started" view and sign-off (#2159 S4,
 * plan §8 S4: "sign-off is TENANT_ADMIN only and marks the case step").
 *
 *   - the view is the CALLER's case only (two tenants, two cases), CUSTOMER-owned steps only,
 *     and never carries back-office evidence, waiver reasons or deal terms;
 *   - sign-off is refused (409, nothing written) before VERIFY_TRAIN; at VERIFY_TRAIN it marks
 *     `verify.signOff` DONE with the typed name, writes a CUSTOMER event and a tenant audit row;
 *     a second sign-off is idempotent (row byte-identical);
 *   - impersonation is refused with nothing written;
 *   - a LOST case is invisible to the workspace.
 *
 * SAFETY: tenants are throwaway `qa-onb4-*` slugs (assertTestTenant); `afterAll` deletes
 * exactly what this file created.
 */
import { randomUUID } from "crypto";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { OnboardingService } from "./onboarding.service";
import { OnboardingTenantService } from "./onboarding-tenant.service";
import { SIGN_OFF_STEP_KEY, STAGE_ORDER, STEPS } from "./onboarding-catalog";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const ADMIN = `db-spec-onb4-admin-${RUN}`;
let seq = 0;

describeDb("tenant onboarding view + sign-off (#2159 S4) — real Postgres", () => {
  let prisma: PrismaService;
  let backOffice: OnboardingService;
  let svc: OnboardingTenantService;
  const caseIds: string[] = [];
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    const tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const audit = new AuditService(prisma);
    backOffice = new OnboardingService(prisma, audit, tenantCtx);
    svc = new OnboardingTenantService(prisma, audit);
  });

  afterAll(async () => {
    try {
      await prisma.onboardingCase.deleteMany({ where: { id: { in: caseIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: ADMIN } });
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      for (const tenantId of tenantIds) {
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      }
    } finally {
      await prisma?.$disconnect();
    }
  });

  /** A tenant with its TENANT_ADMIN, and an OPEN case linked to it (as S3a's Activate will). */
  async function world(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-onb4-${RUN}-${seq}-${label}`, "onboarding-tenant.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `Onb4 ${slug}` } });
    tenantIds.push(tenant.id);
    const admin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: `admin-${RUN}-${seq}`,
        email: `admin-${RUN}-${seq}@example.invalid`,
        role: "TENANT_ADMIN",
      },
    });
    const c = await backOffice.create(
      {
        companyName: `Acme ${label} ${RUN}`,
        contactName: "Pat Example",
        contactEmail: `pat-${RUN}-${seq}@example.invalid`,
        dealTerms: { planKey: "TEAM", setupFeeCents: 50000, note: "internal: discount agreed" },
      },
      ADMIN,
    );
    caseIds.push(c.id);
    await prisma.onboardingCase.update({ where: { id: c.id }, data: { tenantId: tenant.id } });
    return { tenant, admin, caseId: c.id };
  }

  function actor(w: { tenant: { id: string }; admin: { id: string } }, extra = {}) {
    return {
      userId: w.admin.id,
      tenantId: w.tenant.id,
      impersonatedBy: null,
      ip: "203.0.113.7",
      userAgent: "db-spec",
      ...extra,
    };
  }

  /** Clear and advance stage by stage until the case sits at `target`. */
  async function advanceTo(caseId: string, target: (typeof STAGE_ORDER)[number]) {
    for (;;) {
      const c = await backOffice.get(caseId);
      if (c.stage === target) return;
      for (const s of c.steps.filter(
        (x) => x.stage === c.stage && x.required && x.status === "PENDING",
      )) {
        await backOffice.completeStep(caseId, s.key, { note: "db-spec" }, ADMIN);
      }
      await backOffice.advance(caseId, ADMIN);
    }
  }

  async function signOffRow(caseId: string) {
    return prisma.onboardingStep.findUniqueOrThrow({
      where: { caseId_key: { caseId, key: SIGN_OFF_STEP_KEY } },
    });
  }

  it("shows the caller's OWN case, CUSTOMER steps only, and no back-office internals", async () => {
    const a = await world("a");
    const b = await world("b");
    // A back-office waiver + evidence on a customer step must not leak.
    const customerKeys = STEPS.filter((s) => s.owner === "CUSTOMER").map((s) => s.key);
    await backOffice.completeStep(
      a.caseId,
      STEPS.find((s) => s.owner === "CUSTOMER" && s.stage === "FOLLOW_UP")?.key ?? customerKeys[0],
      { note: "SECRET-BACKOFFICE-NOTE" },
      ADMIN,
    );

    const viewA = (await svc.getForTenant(a.tenant.id)).onboarding!;
    const viewB = (await svc.getForTenant(b.tenant.id)).onboarding!;
    expect(viewA.steps.map((s) => s.key).sort()).toEqual([...customerKeys].sort());
    expect(viewA.stage).toBe("FOLLOW_UP");
    const json = JSON.stringify(viewA);
    expect(json).not.toContain("SECRET-BACKOFFICE-NOTE");
    expect(json).not.toContain("discount agreed");
    expect(json).not.toContain("setupFeeCents");
    expect(json).not.toContain(ADMIN);
    // B's view is B's own case: nothing A did shows up there.
    expect(viewB.steps.every((s) => s.status === "PENDING")).toBe(true);
    expect(viewA.signOff).toMatchObject({ status: "PENDING", available: false });
  });

  it("refuses sign-off before VERIFY_TRAIN with nothing written", async () => {
    const w = await world("early");
    const before = await signOffRow(w.caseId);
    const err = await svc.signOff(actor(w), "Pat Example").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "ONBOARDING_SIGN_OFF_NOT_AVAILABLE",
    });
    expect(await signOffRow(w.caseId)).toEqual(before);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: w.tenant.id, action: "ONBOARDING_SIGNED_OFF" },
      }),
    ).toBe(0);
  });

  it("at VERIFY_TRAIN: marks verify.signOff DONE with the typed name, a CUSTOMER event and an audit row; a repeat is idempotent", async () => {
    const w = await world("sign");
    await advanceTo(w.caseId, "VERIFY_TRAIN");
    expect((await svc.getForTenant(w.tenant.id)).onboarding!.signOff).toMatchObject({
      status: "PENDING",
      available: true,
    });

    const res = await svc.signOff(actor(w), "  Pat   Example ");
    expect(res.onboarding!.signOff).toMatchObject({
      status: "DONE",
      signedName: "Pat Example",
      available: false,
    });
    const row = await signOffRow(w.caseId);
    expect(row.status).toBe("DONE");
    expect(row.doneById).toBe(w.admin.id);
    expect(row.evidence).toMatchObject({
      signedName: "Pat Example",
      signedByUserId: w.admin.id,
      ip: "203.0.113.7",
      via: "tenant",
    });
    const events = await prisma.onboardingEvent.findMany({
      where: { caseId: w.caseId, actorType: "CUSTOMER" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "step.completed", actorId: w.admin.id });
    const audit = await prisma.auditLog.findMany({
      where: { tenantId: w.tenant.id, action: "ONBOARDING_SIGNED_OFF" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: w.admin.id, entityId: w.caseId });

    // The back office sees it as a cleared step: VERIFY_TRAIN's blockers no longer list it.
    const detail = await backOffice.get(w.caseId);
    expect(detail.steps.find((s) => s.key === SIGN_OFF_STEP_KEY)?.status).toBe("DONE");

    // Idempotent: a second sign-off rewrites nothing and logs nothing.
    await svc.signOff(actor(w), "Someone Else");
    expect(await signOffRow(w.caseId)).toEqual(row);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: w.tenant.id, action: "ONBOARDING_SIGNED_OFF" },
      }),
    ).toBe(1);
  });

  it("refuses an impersonating super-admin with nothing written", async () => {
    const w = await world("imp");
    await advanceTo(w.caseId, "VERIFY_TRAIN");
    const before = await signOffRow(w.caseId);
    await expect(
      svc.signOff(actor(w, { impersonatedBy: "super-admin-1" }), "Pat Example"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await signOffRow(w.caseId)).toEqual(before);
  });

  it("hides a LOST case and refuses sign-off on a case that is not OPEN", async () => {
    const w = await world("lost");
    await advanceTo(w.caseId, "VERIFY_TRAIN");
    await backOffice.update(w.caseId, { status: "ON_HOLD" }, ADMIN);
    await expect(svc.signOff(actor(w), "Pat Example")).rejects.toBeInstanceOf(ConflictException);
    await backOffice.update(w.caseId, { status: "LOST", lostReason: "went elsewhere" }, ADMIN);
    expect(await svc.getForTenant(w.tenant.id)).toEqual({ onboarding: null });
  });
});
