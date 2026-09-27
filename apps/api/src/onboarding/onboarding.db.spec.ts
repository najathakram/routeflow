/**
 * Real-Postgres pins for the onboarding tracker (#2159 S1, plan §8 S1).
 *
 * Runs only in the DB lane (`npm run local:test:db`, jest.db.config.js). Proves, against a
 * migrated database:
 *   - a new case materialises EVERY catalog step at CATALOG_VERSION, all PENDING;
 *   - advance is refused (409 + the exact blocker list) until the stage's REQUIRED steps
 *     are DONE or WAIVED, then moves exactly one stage; HYPERCARE → LIVE; a LIVE case is read-only;
 *   - waive refuses a blank reason with nothing written, and records reason + actor + time;
 *   - a step in a stage not yet reached is refused; reopen never crosses a passed gate;
 *   - "adopt catalog" only ADDS missing keys and never touches a DONE row;
 *   - auto-checks read ONLY the case's own tenant (two-tenant fixture);
 *   - a demo booking opens at most one case, and the bookings list links to it.
 *
 * SAFETY: tenants are throwaway `qa-onb-*` slugs (assertTestTenant); platform rows carry a
 * `db-spec-onb-<run>` marker and `afterAll` deletes exactly what this file created.
 */
import { randomUUID } from "crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { OnboardingService } from "./onboarding.service";
import { CATALOG_VERSION, STAGE_ORDER, STEPS } from "./onboarding-catalog";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const ADMIN = `db-spec-onb-admin-${RUN}`;
let seq = 0;

