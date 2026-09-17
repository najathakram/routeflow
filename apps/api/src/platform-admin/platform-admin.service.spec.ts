import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PlatformAdminService } from "./platform-admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { BillingService } from "../billing/billing.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { ProrationService } from "../billing/proration.service";
import { PlatformPricingService } from "../billing/platform-pricing.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { BillingEventService } from "../billing/billing-event.service";
import { MeterService } from "../billing/meter.service";
import { MrrService } from "../billing/mrr.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { TenantMirrorService } from "./tenant-mirror.service";
import { AdminAuditAction } from "./audit-actions.constant";

/**
 * P1 regression: platform-admin lifecycle mutations MUST emit a purpose-built
 * audit row keyed to the TARGET tenant (tenantId=target, userId=super-admin,
 * entityType="tenant", entityId=target, structured action code). Before this,
 * only the generic interceptor logged these with tenantId=null, so they never
 * surfaced under a per-tenant filter — and impersonation writes weren't logged
 * at all despite the controller claiming they were.
 */
describe("PlatformAdminService — audit provenance", () => {
  let service: PlatformAdminService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let auditLog: jest.Mock;
  let planCatalogService: { getPublishedVersion: jest.Mock };
  let prorationService: { proratedDiff: jest.Mock };
  let entitlementsService: { resolve: jest.Mock; invalidate: jest.Mock };
  let billingEventService: { emit: jest.Mock };
  let meterService: { readAll: jest.Mock };
  let featureOverrides: { allActive: jest.Mock };
  let platformPricingService: { resolveTenantPricing: jest.Mock };
  let mrrService: { computeOverview: jest.Mock; priceTenant: jest.Mock };
  // WP3b: named so the createTenant — LITE plan describe block can assert on the checkout
  // options passed through and on the welcome email body, instead of re-deriving them via
  // module.get() (every other collaborator mock here is already reachable this way).
  let billingServiceMock: {
    createCheckoutSession: jest.Mock;
    syncStripeSubscriptionPrice: jest.Mock;
  };
  let emailServiceMock: { send: jest.Mock };
  let tenantMirror: { upsert: jest.Mock };

  const ADMIN_ID = "super-1";
  const TENANT_ID = "tenant-1";

  beforeEach(async () => {
    prisma = createMockPrisma();
    // createMockPrisma omits these two models; the service touches both.
    (prisma as any).tenantSubscription = {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      // getBillingOverview()'s subscriptions list (REG-743-N4).
      findMany: jest.fn().mockResolvedValue([]),
      // B216: updateStatus()'s admin-reactivation downgrade-disarm write.
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      // ADMIN-UPDATEPLAN-1: updatePlan()'s downgrade-scheduling write (mirrors
      // SubscriptionMutationService.downgrade(), which also uses a plain update — the row
      // must already exist to carry a periodEnd to schedule against).
      update: jest.fn().mockResolvedValue({}),
    };
    (prisma as any).auditLog = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    // createMockPrisma's default $transaction mock builds `tx` from its internal model
    // set, which — like the top level — omits tenantSubscription. updatePlan writes
    // both tenant and tenantSubscription inside one transaction, so extend tx to carry
    // it too (reusing the same mock instance the top-level assertions read from).
    (prisma.$transaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, tenantSubscription: (prisma as any).tenantSubscription }),
    );

    auditLog = jest.fn().mockResolvedValue(undefined);
    // Default: unseeded catalog — MRR/entitlements tests override per-case.
    planCatalogService = { getPublishedVersion: jest.fn().mockResolvedValue(null) };
    prorationService = { proratedDiff: jest.fn().mockReturnValue(0) };
    entitlementsService = { resolve: jest.fn(), invalidate: jest.fn() };
    billingEventService = { emit: jest.fn().mockResolvedValue({}) };
    meterService = { readAll: jest.fn() };
    // Every pre-existing test in this file exercises a tenant with no override rows, so this
    // collaborator-contract addition (Opus review of 8130b204, item 4) defaults to "no
    // override" — the same raw-entitlements behavior those tests already assert on.
    featureOverrides = { allActive: jest.fn().mockResolvedValue(new Map()) };
    platformPricingService = { resolveTenantPricing: jest.fn() };
    // Default: zeroed overview — the getStats-enrichment describe block below overrides
    // per-case to prove getStats() reads MrrService, not a re-derived estimate.
    mrrService = {
      computeOverview: jest.fn().mockResolvedValue({
        mrr: 0,
        baseMrr: 0,
        addonMrr: 0,
        discountTotal: 0,
        payingTenants: 0,
        trialTenants: 0,
        readOnlyTenants: 0,
        byPlan: [],
        ledgerMrr: 0,
        momDelta: 0,
      }),
      priceTenant: jest.fn().mockResolvedValue(0),
    };
    emailServiceMock = { send: jest.fn().mockResolvedValue(undefined) };
    billingServiceMock = {
      createCheckoutSession: jest.fn().mockRejectedValue(new Error("no stripe")),
      syncStripeSubscriptionPrice: jest.fn().mockResolvedValue({ synced: false }),
    };
    // R18: the mirror call sites are best-effort — tests that care override upsert to reject.
    tenantMirror = { upsert: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue("signed.jwt") } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue({ secret: "s", expiresIn: "15m" }) },
        },
        { provide: EmailService, useValue: emailServiceMock },
        { provide: BillingService, useValue: billingServiceMock },
        { provide: PlanCatalogService, useValue: planCatalogService },
        { provide: ProrationService, useValue: prorationService },
        { provide: PlatformPricingService, useValue: platformPricingService },
        { provide: EntitlementsService, useValue: entitlementsService },
        { provide: BillingEventService, useValue: billingEventService },
        { provide: MeterService, useValue: meterService },
        { provide: TenantStatusGuard, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: auditLog } },
        { provide: MrrService, useValue: mrrService },
        { provide: TenantMirrorService, useValue: tenantMirror },
        { provide: FeatureOverrideService, useValue: featureOverrides },
      ],
    }).compile();

    service = module.get<PlatformAdminService>(PlatformAdminService);
  });

  it("logs TENANT_SUSPENDED against the target tenant with the acting admin", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      status: "SUSPENDED",
    } as any);

    await service.updateStatus(TENANT_ID, { status: "SUSPENDED" } as any, ADMIN_ID);

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        action: "TENANT_SUSPENDED",
        entityType: "tenant",
        entityId: TENANT_ID,
      }),
    );
  });

  it("maps a reactivation to TENANT_REACTIVATED", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      status: "ACTIVE",
    } as any);

    await service.updateStatus(TENANT_ID, { status: "ACTIVE" } as any, ADMIN_ID);

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "TENANT_REACTIVATED", tenantId: TENANT_ID }),
    );
  });

  // FINDING-4 RULING (2026-09-14, lead): an admin reactivation LEAVES an armed downgrade armed.
  // Only downgrade() (the tenant) and updatePlan()'s scheduled branch ever set
  // downgradeToPlanKey, so the field set is always a CHOSEN schedule and never a dunning threat
  // the system armed — clearing it here revoked the tenant's own choice by someone else's
  // action, silently and unaudited, leaving them on the higher plan they had asked to leave.
  // B216's earlier reading (a stale schedule must not fire against a paying tenant) is
  // superseded: firing IS the tenant's stated intent. The Stripe-webhook disarm in
  // billing.service.ts is out of scope here and unchanged — see the note raised to the lead.
  describe("updateStatus — FINDING-4 the armed downgrade survives reactivation", () => {
    const ARMED_AT = new Date("2026-03-01T00:00:00.000Z");

    it("REG-B402 keeps a tenant's armed downgrade when an admin reactivates a lapsed (SUSPENDED) tenant, and names it in the audit meta", async () => {
      // FINDING-3 shape: the prior-status read is a CAS `updateMany` predicated on
      // status != ACTIVE — count === 1 means THIS call performed a real transition.
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      prisma.tenant.updateMany.mockResolvedValue({ count: 1 });
      prisma.tenant.update.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        status: "ACTIVE",
      } as any);
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: ARMED_AT,
      });

      await service.updateStatus(TENANT_ID, { status: "ACTIVE" } as any, ADMIN_ID);

      // RED against the round-2 build, which cleared the three fields here.
      expect((prisma as any).tenantSubscription.updateMany).not.toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "TENANT_REACTIVATED",
          meta: expect.objectContaining({
            downgradeLeftArmed: "STARTER",
            downgradeEffectiveAt: ARMED_AT.toISOString(),
          }),
        }),
      );
    });

    it("REG-B402 a reactivation with NO armed downgrade audits neither schedule field", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      prisma.tenant.updateMany.mockResolvedValue({ count: 1 });
      prisma.tenant.update.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        status: "ACTIVE",
      } as any);
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        downgradeToPlanKey: null,
        downgradeEffectiveAt: null,
      });

      await service.updateStatus(TENANT_ID, { status: "ACTIVE" } as any, ADMIN_ID);

      const meta = auditLog.mock.calls.at(-1)![0].meta;
      expect(meta).not.toHaveProperty("downgradeLeftArmed");
      expect(meta).not.toHaveProperty("downgradeEffectiveAt");
    });

    it("guard: updateStatus NEVER writes to TenantSubscription on any path — the schedule and cancelAtPeriodEnd are both the tenant's to change", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      prisma.tenant.updateMany.mockResolvedValue({ count: 1 });
      prisma.tenant.update.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        status: "ACTIVE",
      } as any);
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: ARMED_AT,
      });

      await service.updateStatus(TENANT_ID, { status: "ACTIVE" } as any, ADMIN_ID);

      expect((prisma as any).tenantSubscription.updateMany).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.update).not.toHaveBeenCalled();
    });

    it("guard: an already-ACTIVE tenant set ACTIVE again never even reads the schedule (lost CAS)", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      // Lost CAS: the where clause (status != ACTIVE) matched nothing — already ACTIVE.
      prisma.tenant.updateMany.mockResolvedValue({ count: 0 });
      prisma.tenant.update.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        status: "ACTIVE",
      } as any);

      await service.updateStatus(TENANT_ID, { status: "ACTIVE" } as any, ADMIN_ID);

      expect((prisma as any).tenantSubscription.findUnique).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.updateMany).not.toHaveBeenCalled();
    });

    it("guard: transitioning to a non-ACTIVE status (READ_ONLY) never runs the CAS or reads the schedule", async () => {
      prisma.tenant.findUnique.mockResolvedValueOnce({ id: TENANT_ID, slug: "acme" } as any);
      prisma.tenant.update.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        status: "READ_ONLY",
      } as any);

      await service.updateStatus(TENANT_ID, { status: "READ_ONLY" } as any, ADMIN_ID);

      // A non-ACTIVE target never runs the CAS at all.
      expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.findUnique).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.updateMany).not.toHaveBeenCalled();
    });

    // FINDING-3 (SHOULD, round 2 review): the old version read `wasActive`, wrote the status,
    // then touched the downgrade as THREE separate, unserialized queries. This is a STRUCTURAL
    // PIN, not a live race test: jest's Prisma mock has no real concurrency to exercise, so it
    // can only assert the SHAPE is atomic — one `$transaction` call wrapping a CAS predicated on
    // the prior status, exactly like billing.service.ts's transitionAndEmit(). It still matters
    // after FINDING-4: the schedule the audit line reports must be the row as it stood AT the
    // transition, not one a concurrent downgrade() armed a moment later.
    it("REG-B402 folds the status CAS and the schedule read into ONE transaction (structural pin — see note)", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      prisma.tenant.updateMany.mockResolvedValue({ count: 1 });
      prisma.tenant.update.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        status: "ACTIVE",
      } as any);
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        downgradeToPlanKey: null,
        downgradeEffectiveAt: null,
      });

      await service.updateStatus(TENANT_ID, { status: "ACTIVE" } as any, ADMIN_ID);

      // RED against pre-fix updateStatus(), which never wraps any of this in a transaction.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.tenant.updateMany).toHaveBeenCalledWith({
        where: { id: TENANT_ID, status: { not: "ACTIVE" } },
        data: { status: "ACTIVE" },
      });
    });
  });

  it("logs TENANT_PLAN_CHANGED with the previous and new plan in meta, writes planKey/planVersionId consistent with subscribe(), and invalidates entitlements", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
      status: "ACTIVE",
    } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "PROFESSIONAL",
    } as any);
    planCatalogService.getPublishedVersion.mockResolvedValue({
      id: "v-9",
      definitions: [
        { planKey: "STARTER", monthlyPrice: 99 },
        { planKey: "GROWTH", monthlyPrice: 249 },
        { planKey: "SCALE", monthlyPrice: 499 },
        { planKey: "ENTERPRISE", monthlyPrice: null },
      ],
    });
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      planKey: "STARTER",
      basePriceSnapshot: 99,
      priceOverrideMonthly: null,
      discount: null,
    });

    await service.updatePlan(TENANT_ID, { plan: "PROFESSIONAL" } as any, ADMIN_ID);

    // PROFESSIONAL normalizes to SCALE (planKeyFromEnum) — the write must carry the
    // catalog's resolved planKey + the published version id, the same shape
    // SubscriptionMutationService.subscribe() writes (subscription-mutation.service.ts:132-163).
    // basePriceSnapshot moves with planKey: MrrService prices from the snapshot alone, so a
    // stale/absent one would report SCALE tenants at the old plan's price (or $0).
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { plan: "PROFESSIONAL", planVersionId: "v-9" },
    });
    expect((prisma as any).tenantSubscription.upsert).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      create: {
        tenantId: TENANT_ID,
        currentPlan: "PROFESSIONAL",
        planKey: "SCALE",
        planVersionId: "v-9",
        basePriceSnapshot: 499,
      },
      update: {
        currentPlan: "PROFESSIONAL",
        planKey: "SCALE",
        planVersionId: "v-9",
        basePriceSnapshot: 499,
        // A committing plan write disarms any scheduled downgrade (round 3, findings 2/9):
        // the 02:00 sweep filters on downgradeEffectiveAt alone, so one left armed would undo
        // this admin's change and deactivate every operator/driver over the target seat cap.
        downgradeToPlanKey: null,
        downgradeEffectiveAt: null,
        retainedUserIds: [],
      },
    });
    // …but it must NOT revoke a cancellation the tenant asked for — that is resume()'s job.
    expect((prisma as any).tenantSubscription.upsert.mock.calls[0][0].update).not.toHaveProperty(
      "cancelAtPeriodEnd",
    );
    expect(entitlementsService.invalidate).toHaveBeenCalledWith(TENANT_ID);

    // The snapshot run-rate moved $99 → $499, so the append-only ledger must move with it —
    // otherwise `mrr` and `ledgerMrr`/`momDelta` (mrr.service.ts:21-27) diverge by $400 forever.
    expect(billingEventService.emit).toHaveBeenCalledWith(
      TENANT_ID,
      "plan.changed",
      expect.objectContaining({ fromPlan: "STARTER", toPlan: "SCALE", platformAdmin: true }),
      expect.objectContaining({ amountDelta: 400, actorId: ADMIN_ID }),
    );

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TENANT_PLAN_CHANGED",
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        meta: expect.objectContaining({ from: "STARTER", to: "PROFESSIONAL", platformAdmin: true }),
      }),
    );
  });

  it("prices a custom (ENTERPRISE) plan from the tenant's negotiated monthly fee, not $0", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
      status: "ACTIVE",
    } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "ENTERPRISE",
    } as any);
    planCatalogService.getPublishedVersion.mockResolvedValue({
      id: "v-9",
      definitions: [
        { planKey: "STARTER", monthlyPrice: 99 },
        { planKey: "ENTERPRISE", monthlyPrice: null, isCustom: true },
      ],
    });
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      planKey: "STARTER",
      basePriceSnapshot: 99,
      priceOverrideMonthly: 1200,
      discount: null,
    });

    await service.updatePlan(TENANT_ID, { plan: "ENTERPRISE" } as any, ADMIN_ID);

    // The custom definition carries no catalog price; writing planKey with a null snapshot
    // would enter the tenant in the rollup at $0 base while its add-ons book MRR behind it.
    expect((prisma as any).tenantSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ planKey: "ENTERPRISE", basePriceSnapshot: 1200 }),
      }),
    );
    expect(billingEventService.emit).toHaveBeenCalledWith(
      TENANT_ID,
      "plan.changed",
      expect.anything(),
      expect.objectContaining({ amountDelta: 1101 }),
    );
  });

  it("books the add-ons of a plan-less ACTIVE tenant that this change makes paying", async () => {
    // Manual/external activation leaves planKey null, so neither the base nor the add-ons
    // counted (mrr.service.ts:60-66). Setting planKey crosses the tenant INTO the paying
    // set — the ledger delta is the whole contribution, add-ons and discount included.
    prisma.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
      status: "ACTIVE",
    } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "PROFESSIONAL",
    } as any);
    planCatalogService.getPublishedVersion.mockResolvedValue({
      id: "v-9",
      definitions: [{ planKey: "SCALE", monthlyPrice: 499 }],
    });
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      planKey: null,
      basePriceSnapshot: null,
      priceOverrideMonthly: null,
      discount: 10,
    });
    prisma.tenantAddon.findMany.mockResolvedValue([
      { priceSnapshot: 39, quantity: 1 },
      { priceSnapshot: 15, quantity: 2 },
    ] as any);

    await service.updatePlan(TENANT_ID, { plan: "PROFESSIONAL" } as any, ADMIN_ID);

    // 499 base + (39 + 30) add-ons − 10 discount
    expect(billingEventService.emit).toHaveBeenCalledWith(
      TENANT_ID,
      "plan.changed",
      expect.objectContaining({ fromPlan: null, toPlan: "SCALE" }),
      expect.objectContaining({ amountDelta: 558 }),
    );
  });

  it("404s updatePlan when no published plan catalog exists, without writing or invalidating", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
      status: "ACTIVE",
    } as any);
    planCatalogService.getPublishedVersion.mockResolvedValue(null);

    await expect(
      service.updatePlan(TENANT_ID, { plan: "PROFESSIONAL" } as any, ADMIN_ID),
    ).rejects.toThrow("No published plan catalog exists");

    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(entitlementsService.invalidate).not.toHaveBeenCalled();
    expect(billingEventService.emit).not.toHaveBeenCalled();
  });

  // ADMIN-UPDATEPLAN-1: updatePlan() never computed or surfaced a mid-cycle prorated amount,
  // and applied every change — upgrade AND downgrade — instantly, unlike the tenant-facing
  // path (subscribe()/upgrade()/downgrade()), which schedules a downgrade at period end with
  // no proration/credit. The lead ruling aligns the admin path to the tenant path: an upgrade
  // stays instant but now surfaces `proratedNow` from the promoted ProrationService.proratedDiff;
  // a downgrade now SCHEDULES instead of applying immediately.
  describe("updatePlan — ADMIN-UPDATEPLAN-1 proration + downgrade scheduling", () => {
    const periodStart = new Date("2026-09-01T00:00:00Z");
    const periodEnd = new Date("2026-10-01T00:00:00Z");

    it("REG-ADMIN-UPDATEPLAN-1 an UPGRADE surfaces proratedNow from the shared ProrationService.proratedDiff, called with the tenant path's own inputs, and still applies instantly", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        plan: "STARTER",
        status: "ACTIVE",
      } as any);
      prisma.tenant.update.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        plan: "PROFESSIONAL",
      } as any);
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-9",
        definitions: [
          { planKey: "STARTER", monthlyPrice: 99 },
          { planKey: "SCALE", monthlyPrice: 499 },
        ],
      });
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        planKey: "STARTER",
        basePriceSnapshot: 99,
        priceOverrideMonthly: null,
        discount: null,
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
      });
      prorationService.proratedDiff.mockReturnValue(200);

      const result = await service.updatePlan(TENANT_ID, { plan: "PROFESSIONAL" } as any, ADMIN_ID);

      // Same inputs the tenant-facing upgrade() passes to the SAME shared helper: the sub's
      // cycle/period window, and the monthly-price DELTA (new catalog price − old catalog
      // price) — never the ledger-adjusted amountDelta computed below it.
      expect(prorationService.proratedDiff).toHaveBeenCalledWith(
        { cycle: "MONTHLY", periodStart, periodEnd },
        400, // 499 − 99
      );
      expect(result.proratedNow).toBe(200);
      // An upgrade still applies instantly — unchanged from today.
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: TENANT_ID },
        data: { plan: "PROFESSIONAL", planVersionId: "v-9" },
      });
    });

    it("REG-ADMIN-UPDATEPLAN-1 a DOWNGRADE schedules at period end (downgradeToPlanKey/downgradeEffectiveAt) and does NOT change the tenant's plan today", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        plan: "PROFESSIONAL",
        status: "ACTIVE",
      } as any);
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-9",
        definitions: [
          { planKey: "STARTER", monthlyPrice: 99 },
          { planKey: "SCALE", monthlyPrice: 499 },
        ],
      });
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        planKey: "SCALE",
        basePriceSnapshot: 499,
        priceOverrideMonthly: null,
        discount: null,
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
      });

      const result = await service.updatePlan(TENANT_ID, { plan: "STARTER" } as any, ADMIN_ID);

      // FINDING-1 (round 2 review): cancelAtPeriodEnd is no longer part of this write at all —
      // the admin path has no standing to silently flip a tenant's own cancellation flag (see
      // the dedicated "FINDING-1" describe block below). Was: `..., cancelAtPeriodEnd: false`.
      expect((prisma as any).tenantSubscription.update).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID },
        data: {
          downgradeToPlanKey: "STARTER",
          downgradeEffectiveAt: periodEnd,
          retainedUserIds: [],
        },
      });
      // Nothing applies today: no instant plan write, no upsert (that is the cron's job at
      // period end, mirroring downgrade() never touching tenant.plan either).
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
      expect(result.plan).toBe("PROFESSIONAL");
      expect(result.downgradeToPlanKey).toBe("STARTER");
    });

    it("REG-R4 a scheduled downgrade books NO plan.changed ledger delta at request time — billing-cron applyScheduledDowngrades books it when it actually fires", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        plan: "PROFESSIONAL",
        status: "ACTIVE",
      } as any);
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-9",
        definitions: [
          { planKey: "STARTER", monthlyPrice: 99 },
          { planKey: "SCALE", monthlyPrice: 499 },
        ],
      });
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        planKey: "SCALE",
        basePriceSnapshot: 499,
        priceOverrideMonthly: null,
        discount: null,
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
      });

      await service.updatePlan(TENANT_ID, { plan: "STARTER" } as any, ADMIN_ID);

      // RED against pre-fix updatePlan(), which always emits "plan.changed" with the full
      // instant run-rate delta, upgrade or downgrade alike — the run-rate has not actually
      // changed yet, so booking it now (and again when the cron fires) would double-book.
      const changedCalls = billingEventService.emit.mock.calls.filter(
        (c: any[]) => c[1] === "plan.changed",
      );
      expect(changedCalls).toHaveLength(0);
    });

    // Coverage gap flagged when the row above landed: the DOWNGRADE branch's own guard —
    // it cannot SCHEDULE a downgrade against a subscription with no `periodEnd` to schedule
    // against (mirrors SubscriptionMutationService.downgrade()'s identical check at
    // subscription-mutation.service.ts:712-716 — same precondition, same reasoning: a
    // schedule written with `downgradeEffectiveAt: null` is filtered OUT by
    // billing-cron.service.ts's applyScheduledDowngrades() query, so the UI would report the
    // downgrade as accepted while the cron can never apply it) — was untested.
    it("REG a DOWNGRADE with no periodEnd on the subscription rejects with BadRequestException — writes nothing, emits nothing", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        plan: "PROFESSIONAL",
        status: "ACTIVE",
      } as any);
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-9",
        definitions: [
          { planKey: "STARTER", monthlyPrice: 99 },
          { planKey: "SCALE", monthlyPrice: 499 },
        ],
      });
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        planKey: "SCALE",
        basePriceSnapshot: 499,
        priceOverrideMonthly: null,
        discount: null,
        cycle: "MONTHLY",
        periodStart,
        periodEnd: null, // no active billing period to schedule against
      });

      await expect(
        service.updatePlan(TENANT_ID, { plan: "STARTER" } as any, ADMIN_ID),
      ).rejects.toThrow(/no active billing period/);

      expect((prisma as any).tenantSubscription.update).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(billingEventService.emit).not.toHaveBeenCalled();
    });
  });

  // FINDING-1 (MUST-FIX, money, round 2 review): updatePlan()'s DOWNGRADE branch used to write
  // `cancelAtPeriodEnd: false`, silently revoking a tenant's own pending cancellation with no
  // SUBSCRIPTION_RESUMED event and no audit line — billing then continued indefinitely on a
  // tenant who had cancelled. downgrade() (subscription-mutation.service.ts) may clear its OWN
  // tenant's cancellation because that is the tenant replacing their own choice; updatePlan() is
  // a platform admin acting on someone else's subscription and has no standing to make that
  // call. The fix refuses the WHOLE mutation — either direction — up front, before either branch
  // runs, whenever a cancellation is armed.
  describe("updatePlan — FINDING-1 refuses an admin plan change while a cancellation is armed", () => {
    const periodStart = new Date("2026-09-01T00:00:00Z");
    const periodEnd = new Date("2026-10-01T00:00:00Z");

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        plan: "STARTER",
        status: "ACTIVE",
      } as any);
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-9",
        definitions: [
          { planKey: "STARTER", monthlyPrice: 99 },
          { planKey: "SCALE", monthlyPrice: 499 },
        ],
      });
    });

    it("REG-B401 refuses an UPGRADE attempt for a tenant with cancelAtPeriodEnd: true — nothing written, no event", async () => {
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        planKey: "STARTER",
        basePriceSnapshot: 99,
        priceOverrideMonthly: null,
        discount: null,
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
        cancelAtPeriodEnd: true,
      });

      // PROFESSIONAL normalizes to SCALE — rankTo > rankFrom, an upgrade.
      await expect(
        service.updatePlan(TENANT_ID, { plan: "PROFESSIONAL" } as any, ADMIN_ID),
      ).rejects.toThrow(/cancellation pending/i);

      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.update).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
      expect(billingEventService.emit).not.toHaveBeenCalled();
    });

    it("REG-B401 refuses a DOWNGRADE attempt for a tenant with cancelAtPeriodEnd: true — nothing written, no event", async () => {
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        planKey: "SCALE",
        basePriceSnapshot: 499,
        priceOverrideMonthly: null,
        discount: null,
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
        cancelAtPeriodEnd: true,
      });

      // STARTER is a downgrade from the prior SCALE plan — rankTo < rankFrom.
      await expect(
        service.updatePlan(TENANT_ID, { plan: "STARTER" } as any, ADMIN_ID),
      ).rejects.toThrow(/cancellation pending/i);

      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.update).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
      expect(billingEventService.emit).not.toHaveBeenCalled();
    });
  });

  // FINDING-2 (MUST-FIX, money, round 2 review): the scheduling branch guarded periodEnd but not
  // the tenant's status. billing-cron.service.ts's applyScheduledDowngrades() filters on
  // `tenant.status === "ACTIVE"`, so a READ_ONLY or TRIAL tenant's "scheduled" downgrade could
  // never fire — the tenant kept the higher plan's entitlements/MRR forever. Before this wave
  // that path applied instantly, so this closes a regression the wave introduced. `before.status`
  // (read once, at the top of updatePlan, before this call writes anything) is the gate.
  describe("updatePlan — FINDING-2 gates scheduling on the tenant actually being ACTIVE", () => {
    const periodStart = new Date("2026-09-01T00:00:00Z");
    const periodEnd = new Date("2026-10-01T00:00:00Z");

    it.each(["READ_ONLY", "TRIAL"])(
      "REG-B401 a DOWNGRADE for a %s tenant applies instantly and does not schedule",
      async (status) => {
        prisma.tenant.findUnique.mockResolvedValue({
          id: TENANT_ID,
          slug: "acme",
          plan: "PROFESSIONAL",
          status,
        } as any);
        prisma.tenant.update.mockResolvedValue({
          id: TENANT_ID,
          slug: "acme",
          plan: "STARTER",
        } as any);
        planCatalogService.getPublishedVersion.mockResolvedValue({
          id: "v-9",
          definitions: [
            { planKey: "STARTER", monthlyPrice: 99 },
            { planKey: "SCALE", monthlyPrice: 499 },
          ],
        });
        (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
          planKey: "SCALE",
          basePriceSnapshot: 499,
          priceOverrideMonthly: null,
          discount: null,
          cycle: "MONTHLY",
          periodStart,
          periodEnd,
          cancelAtPeriodEnd: false,
        });

        const result = await service.updatePlan(TENANT_ID, { plan: "STARTER" } as any, ADMIN_ID);

        // RED today: the pre-fix scheduling branch guards only periodEnd, not tenant status, so
        // a READ_ONLY/TRIAL tenant gets "scheduled" against a cron that filters ACTIVE-only —
        // the change never fires and the tenant keeps paying (and using) the higher plan.
        expect((prisma as any).tenantSubscription.update).not.toHaveBeenCalled();
        expect(prisma.tenant.update).toHaveBeenCalledWith({
          where: { id: TENANT_ID },
          data: { plan: "STARTER", planVersionId: "v-9" },
        });
        const upsertArg = (prisma as any).tenantSubscription.upsert.mock.calls.at(-1)[0];
        expect(upsertArg.update.downgradeToPlanKey).toBeNull();
        expect(result.downgradeToPlanKey).toBeUndefined();
      },
    );
  });

  it("activateManualSubscription disarms every pending transition when it rolls the period (round 3, findings 2/9)", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      status: "ACTIVE",
      plan: "PROFESSIONAL",
    } as any);
    // "PROFESSIONAL" normalizes to "SCALE" via planKeyFromEnum — finding 2's fix now validates
    // the target against the published catalog before activating, so it needs a SCALE row here.
    planCatalogService.getPublishedVersion.mockResolvedValue({
      id: "v-1",
      definitions: [{ planKey: "SCALE", monthlyPrice: 349, isCustom: false }],
    } as any);

    await service.activateManualSubscription(
      TENANT_ID,
      { plan: "PROFESSIONAL", billingPeriodDays: 30, paymentMethod: "BANK_TRANSFER" } as any,
      ADMIN_ID,
    );

    // A downgrade left armed now points at the OLD (already past) period end, so the very next
    // 02:00 sweep fires it against the subscription this admin just activated — re-pricing the
    // row and deactivating every operator/driver over the target plan's seat cap.
    expect((prisma as any).tenantSubscription.upsert.mock.calls[0][0].update).toMatchObject({
      cancelAtPeriodEnd: false,
      downgradeToPlanKey: null,
      downgradeEffectiveAt: null,
      retainedUserIds: [],
    });
  });

  it("price-override back-fills a null basePriceSnapshot for a custom plan and emits the run-rate delta", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      priceOverrideMonthly: null,
      planKey: "ENTERPRISE",
      basePriceSnapshot: null,
    });

    await service.updateTenantPriceOverride(TENANT_ID, { monthly: 1200 } as any, ADMIN_ID);

    expect((prisma as any).tenantSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ basePriceSnapshot: 1200 }),
      }),
    );
    expect(billingEventService.emit).toHaveBeenCalledWith(
      TENANT_ID,
      "plan.changed",
      expect.objectContaining({ toPlan: "ENTERPRISE", priceOverrideBackfill: true }),
      expect.objectContaining({ amountDelta: 1200 }),
    );
  });

  it("price-override leaves a grandfathered basePriceSnapshot alone and emits nothing", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      priceOverrideMonthly: 800,
      planKey: "ENTERPRISE",
      basePriceSnapshot: 900,
    });

    await service.updateTenantPriceOverride(TENANT_ID, { monthly: 1200 } as any, ADMIN_ID);

    const upsertArg = (prisma as any).tenantSubscription.upsert.mock.calls.at(-1)[0];
    expect(upsertArg.update.basePriceSnapshot).toBeUndefined();
    expect(billingEventService.emit).not.toHaveBeenCalled();
  });

  it("logs IMPERSONATION_STARTED — the controller's audit-logged claim is now true", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    prisma.user.findFirst.mockResolvedValue({
      id: "admin-9",
      username: "acmeadmin",
      role: "TENANT_ADMIN",
      status: "ACTIVE",
      isAdmin: true,
      canActAsDriver: true,
    } as any);

    const res = await service.impersonate(TENANT_ID, ADMIN_ID);

    expect(res.accessToken).toBe("signed.jwt");
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        action: "IMPERSONATION_STARTED",
        entityType: "tenant",
        entityId: TENANT_ID,
        meta: expect.objectContaining({ impersonatedUserId: "admin-9" }),
      }),
    );
  });

  it("enriches audit rows with actionLabel + resolved actor/tenant, and leaves legacy rows raw", async () => {
    (prisma as any).auditLog.findMany.mockResolvedValue([
      {
        id: "log-1",
        tenantId: TENANT_ID,
        userId: "super-1",
        action: "TENANT_SUSPENDED",
        entityType: "tenant",
        entityId: TENANT_ID,
        ip: null,
        meta: {},
        createdAt: new Date(),
      },
      {
        id: "log-2",
        tenantId: null,
        userId: null,
        action: "PATCH /platform-admin/tenants/x/status",
        entityType: "platform-admin",
        entityId: "tenants",
        ip: null,
        meta: null,
        createdAt: new Date(),
      },
    ]);
    (prisma as any).auditLog.count.mockResolvedValue(2);
    prisma.user.findMany.mockResolvedValue([
      { id: "super-1", username: "aaron", email: "aaron@rf.co", role: "SUPER_ADMIN" },
    ] as any);
    prisma.tenant.findMany.mockResolvedValue([
      { id: TENANT_ID, slug: "acme", name: "Acme Corp" },
    ] as any);

    const res = await service.getAuditLogs({}, 1, 50);

    expect(res.data[0]).toEqual(
      expect.objectContaining({
        actionLabel: "Tenant suspended",
        actor: { id: "super-1", username: "aaron", email: "aaron@rf.co", isPlatform: true },
        tenant: { id: TENANT_ID, slug: "acme", name: "Acme Corp" },
      }),
    );
    // Legacy interceptor row: unknown action → no friendly label, no resolvable actor/tenant.
    expect(res.data[1].actionLabel).toBeNull();
    expect(res.data[1].actor).toBeNull();
    expect(res.data[1].tenant).toBeNull();
  });

  it("exposes known action facets for the filter dropdown", () => {
    const facets = service.getAuditLogFacets();
    expect(facets.actions.find((a) => a.code === "IMPERSONATION_STARTED")?.label).toBe(
      "Impersonation started",
    );
    expect(facets.actions.find((a) => a.code === "TENANT_PLAN_CHANGED")?.label).toBe(
      "Plan changed",
    );
  });

  // WP3b (lite-L2, R8.2): moving a tenant OFF LITE must invalidate its cached entitlements —
  // otherwise a stale LITE-scoped resolve() would keep gating (or under-gating) the tenant after
  // the plan write commits. LITE (rank 0) → STARTER (rank 1) is a ranked UPGRADE, so it takes
  // updatePlan()'s existing instant-apply branch — same branch already covered by the
  // ADMIN-UPDATEPLAN-1 suite above, which already calls entitlementsService.invalidate(id)
  // unconditionally on every instant apply; this confirms that holds starting from LITE too.
  describe("updatePlan — R8.2 leaving LITE invalidates entitlements", () => {
    const periodStart = new Date("2026-09-01T00:00:00Z");
    const periodEnd = new Date("2026-10-01T00:00:00Z");

    it("REG-R8.2 updatePlan(liteTenant, {plan: STARTER}) calls entitlementsService.invalidate(id)", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme-lite",
        plan: "LITE",
        status: "ACTIVE",
      } as any);
      prisma.tenant.update.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme-lite",
        plan: "STARTER",
      } as any);
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-9",
        definitions: [
          { planKey: "LITE", monthlyPrice: 0 },
          { planKey: "STARTER", monthlyPrice: 99 },
        ],
      });
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        planKey: "LITE",
        basePriceSnapshot: 0,
        priceOverrideMonthly: null,
        discount: null,
        cycle: "MONTHLY",
        periodStart,
        periodEnd,
      });

      await service.updatePlan(TENANT_ID, { plan: "STARTER" } as any, ADMIN_ID);

      expect(entitlementsService.invalidate).toHaveBeenCalledWith(TENANT_ID);
    });
  });

  describe("getStats enrichment", () => {
    // Phase 0 T9: getStats() no longer re-derives MRR from the catalog price — it reads
    // MrrService.computeOverview() as the one MRR engine (already class-scoped to
    // PRODUCTION, see mrr.service.spec.ts). `estMrrUsd` stays as an alias of `mrr` until
    // Phase 0 T12 updates the dashboard to read the new fields directly.
    it("sources MRR from MrrService, not the legacy estimator", async () => {
      prisma.tenant.findMany.mockImplementation((args: any) => {
        if (args?.where?.status?.not === "CANCELLED") {
          return Promise.resolve([
            { status: "ACTIVE", plan: "STARTER", subscription: { planKey: "STARTER" } },
            { status: "ACTIVE", plan: "TEAM", subscription: null },
            // TRIAL: counted in planBreakdown, excluded from MRR.
            { status: "TRIAL", plan: "STARTER", subscription: null },
          ]);
        }
        return Promise.resolve([]);
      });
      mrrService.computeOverview.mockResolvedValue({
        mrr: 748,
        baseMrr: 748,
        addonMrr: 0,
        discountTotal: 0,
        payingTenants: 2,
        trialTenants: 1,
        readOnlyTenants: 0,
        byPlan: [],
        ledgerMrr: 748,
        momDelta: 0,
      });

      const stats = await service.getStats();

      expect(stats.mrr).toBe(748);
      expect(stats.ledgerMrr).toBe(748);
      // R28: getStats() no longer returns estMrrUsd at all — the dashboard reads mrr/ledgerMrr.
      expect(stats).not.toHaveProperty("estMrrUsd");
      expect(mrrService.computeOverview).toHaveBeenCalled();
      expect(stats.planBreakdown).toEqual({ STARTER: 2, GROWTH: 1 });
    });

    it("scopes every tenant-count query in getStats() by class: PRODUCTION", async () => {
      prisma.tenant.findMany.mockResolvedValue([]);

      await service.getStats();

      // tenant.count is called for total/active/trial/suspended/newThisMonth — every call
      // except the (tenantless) SUPER_ADMIN user count must carry class: "PRODUCTION".
      for (const call of (prisma.tenant.count as jest.Mock).mock.calls) {
        expect(call[0].where.class).toBe("PRODUCTION");
      }
      const planScanCall = (prisma.tenant.findMany as jest.Mock).mock.calls.find(
        (c: any[]) => c[0]?.where?.status?.not === "CANCELLED",
      );
      expect(planScanCall[0].where.class).toBe("PRODUCTION");
    });

    it("attaches userCount to trials and a human riskReason to at-risk tenants", async () => {
      prisma.tenant.findMany.mockImplementation((args: any) => {
        if (args?.where?.status === "TRIAL") {
          return Promise.resolve([
            {
              id: "t-trial",
              slug: "trial",
              name: "Trial Co",
              plan: "STARTER",
              trialEndsAt: new Date(),
              createdAt: new Date(),
              _count: { users: 4 },
            },
          ]);
        }
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "t-susp",
              slug: "susp",
              name: "Susp Co",
              status: "SUSPENDED",
              plan: "STARTER",
              trialEndsAt: null,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const stats = await service.getStats();
      expect(stats.trialsExpiringSoon[0].userCount).toBe(4);
      expect(stats.atRiskTenants[0].riskReason).toBe("Suspended");
    });
  });

  describe("getTenant — estMrrUsd card (REG-743-N1)", () => {
    // N1/L-119: the card must price through MrrService.priceTenant() — the SAME function
    // computeOverview() sums — never the retired catalog-fallback estimator
    // (_monthlyPriceUsd/_catalogPriceByPlanKey, deleted). A DEMO tenant or a snapshot-less
    // ACTIVE tenant must show $0 here, matching what they contribute to the dashboard total,
    // never a nonzero catalog-price guess.
    it("REG-743-N1 prices the card through MrrService.priceTenant, never the catalog", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        status: "ACTIVE",
        plan: "GROWTH",
        subscription: { planKey: "GROWTH", basePriceSnapshot: null },
      } as any);
      mrrService.priceTenant.mockResolvedValue(249);

      const tenant = await service.getTenant(TENANT_ID);

      expect(mrrService.priceTenant).toHaveBeenCalledWith(TENANT_ID);
      expect(tenant.estMrrUsd).toBe(249);
      // The catalog-fallback path must be completely gone — nothing here should ever
      // consult the published catalog for a single tenant's card again.
      expect(planCatalogService.getPublishedVersion).not.toHaveBeenCalled();
    });

    // Review finding: this proves getTenant() RELAYS priceTenant()'s answer faithfully
    // (no re-derivation, no override) — it does NOT itself exercise the DEMO/class gate,
    // which lives entirely inside priceTenant() and is proven non-vacuously in
    // mrr.service.spec.ts's own REG-743-N1 case (real DEMO/deleted/missing fixtures).
    // getTenant() no longer reads tenant.class or tenant.subscription.basePriceSnapshot
    // at all, so a fixture "shaped like" a DEMO tenant here would prove nothing beyond
    // what the first REG-743-N1 case above already does.
    it("REG-743-N1 relays whatever priceTenant() returns, without re-deriving or overriding it (e.g. a DEMO tenant priced $0)", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme-demo",
        status: "ACTIVE",
        plan: "GROWTH",
        subscription: { planKey: "GROWTH", basePriceSnapshot: null },
      } as any);
      mrrService.priceTenant.mockResolvedValue(0);

      const tenant = await service.getTenant(TENANT_ID);

      expect(tenant.estMrrUsd).toBe(0);
    });

    it("REG-743-N1 never falls back to the catalog even when priceTenant() answers $0", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme-pilot",
        status: "ACTIVE",
        plan: "SCALE",
        subscription: { planKey: "SCALE", basePriceSnapshot: null },
      } as any);
      mrrService.priceTenant.mockResolvedValue(0);
      // Even if the catalog WOULD price SCALE at something nonzero, the card must never
      // fall back to it — this spy having zero calls is itself part of the proof.
      planCatalogService.getPublishedVersion.mockResolvedValue({
        definitions: [{ planKey: "SCALE", monthlyPrice: 499 }],
      });

      const tenant = await service.getTenant(TENANT_ID);

      expect(tenant.estMrrUsd).toBe(0);
      expect(planCatalogService.getPublishedVersion).not.toHaveBeenCalled();
    });
  });

  // N4: neither figure had ANY class filter on head — a qa-*/e2e-*/routeflow-demo tenant's
  // subscription/trial/creation-month could move the conversion rate or growth chart the
  // admin dashboard renders next to MrrService's PRODUCTION-only revenue numbers.
  describe("getBillingOverview / getGrowthStats — PRODUCTION scope (REG-743-N4)", () => {
    it("REG-743-N4 getBillingOverview scopes every tenant query by class PRODUCTION", async () => {
      (prisma as any).tenantSubscription.findMany.mockResolvedValue([]);
      prisma.tenant.count.mockResolvedValue(0);

      await service.getBillingOverview();

      const subsArgs = (prisma as any).tenantSubscription.findMany.mock.calls[0][0];
      expect(subsArgs.where.tenant.class).toBe("PRODUCTION");
      for (const call of (prisma.tenant.count as jest.Mock).mock.calls) {
        expect(call[0].where.class).toBe("PRODUCTION");
      }
    });

    it("REG-743-N4 getGrowthStats scopes every monthly count by class PRODUCTION", async () => {
      prisma.tenant.count.mockResolvedValue(0);

      await service.getGrowthStats(2);

      expect((prisma.tenant.count as jest.Mock).mock.calls.length).toBeGreaterThan(0);
      for (const call of (prisma.tenant.count as jest.Mock).mock.calls) {
        expect(call[0].where.class).toBe("PRODUCTION");
      }
    });
  });

  describe("listTenants filters", () => {
    it("hides deleted by default, builds a search OR + explicit sort, returns deletedCount", async () => {
      prisma.tenant.findMany.mockResolvedValue([]);
      // count() is called twice: filtered total, then the global soft-deleted count.
      prisma.tenant.count.mockResolvedValueOnce(5).mockResolvedValueOnce(3);

      const result = await service.listTenants(1, 20, {
        search: "acme",
        status: "ACTIVE",
        plan: "STARTER",
        sortKey: "slug",
        sortDir: "asc",
      });

      const args = (prisma.tenant.findMany as jest.Mock).mock.calls.at(-1)![0];
      expect(args.where.deletedAt).toBeNull();
      expect(args.where.status).toBe("ACTIVE");
      expect(args.where.plan).toBe("STARTER");
      expect(args.where.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: { contains: "acme", mode: "insensitive" } }),
        ]),
      );
      expect(args.orderBy).toEqual({ slug: "asc" });
      expect(result.meta.total).toBe(5);
      expect(result.meta.deletedCount).toBe(3);
    });

    it("includes deleted (no deletedAt filter) when requested", async () => {
      prisma.tenant.findMany.mockResolvedValue([]);
      prisma.tenant.count.mockResolvedValue(0);
      await service.listTenants(1, 20, { includeDeleted: true });
      const args = (prisma.tenant.findMany as jest.Mock).mock.calls.at(-1)![0];
      expect(args.where.deletedAt).toBeUndefined();
    });
  });

  describe("getTenantEntitlements", () => {
    it("returns flags, addons, caps, and the resolved planKey from EntitlementsService plus meter usage from MeterService", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      entitlementsService.resolve.mockResolvedValue({
        tenantId: TENANT_ID,
        planKey: "GROWTH",
        flags: ["flag.returns", "flag.reports"],
        addons: ["BUYER_PORTAL"],
        caps: { seats: 10, routes: 3, scans: 100, msgs: 200 },
      });
      meterService.readAll.mockResolvedValue([
        { meter: "SEATS", used: 4, included: 10, remaining: 6, resetsAt: null },
      ]);

      const result = await service.getTenantEntitlements(TENANT_ID);

      expect(result).toEqual({
        planKey: "GROWTH",
        flags: ["flag.returns", "flag.reports"],
        addons: ["BUYER_PORTAL"],
        caps: { seats: 10, routes: 3, scans: 100, msgs: 200 },
        usage: [{ meter: "SEATS", used: 4, included: 10, remaining: 6, resetsAt: null }],
      });
      expect(entitlementsService.resolve).toHaveBeenCalledWith(TENANT_ID);
      expect(meterService.readAll).toHaveBeenCalledWith(TENANT_ID);
    });

    // Opus review of 8130b204, item 4: this admin-facing view must agree with the tenant's own
    // Overrides table.
    it("a GRANT override on a RequirePlanFlag key adds it to flags", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      entitlementsService.resolve.mockResolvedValue({
        tenantId: TENANT_ID,
        planKey: "STARTER",
        flags: [],
        addons: [],
        caps: { seats: 1, routes: 1, scans: 20, msgs: 200 },
      });
      meterService.readAll.mockResolvedValue([]);
      featureOverrides.allActive.mockResolvedValue(new Map([["flag.msrp", "GRANT"]]));

      const result = await service.getTenantEntitlements(TENANT_ID);
      expect(result.flags).toContain("flag.msrp");
    });

    it("a DENY override on a RequirePlanFlag key removes it from flags", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      entitlementsService.resolve.mockResolvedValue({
        tenantId: TENANT_ID,
        planKey: "ENTERPRISE",
        flags: ["flag.msrp"],
        addons: [],
        caps: { seats: null, routes: null, scans: null, msgs: 200 },
      });
      meterService.readAll.mockResolvedValue([]);
      featureOverrides.allActive.mockResolvedValue(new Map([["flag.msrp", "DENY"]]));

      const result = await service.getTenantEntitlements(TENANT_ID);
      expect(result.flags).not.toContain("flag.msrp");
    });

    it("an addon-keyed override never touches the SKU-shaped addons array", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      entitlementsService.resolve.mockResolvedValue({
        tenantId: TENANT_ID,
        planKey: "GROWTH",
        flags: [],
        addons: ["BUYER_PORTAL"],
        caps: { seats: 10, routes: 3, scans: 100, msgs: 200 },
      });
      meterService.readAll.mockResolvedValue([]);
      // "tobacco_dealer" is a registry addon KEY, not a SKU code — must not leak in here.
      featureOverrides.allActive.mockResolvedValue(new Map([["tobacco_dealer", "GRANT"]]));

      const result = await service.getTenantEntitlements(TENANT_ID);
      expect(result.addons).toEqual(["BUYER_PORTAL"]);
    });

    it("404s for a tenant that doesn't exist, without calling the entitlements/meter services", async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);

      await expect(service.getTenantEntitlements("nope")).rejects.toThrow("Tenant nope not found");
      expect(entitlementsService.resolve).not.toHaveBeenCalled();
      expect(meterService.readAll).not.toHaveBeenCalled();
    });
  });

  // B125 — createTenantAdmin used to auto-create a Driver row for the new admin
  // (canActAsDriver: true + an unconditional tx.driver.create), so deleting that
  // driver profile hit User's restrict-FKs and silently rolled back the whole
  // transaction ("deleted admin drivers kept coming back"). Fixed in #491
  // (28cb0a25): canActAsDriver starts false and no Driver row is created — the
  // capability stays an explicit opt-in via Settings -> Act as driver.
  describe("createTenantAdmin — no auto-created driver profile (B125)", () => {
    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        name: "Acme",
      } as any);
      prisma.user.findFirst.mockResolvedValue(null); // no existing admin, no username/email collision
      prisma.user.create.mockResolvedValue({
        id: "admin-new",
        username: "newadmin",
        email: "newadmin@example.com",
        status: "ACTIVE",
        createdAt: new Date(),
      } as any);
    });

    it("REG-B125 creates the admin with canActAsDriver: false and never creates a Driver row", async () => {
      await service.createTenantAdmin(
        TENANT_ID,
        { username: "newadmin", email: "newadmin@example.com", password: "S3cret!!" },
        ADMIN_ID,
      );

      // RED against the pre-fix handler, which passed canActAsDriver: true and then
      // unconditionally called tx.driver.create for the new admin.
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: "TENANT_ADMIN", canActAsDriver: false }),
        }),
      );
      expect((prisma as any).driver.create).not.toHaveBeenCalled();
    });
  });

  // Phase 0 Task 10: the admin Create Tenant path used to hardcode a 7-day trial
  // independent of TRIAL_LENGTH_DAYS (public self-signup's constant); it now defaults to
  // that shared constant and accepts an explicit override.
  describe("createTenant — trial length", () => {
    const validCreateDto = {
      slug: "acme-wholesale",
      businessName: "Acme Wholesale",
      adminEmail: "owner@acme.example.com",
      adminUsername: "acme_owner",
    } as any;

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue(null); // slug not taken
      prisma.user.findFirst.mockResolvedValue(null); // no existing admin collision
      prisma.tenant.create.mockImplementation((args: any) =>
        Promise.resolve({ id: TENANT_ID, ...args.data }),
      );
      prisma.user.create.mockResolvedValue({ id: "admin-1" } as any);
      // WP3b/R1.8: createTenant() now refuses to create a tenant on a plan absent from the
      // published catalog — these pre-existing cases create on the (implicit) STARTER plan, so
      // the published version must carry a STARTER definition for them to keep passing.
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-1",
        definitions: [{ planKey: "STARTER" }],
      } as any);
    });

    it("defaults trial length to TRIAL_LENGTH_DAYS when no override is given", async () => {
      const result = await service.createTenant(validCreateDto);

      const expectedMs = 14 * 24 * 60 * 60 * 1000; // TRIAL_LENGTH_DAYS
      const actualMs = (result.trialEndsAt as Date).getTime() - Date.now();
      expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5000);
    });

    it("honors an explicit trialLengthDays override", async () => {
      const result = await service.createTenant({ ...validCreateDto, trialLengthDays: 30 });

      const expectedMs = 30 * 24 * 60 * 60 * 1000;
      const actualMs = (result.trialEndsAt as Date).getTime() - Date.now();
      expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5000);
    });
  });

  // F7 (Phase 0 fix round, REG-743-F7): `Tenant.class` defaults to PRODUCTION at the schema
  // level (tenancy.prisma:87) and createTenant() never set it explicitly, so every new tenant
  // fail-opened onto PRODUCTION regardless of its slug. createTenant must now resolve a class
  // from `dto.class ?? classifyTenantSlug(slug)`, write it explicitly on tx.tenant.create, and
  // reject a caller-supplied class of PRODUCTION when the slug's own classifier disagrees
  // (fail closed on contradiction) rather than silently trusting the caller.
  describe("createTenant — explicit tenant class (F7)", () => {
    const baseDto = {
      businessName: "Acme Wholesale",
      adminEmail: "owner@acme.example.com",
      adminUsername: "acme_owner",
    } as any;

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue(null); // slug not taken
      prisma.user.findFirst.mockResolvedValue(null); // no existing admin collision
      prisma.tenant.create.mockImplementation((args: any) =>
        Promise.resolve({ id: TENANT_ID, ...args.data }),
      );
      prisma.user.create.mockResolvedValue({ id: "admin-1" } as any);
      // WP3b/R1.8: see the "createTenant — trial length" describe block above — these cases
      // create on the (implicit) STARTER plan and now require a published catalog row for it.
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-1",
        definitions: [{ planKey: "STARTER" }],
      } as any);
    });

    it("REG-743-F7 createTenant writes class TEST for a qa-* slug", async () => {
      await service.createTenant({ ...baseDto, slug: "qa-smoke-1" });

      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ class: "TEST" }) }),
      );
    });

    it("REG-743-F7 createTenant writes class PRODUCTION for an ordinary slug", async () => {
      await service.createTenant({ ...baseDto, slug: "acme-wholesale" });

      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ class: "PRODUCTION" }) }),
      );
    });

    it("REG-743-F7 rejects class PRODUCTION on an e2e-* slug", async () => {
      await expect(
        service.createTenant({ ...baseDto, slug: "e2e-smoke-1", class: "PRODUCTION" } as any),
      ).rejects.toThrow(/production/i);

      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });
  });

  // WP3b (lite-L2, R1.8/R2.4/R2.5/R2.7): platform-admin createTenant() gains an invite-only
  // LITE path — refuse creating a tenant on a plan absent from the published catalog (never the
  // silent STARTER fallback other call sites use), give a LITE tenant its 0-day
  // INVITE_ONLY_PLAN_TRIAL_DAYS trial (vs. the ordinary TRIAL_LENGTH_DAYS default), swap the
  // welcome email's trial copy for a "complete payment to activate" variant when that trial is
  // 0 days, and still offer a self-serve checkout link (INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT
  // defaults true) with settings/billing success/cancel URLs.
  describe("createTenant — LITE plan (WP3b)", () => {
    const baseDto = {
      slug: "acme-lite",
      businessName: "Acme Lite Co",
      adminEmail: "owner@acme-lite.example.com",
      adminUsername: "acme_lite_owner",
    } as any;

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue(null); // slug not taken
      prisma.user.findFirst.mockResolvedValue(null); // no existing admin collision
      prisma.tenant.create.mockImplementation((args: any) =>
        Promise.resolve({ id: TENANT_ID, ...args.data }),
      );
      prisma.user.create.mockResolvedValue({ id: "admin-1" } as any);
    });

    it("REG-R1.8 refuses to create a LITE tenant when LITE is not in the published catalog", async () => {
      // Published catalog exists but carries no LITE row — e.g. only pre-Lite plans.
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-1",
        definitions: [{ planKey: "STARTER" }],
      } as any);

      await expect(service.createTenant({ ...baseDto, plan: "LITE" } as any)).rejects.toThrow(
        /published plan catalog/i,
      );

      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it("REG-R1.8 refuses to create a LITE tenant when no catalog is published at all", async () => {
      planCatalogService.getPublishedVersion.mockResolvedValue(null);

      await expect(service.createTenant({ ...baseDto, plan: "LITE" } as any)).rejects.toThrow(
        /published plan catalog/i,
      );

      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it("REG-R2.4/R2.5/R2.7 a published LITE tenant gets the 0-day trial, the 'complete payment to activate' email variant, and a checkout link", async () => {
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-1",
        definitions: [{ planKey: "LITE" }, { planKey: "STARTER" }],
      } as any);
      (billingServiceMock.createCheckoutSession as jest.Mock).mockResolvedValue({
        checkoutUrl: "https://checkout.stripe.com/session-lite",
        sessionId: "sess-lite",
      });

      const result = await service.createTenant({ ...baseDto, plan: "LITE" } as any);

      // R2.4: 0-day trial (INVITE_ONLY_PLAN_TRIAL_DAYS), not the ordinary 14-day default.
      const actualMs = (result.trialEndsAt as Date).getTime() - Date.now();
      expect(Math.abs(actualMs)).toBeLessThan(5000);

      // R2.7: self-serve checkout is offered (lever defaults true) with the settings/billing
      // success/cancel URLs, not the bare tenant-id-only call other plans use.
      expect(billingServiceMock.createCheckoutSession).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({
          successUrl: expect.stringMatching(/\/settings\/billing\?checkout=success$/),
          cancelUrl: expect.stringMatching(/\/settings\/billing\?checkout=cancelled$/),
        }),
      );
      expect(result.checkoutUrl).toBe("https://checkout.stripe.com/session-lite");

      // R2.5: the email's trial copy switches to the "complete payment to activate" variant
      // (0 days is meaningless as a countdown) instead of "trial expires in 0 days".
      const emailCall = (emailServiceMock.send as jest.Mock).mock.calls[0][0];
      expect(emailCall.html).toContain("Complete payment to activate your account.");
      expect(emailCall.html).not.toMatch(/trial expires in/i);
    });
  });

  describe("activateManualSubscription — published catalog validation (finding 2)", () => {
    const activateDto = {
      plan: "LITE",
      billingPeriodDays: 30,
      paymentMethod: "BANK_TRANSFER",
    } as any;

    it("REG-2 refuses to activate LITE when LITE is not in the published catalog", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-1",
        definitions: [{ planKey: "STARTER" }],
      } as any);

      await expect(
        service.activateManualSubscription(TENANT_ID, activateDto, ADMIN_ID),
      ).rejects.toThrow(/published plan catalog/i);

      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
    });

    it("REG-2 activating LITE on a catalog that has it writes planKey + planVersionId into the upsert", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      prisma.tenant.update.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        status: "ACTIVE",
        plan: "LITE",
      } as any);
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-12",
        definitions: [{ planKey: "LITE", monthlyPrice: 99, isCustom: false }],
      } as any);

      await service.activateManualSubscription(TENANT_ID, activateDto, ADMIN_ID);

      const upsertArg = (prisma as any).tenantSubscription.upsert.mock.calls[0][0];
      expect(upsertArg.create).toMatchObject({ planKey: "LITE", planVersionId: "v-12" });
      expect(upsertArg.update).toMatchObject({ planKey: "LITE", planVersionId: "v-12" });
    });
  });

  // R18: both admin write paths mirror the tenant into the house tenant's CRM, best-effort —
  // a mirror failure must never fail the admin action (T13-10, T13-11).
  describe("tenant mirror call sites (R18)", () => {
    it("T13-10 createTenant() mirrors the new tenant once and survives a rejecting upsert", async () => {
      prisma.tenant.findUnique.mockResolvedValue(null); // slug not taken
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.tenant.create.mockImplementation((args: any) =>
        Promise.resolve({ id: TENANT_ID, ...args.data }),
      );
      prisma.user.create.mockResolvedValue({ id: "admin-1" } as any);
      tenantMirror.upsert.mockRejectedValue(new Error("no house tenant configured"));
      // Merge note (feat/lite-plan × master): R1.8's catalog guard didn't exist on master when
      // this test was written — createTenant() now validates the (default STARTER) plan against
      // the published catalog before anything else, so this needs a satisfying mock too.
      planCatalogService.getPublishedVersion.mockResolvedValue({
        id: "v-1",
        definitions: [{ planKey: "STARTER" }],
      } as any);

      const result = await service.createTenant({
        slug: "acme-wholesale",
        businessName: "Acme Wholesale",
        adminEmail: "owner@acme.example.com",
        adminUsername: "acme_owner",
      } as any);

      expect(result.id).toBe(TENANT_ID);
      expect(tenantMirror.upsert).toHaveBeenCalledTimes(1);
      expect(tenantMirror.upsert).toHaveBeenCalledWith(TENANT_ID);
    });

    it("T13-11 updateTenantConfig() mirrors the tenant once and survives a rejecting upsert", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        status: "ACTIVE",
        plan: "STARTER",
        subscription: null,
      } as any);
      tenantMirror.upsert.mockRejectedValue(new Error("no house tenant configured"));

      const tenant = await service.updateTenantConfig(
        TENANT_ID,
        { businessName: "Acme Wholesale" } as any,
        ADMIN_ID,
      );

      expect(tenant.id).toBe(TENANT_ID);
      expect(tenantMirror.upsert).toHaveBeenCalledTimes(1);
      expect(tenantMirror.upsert).toHaveBeenCalledWith(TENANT_ID);
    });
  });

  describe("updateTenantClass", () => {
    it("updates the class, writes an audit row, and emits a BillingEvent when leaving PRODUCTION", async () => {
      prisma.tenant.findUniqueOrThrow.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        class: "PRODUCTION",
      } as any);
      prisma.tenant.update.mockResolvedValue({ id: TENANT_ID, slug: "acme", class: "TEST" } as any);

      await service.updateTenantClass(
        TENANT_ID,
        { class: "TEST", reason: "reclassified as QA" } as any,
        ADMIN_ID,
      );

      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: TENANT_ID },
        data: { class: "TEST" },
        select: { id: true, slug: true, class: true },
      });
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          userId: ADMIN_ID,
          action: AdminAuditAction.TENANT_CLASS_CHANGED,
        }),
      );
      expect(billingEventService.emit).toHaveBeenCalledWith(
        TENANT_ID,
        "tenant.class_changed",
        expect.objectContaining({ from: "PRODUCTION", to: "TEST", reason: "reclassified as QA" }),
        expect.objectContaining({ actorId: ADMIN_ID }),
      );
    });

    it("does not emit a BillingEvent when moving between two non-PRODUCTION classes", async () => {
      prisma.tenant.findUniqueOrThrow.mockResolvedValue({
        id: TENANT_ID,
        slug: "qa-1",
        class: "TEST",
      } as any);
      prisma.tenant.update.mockResolvedValue({ id: TENANT_ID, slug: "qa-1", class: "DEMO" } as any);

      await service.updateTenantClass(
        TENANT_ID,
        { class: "DEMO", reason: "repurposed for sales demo" } as any,
        ADMIN_ID,
      );

      expect(billingEventService.emit).not.toHaveBeenCalled();
    });

    it("rejects and leaves nothing else applied when the BillingEvent emit throws", async () => {
      // The tenant update and the emit run inside one this.prisma.$transaction(async (tx) =>
      // ...) — an emit failure must reject the whole call so a class flip that crosses the
      // PRODUCTION boundary never lands without its BillingEvent. This mock's $transaction
      // (beforeEach) just invokes the callback directly against a shared `tx`, so real
      // Postgres rollback isn't exercised here — what IS provable at this layer is that the
      // rejection propagates out of updateTenantClass and that recordAdminAction (which runs
      // only AFTER the transaction settles) never fires, i.e. nothing after the throw executes.
      prisma.tenant.findUniqueOrThrow.mockResolvedValue({
        id: TENANT_ID,
        slug: "acme",
        class: "PRODUCTION",
      } as any);
      prisma.tenant.update.mockResolvedValue({ id: TENANT_ID, slug: "acme", class: "TEST" } as any);
      billingEventService.emit.mockRejectedValue(new Error("billing event emit failed"));

      await expect(
        service.updateTenantClass(
          TENANT_ID,
          { class: "TEST", reason: "reclassified as QA" } as any,
          ADMIN_ID,
        ),
      ).rejects.toThrow("billing event emit failed");

      expect(auditLog).not.toHaveBeenCalled();
    });
  });
});