describeDb("onboarding cases (#2159 S1) — real Postgres", () => {
  let prisma: PrismaService;
  let svc: OnboardingService;
  const caseIds: string[] = [];
  const tenantIds: string[] = [];
  const bookingIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    const tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    svc = new OnboardingService(prisma, new AuditService(prisma), tenantCtx);
  });

  afterAll(async () => {
    try {
      await prisma.onboardingCase.deleteMany({ where: { id: { in: caseIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: ADMIN } });
      await prisma.demoBooking.deleteMany({ where: { id: { in: bookingIds } } });
      for (const tenantId of tenantIds) {
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.customerAddress.deleteMany({ where: { tenantId } });
        await prisma.customer.deleteMany({ where: { tenantId } });
        await prisma.driver.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      }
    } finally {
      await prisma?.$disconnect();
    }
  });

  async function newCase(extra: Record<string, unknown> = {}) {
    seq += 1;
    const c = await svc.create(
      {
        companyName: `Acme Wholesale ${RUN}-${seq}`,
        contactName: "Pat Example",
        contactEmail: `pat-${RUN}-${seq}@example.invalid`,
        ...extra,
      },
      ADMIN,
    );
    caseIds.push(c.id);
    return c;
  }

  async function newTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-onb-${RUN}-${seq}-${label}`, "onboarding.db.spec.ts");
    const t = await prisma.tenant.create({ data: { slug, name: `Onb ${slug}` } });
    tenantIds.push(t.id);
    return t;
  }

  /** Complete every REQUIRED step of the case's current stage. */
  async function clearStage(id: string) {
    const c = await svc.get(id);
    for (const s of c.steps.filter(
      (x) => x.stage === c.stage && x.required && x.status === "PENDING",
    )) {
      await svc.completeStep(id, s.key, { note: "db-spec" }, ADMIN);
    }
  }

  async function expectConflict(p: Promise<unknown>, code: string) {
    const err = await p.then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code });
    return (err as ConflictException).getResponse() as Record<string, unknown>;
  }

  it("materialises every catalog step at CATALOG_VERSION, all PENDING, and logs the creation", async () => {
    const c = await newCase();
    expect(c.catalogVersion).toBe(CATALOG_VERSION);
    expect(c.stage).toBe("FOLLOW_UP");
    expect(c.status).toBe("OPEN");
    expect(c.steps.map((s) => s.key).sort()).toEqual(STEPS.map((s) => s.key).sort());
    expect(c.steps.every((s) => s.status === "PENDING")).toBe(true);
    expect(c.events.map((e) => e.type)).toEqual(["case.created"]);
    const audit = await prisma.auditLog.findMany({
      where: { userId: ADMIN, action: "ONBOARDING_CASE_CREATED" },
    });
    expect(audit.some((a) => (a.meta as Record<string, unknown>).caseId === c.id)).toBe(true);
  });

  it("refuses advance with the exact blocker list, then advances ONE stage once the required steps clear", async () => {
    const c = await newCase();
    const required = STEPS.filter((s) => s.stage === "FOLLOW_UP" && s.required).map((s) => s.key);
    const body = await expectConflict(svc.advance(c.id, ADMIN), "ONBOARDING_GATE_BLOCKED");
    expect((body.blockers as { key: string }[]).map((b) => b.key).sort()).toEqual(
      [...required].sort(),
    );
    expect((await svc.get(c.id)).stage).toBe("FOLLOW_UP");

    // Complete all but one required step — still refused, and the list shrinks to that one.
    for (const key of required.slice(1)) await svc.completeStep(c.id, key, undefined, ADMIN);
    const body2 = await expectConflict(svc.advance(c.id, ADMIN), "ONBOARDING_GATE_BLOCKED");
    expect((body2.blockers as { key: string }[]).map((b) => b.key)).toEqual([required[0]]);

    // Waiving the last one clears the gate; the optional step never blocked.
    await svc.waiveStep(c.id, required[0], "Owner agreed by phone", ADMIN);
    const after = await svc.advance(c.id, ADMIN);
    expect(after.stage).toBe("AGREE");
    expect(after.steps.find((s) => s.key === "followup.routesAddon")!.status).toBe("PENDING");
    expect(after.events[0]).toMatchObject({
      type: "stage.advanced",
      payload: { from: "FOLLOW_UP", to: "AGREE" },
    });
  });

  it("waive refuses a blank reason with nothing written, and records reason, actor and time", async () => {
    const c = await newCase();
    await expect(svc.waiveStep(c.id, "followup.recapSent", "   ", ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const untouched = await prisma.onboardingStep.findFirstOrThrow({
      where: { caseId: c.id, key: "followup.recapSent" },
    });
    expect(untouched).toMatchObject({
      status: "PENDING",
      waivedReason: null,
      waivedById: null,
      waivedAt: null,
    });

    const d = await svc.waiveStep(c.id, "followup.recapSent", "Recap given in person", ADMIN);
    const s = d.steps.find((x) => x.key === "followup.recapSent")!;
    expect(s).toMatchObject({
      status: "WAIVED",
      waivedReason: "Recap given in person",
      waivedById: ADMIN,
    });
    expect(s.waivedAt).not.toBeNull();
    const audit = await prisma.auditLog.findMany({
      where: { userId: ADMIN, action: "ONBOARDING_STEP_WAIVED" },
    });
    expect(audit.some((a) => (a.meta as Record<string, unknown>).caseId === c.id)).toBe(true);
    // A waived step can't be completed without a reopen.
    await expectConflict(
      svc.completeStep(c.id, "followup.recapSent", undefined, ADMIN),
      "ONBOARDING_STEP_WAIVED",
    );
  });

  it("refuses a step in a stage not yet reached, and never reopens behind a passed gate", async () => {
    const c = await newCase();
    await expectConflict(
      svc.completeStep(c.id, "activate.paid", undefined, ADMIN),
      "ONBOARDING_STEP_NOT_REACHED",
    );
    await expectConflict(
      svc.waiveStep(c.id, "activate.paid", "skip it", ADMIN),
      "ONBOARDING_STEP_NOT_REACHED",
    );
    await clearStage(c.id);
    await svc.advance(c.id, ADMIN);
    await expectConflict(
      svc.reopenStep(c.id, "followup.fitNotes", ADMIN),
      "ONBOARDING_STEP_BEHIND_GATE",
    );
    // Inside the current stage, reopen puts the step back to PENDING and clears who/when.
    await svc.completeStep(c.id, "agree.summarySent", undefined, ADMIN);
    const r = await svc.reopenStep(c.id, "agree.summarySent", ADMIN);
    expect(r.steps.find((s) => s.key === "agree.summarySent")).toMatchObject({
      status: "PENDING",
      doneById: null,
      doneAt: null,
    });
  });

  it("an ON_HOLD case cannot advance or change steps; reopening it restores both", async () => {
    const c = await newCase();
    await clearStage(c.id);
    await svc.update(c.id, { status: "ON_HOLD" }, ADMIN);
    await expectConflict(svc.advance(c.id, ADMIN), "ONBOARDING_CASE_NOT_OPEN");
    await expectConflict(
      svc.completeStep(c.id, "followup.routesAddon", undefined, ADMIN),
      "ONBOARDING_CASE_NOT_OPEN",
    );
    await svc.update(c.id, { status: "OPEN" }, ADMIN);
    expect((await svc.advance(c.id, ADMIN)).stage).toBe("AGREE");
  });

  it("walks every stage strictly in order to LIVE, after which the case is read-only", async () => {
    const c = await newCase();
    const seen: string[] = [];
    for (let i = 0; i < STAGE_ORDER.length; i += 1) {
      const before = await svc.get(c.id);
      seen.push(before.stage);
      await clearStage(c.id);
      await svc.advance(c.id, ADMIN);
    }
    expect(seen).toEqual([...STAGE_ORDER]);
    const live = await svc.get(c.id);
    expect(live.status).toBe("LIVE");
    expect(live.closedAt).not.toBeNull();
    expect(live.blockers).toEqual([]);
    await expectConflict(svc.advance(c.id, ADMIN), "ONBOARDING_CASE_NOT_OPEN");
    await expectConflict(
      svc.update(c.id, { companyName: "Renamed" }, ADMIN),
      "ONBOARDING_CASE_CLOSED",
    );
  });

  it("LOST needs a reason and closes the case", async () => {
    const c = await newCase();
    await expect(svc.update(c.id, { status: "LOST" }, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const lost = await svc.update(
      c.id,
      { status: "LOST", lostReason: "Chose another vendor" },
      ADMIN,
    );
    expect(lost).toMatchObject({ status: "LOST", lostReason: "Chose another vendor" });
    expect(lost.closedAt).not.toBeNull();
  });

  it("adopt catalog only ADDS missing keys and never touches a DONE row", async () => {
    const c = await newCase();
    await svc.completeStep(c.id, "followup.fitNotes", { note: "kept" }, ADMIN);
    // Simulate a case materialised from an older catalog that lacked a key.
    await prisma.onboardingStep.deleteMany({ where: { caseId: c.id, key: "hypercare.hours" } });
    await prisma.onboardingCase.update({ where: { id: c.id }, data: { catalogVersion: 0 } });
    const doneBefore = await prisma.onboardingStep.findFirstOrThrow({
      where: { caseId: c.id, key: "followup.fitNotes" },
    });

    const a = await svc.adoptCatalog(c.id, ADMIN);
    expect(a.catalogVersion).toBe(CATALOG_VERSION);
    expect(a.steps).toHaveLength(STEPS.length);
    expect(a.steps.find((s) => s.key === "hypercare.hours")!.status).toBe("PENDING");
    const doneAfter = await prisma.onboardingStep.findFirstOrThrow({
      where: { caseId: c.id, key: "followup.fitNotes" },
    });
    expect(doneAfter).toEqual(doneBefore);
    expect(a.events[0]).toMatchObject({
      type: "catalog.adopted",
      payload: { added: ["hypercare.hours"] },
    });
  });

  it("auto-checks read ONLY the case's own tenant (two-tenant fixture)", async () => {
    const dirty = await newTenant("dirty");
    const clean = await newTenant("clean");
    // Dirty tenant: an unpriced product, a case-variant duplicate SKU, an exempt customer
    // without a certificate, an unplaced customer, and a driver who never signed in.
    await prisma.product.createMany({
      data: [
        {
          tenantId: dirty.id,
          name: "Unpriced",
          unit: "each",
          sku: `SKU-${RUN}`,
          pricePerUnit: 0,
          unitsPerBox: 12,
        },
        {
          tenantId: dirty.id,
          name: "Dup",
          unit: "each",
          sku: `sku-${RUN}`,
          pricePerUnit: 5,
          unitsPerBox: 12,
        },
      ],
    });
    const dirtyUser = await prisma.user.create({
      data: {
        tenantId: dirty.id,
        email: `c@${dirty.slug}.invalid`,
        username: `c-${dirty.slug}`,
        role: "CUSTOMER",
      },
    });
    await prisma.customer.create({
      data: {
        tenantId: dirty.id,
        userId: dirtyUser.id,
        businessName: "Exempt Co",
        contactName: "X",
        isTaxExempt: true,
      },
    });
    const dirtyDriverUser = await prisma.user.create({
      data: {
        tenantId: dirty.id,
        email: `d@${dirty.slug}.invalid`,
        username: `d-${dirty.slug}`,
        role: "DRIVER",
      },
    });
    await prisma.driver.create({
      data: { tenantId: dirty.id, userId: dirtyDriverUser.id, contactName: "Driver D" },
    });

    // Clean tenant: one priced product, one placed customer, one signed-in driver + admin.
    await prisma.product.create({
      data: {
        tenantId: clean.id,
        name: "Priced",
        unit: "each",
        sku: `OK-${RUN}`,
        pricePerUnit: 4,
        unitsPerBox: 6,
      },
    });
    const cleanUser = await prisma.user.create({
      data: {
        tenantId: clean.id,
        email: `c@${clean.slug}.invalid`,
        username: `c-${clean.slug}`,
        role: "CUSTOMER",
      },
    });
    const cust = await prisma.customer.create({
      data: {
        tenantId: clean.id,
        userId: cleanUser.id,
        businessName: "Placed Co",
        contactName: "Y",
      },
    });
    await prisma.customerAddress.create({
      data: {
        tenantId: clean.id,
        customerId: cust.id,
        line1: "1 Main St",
        city: "Austin",
        state: "TX",
        zip: "78701",
        lat: 30.1,
        lng: -97.7,
      },
    });
    const cleanDriverUser = await prisma.user.create({
      data: {
        tenantId: clean.id,
        email: `d@${clean.slug}.invalid`,
        username: `d-${clean.slug}`,
        role: "DRIVER",
        lastLoginAt: new Date(),
      },
    });
    await prisma.driver.create({
      data: { tenantId: clean.id, userId: cleanDriverUser.id, contactName: "Driver C" },
    });
    await prisma.user.create({
      data: {
        tenantId: clean.id,
        email: `a@${clean.slug}.invalid`,
        username: `a-${clean.slug}`,
        role: "TENANT_ADMIN",
        lastLoginAt: new Date(),
      },
    });

    const cClean = await newCase();
    const cDirty = await newCase();
    await prisma.onboardingCase.update({ where: { id: cClean.id }, data: { tenantId: clean.id } });
    await prisma.onboardingCase.update({ where: { id: cDirty.id }, data: { tenantId: dirty.id } });

    const byKey = (d: Awaited<ReturnType<OnboardingService["get"]>>) =>
      Object.fromEntries(
        d.steps.filter((s) => s.autoCheck).map((s) => [s.autoCheck, s.autoResult]),
      );

    const rc = byKey(await svc.runAutoChecks(cClean.id, ADMIN));
    expect(rc["catalog.productsPriced"]).toMatchObject({ ok: true });
    expect(rc["catalog.skuUnique"]).toMatchObject({ ok: true });
    expect(rc["customers.exemptCertificates"]).toMatchObject({ ok: true });
    expect(rc["customers.geocoded"]).toMatchObject({ ok: true });
    expect(rc["drivers.signedIn"]).toMatchObject({ ok: true, detail: "All 1 driver signed in" });
    expect(rc["admin.signedIn"]).toMatchObject({ ok: true });
    expect(rc["workspace.created"]).toMatchObject({ ok: true, detail: `Workspace ${clean.slug}` });
    expect(rc["numbering.set"]).toMatchObject({ ok: false });
    expect(rc["numbering.set"]!.detail).toContain("B861");

    const rd = byKey(await svc.runAutoChecks(cDirty.id, ADMIN));
    expect(rd["catalog.productsPriced"]).toMatchObject({
      ok: false,
      detail: "1 product without a price",
    });
    expect(rd["catalog.skuUnique"]).toMatchObject({
      ok: false,
      detail: "1 SKU used by more than one product",
    });
    expect(rd["customers.exemptCertificates"]).toMatchObject({ ok: false });
    expect(rd["customers.geocoded"]).toMatchObject({
      ok: false,
      detail: "1 customer without a map position",
    });
    expect(rd["drivers.signedIn"]).toMatchObject({ ok: false, detail: "0 of 1 driver signed in" });
    expect(rd["admin.signedIn"]).toMatchObject({ ok: false });

    // Auto-check results are advisory: no step changed status.
    const after = await svc.get(cDirty.id);
    expect(after.steps.every((s) => s.status === "PENDING")).toBe(true);
  });

  it("a case with no workspace runs no checks and writes nothing", async () => {
    const c = await newCase();
    const r = await svc.runAutoChecks(c.id, ADMIN);
    expect(r.steps.every((s) => s.autoResult === null)).toBe(true);
  });

  it("opens at most one case per demo booking, prefilled from it, and the bookings list links back", async () => {
    const b = await prisma.demoBooking.create({
      data: {
        name: "Sam Prospect",
        email: `sam-${RUN}@example.invalid`,
        company: `Prospect Foods ${RUN}`,
        startsAt: new Date("2030-01-02T15:00:00Z"),
        endsAt: new Date("2030-01-02T15:30:00Z"),
        timeZone: "America/Chicago",
        manageTokenHash: `db-spec-onb-${RUN}`,
      },
    });
    bookingIds.push(b.id);
    const c = await svc.create({ demoBookingId: b.id }, ADMIN);
    caseIds.push(c.id);
    expect(c).toMatchObject({
      companyName: `Prospect Foods ${RUN}`,
      contactName: "Sam Prospect",
      contactEmail: `sam-${RUN}@example.invalid`,
      demoBookingId: b.id,
    });
    await expectConflict(svc.create({ demoBookingId: b.id }, ADMIN), "ONBOARDING_BOOKING_HAS_CASE");
    const list = await svc.listDemoBookings({
      from: "2030-01-01T00:00:00Z",
      to: "2030-01-03T00:00:00Z",
    });
    expect(list.find((x) => x.id === b.id)).toMatchObject({ onboardingCaseId: c.id });
  });
});
