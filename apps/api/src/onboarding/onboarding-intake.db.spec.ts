/**
 * Real-Postgres pins for the onboarding intake link (#2159 S2, plan §8 S2).
 *
 * Real: Prisma/Postgres, the token lifecycle, section state, the append-only acceptance trigger.
 * Faked at the module boundary: email (records sends), storage (in-memory), and the catalog pricer
 * (ProrationService/PlanCatalogService — a published catalog is global reference data this DB lane
 * doesn't seed, and the pin needs to CHANGE a price mid-test).
 *
 * SAFETY: no tenant is touched; every case this file creates is deleted in afterAll.
 */
import { randomUUID } from "crypto";
import { NotFoundException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { mintSignedToken } from "../common/signed-token";
import { OnboardingService } from "./onboarding.service";
import {
  LINK_NOT_FOUND,
  OnboardingIntakeService,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from "./onboarding-intake.service";

const RUN = randomUUID().slice(0, 8);
const ADMIN = `db-spec-intake-admin-${RUN}`;
const SECRET = "db-spec-onboarding-token-secret-0123456789";

const ACCOUNT = {
  legalName: "Acme Wholesale LLC",
  slug: `acme-${RUN}`,
  ownerName: "Pat Owner",
  adminName: "Pat Owner",
  adminEmail: "pat@example.invalid",
  addressLine1: "1 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  phone: "512-555-0100",
  timeZone: "America/Chicago",
};

describeDb("onboarding intake link (#2159 S2) — real Postgres", () => {
  let prisma: PrismaService;
  let cases: OnboardingService;
  let intake: OnboardingIntakeService;
  const caseIds: string[] = [];
  const sent: { to: string; subject: string; html: string }[] = [];
  const stored = new Map<string, Buffer>();
  let planMonthly = 99;
  const prevSecret = process.env.ONBOARDING_TOKEN_SECRET;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    process.env.ONBOARDING_TOKEN_SECRET = SECRET;
    const tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const audit = new AuditService(prisma);
    cases = new OnboardingService(prisma, audit, tenantCtx);
    const email = {
      sendPlatform: jest.fn(async (m: { to: string; subject: string; html: string }) => {
        sent.push(m);
        return { delivered: true, transport: "smtp" as const };
      }),
    };
    const storage = {
      upload: jest.fn(async (key: string, buf: Buffer) => {
        stored.set(key, buf);
        return key;
      }),
      delete: jest.fn(async (key: string) => {
        stored.delete(key);
      }),
      presignedUrl: jest.fn(async (key: string) => `https://files.example.invalid/${key}?sig=x`),
    };
    const proration = {
      quote: jest.fn(async (req: { planKey: string; cycle: "MONTHLY" | "ANNUAL" }) => {
        if (req.planKey !== "GROWTH") throw new Error(`Unknown plan "${req.planKey}"`);
        return {
          planKey: "GROWTH",
          planName: "Growth",
          cycle: req.cycle,
          isCustom: false,
          lines: [
            {
              type: "plan",
              key: "GROWTH",
              name: "Growth",
              quantity: 1,
              monthly: planMonthly,
              cyclePrice: planMonthly,
              included: false,
            },
          ],
          subtotalMonthly: planMonthly,
          dueToday: planMonthly,
          annualSaving: 0,
          renewalAt: "2030-01-01T00:00:00.000Z",
        };
      }),
    };
    const catalog = { getPublishedVersion: jest.fn(async () => ({ version: 12 })) };
    intake = new OnboardingIntakeService(
      prisma,
      audit,
      email as never,
      storage as never,
      proration as never,
      catalog as never,
    );
  });

  afterAll(async () => {
    process.env.ONBOARDING_TOKEN_SECRET = prevSecret;
    try {
      await prisma.onboardingCase.deleteMany({ where: { id: { in: caseIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: ADMIN } });
    } finally {
      await prisma?.$disconnect();
    }
  });

  async function newCase(
    dealTerms: Record<string, unknown> = {
      planKey: "GROWTH",
      interval: "month",
      setupFeeCents: 50000,
    },
  ) {
    const c = await cases.create(
      {
        companyName: `Acme ${RUN}`,
        contactName: "Pat Example",
        contactEmail: `pat-${RUN}@example.invalid`,
        dealTerms: dealTerms as never,
      },
      ADMIN,
    );
    caseIds.push(c.id);
    return c;
  }

  const tokenOf = (url: string) => url.split("#token=")[1];

  async function expectLinkNotFound(p: Promise<unknown>) {
    const err = await p.then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe(LINK_NOT_FOUND);
  }

  it("issues a link whose token lives in the URL fragment, stores only its hash, and emails it on request", async () => {
    const c = await newCase();
    const r = await intake.issueLink(c.id, ADMIN, true);
    expect(r.url).toMatch(/\/onboarding#token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(r.emailed).toBe(true);
    const token = tokenOf(r.url);
    const rows = await prisma.intakeAccessToken.findMany({ where: { caseId: c.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toContain(token.split(".")[0]);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(sent.at(-1)).toMatchObject({ to: c.contactEmail });
    const s = await intake.session(token);
    expect(s.sections.map((x) => x.key)).toEqual([
      "ACCOUNT",
      "TAX_COMPLIANCE",
      "INVOICING",
      "TEAM",
      "OPERATIONS",
      "DATA_FILES",
      "GO_LIVE_PREFS",
    ]);
    expect(s.sections.every((x) => x.status === "EMPTY" && x.editable)).toBe(true);
    expect(s.terms).toEqual({ termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION });
    const used = await prisma.intakeAccessToken.findFirstOrThrow({ where: { caseId: c.id } });
    expect(used.lastUsedAt).not.toBeNull();
  });

  it("rejects a forged HMAC BEFORE any database read", async () => {
    const spy = jest.spyOn(prisma.intakeAccessToken, "findUnique");
    const forged = mintSignedToken("some-other-secret-that-is-long-enough");
    await expectLinkNotFound(intake.session(forged));
    await expectLinkNotFound(intake.session("short"));
    await expectLinkNotFound(intake.session(undefined));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("unknown, expired, revoked and closed-case tokens all return the same 404", async () => {
    // Unknown: correctly signed, never issued.
    await expectLinkNotFound(intake.session(mintSignedToken(SECRET)));
    // Expired.
    const c1 = await newCase();
    const t1 = tokenOf((await intake.issueLink(c1.id, ADMIN, false)).url);
    await prisma.intakeAccessToken.updateMany({
      where: { caseId: c1.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expectLinkNotFound(intake.session(t1));
    // Revoked by the admin.
    const c2 = await newCase();
    const t2 = tokenOf((await intake.issueLink(c2.id, ADMIN, false)).url);
    await intake.revokeLink(c2.id, ADMIN);
    await expectLinkNotFound(intake.session(t2));
    // Revoked by LOST.
    const c3 = await newCase();
    const t3 = tokenOf((await intake.issueLink(c3.id, ADMIN, false)).url);
    await cases.update(c3.id, { status: "LOST", lostReason: "No budget" }, ADMIN);
    await expectLinkNotFound(intake.session(t3));
    expect(
      (await prisma.intakeAccessToken.findFirstOrThrow({ where: { caseId: c3.id } })).revokedAt,
    ).not.toBeNull();
  });

  it("issuing a new link revokes the old one — one active token per case", async () => {
    const c = await newCase();
    const old = tokenOf((await intake.issueLink(c.id, ADMIN, false)).url);
    const fresh = tokenOf((await intake.issueLink(c.id, ADMIN, false)).url);
    await expectLinkNotFound(intake.session(old));
    await expect(intake.session(fresh)).resolves.toBeDefined();
    expect(await prisma.intakeAccessToken.count({ where: { caseId: c.id, revokedAt: null } })).toBe(
      1,
    );
  });

  it("draft → submit → send back (B5 email) → edit → resubmit → approve; a submitted section is locked", async () => {
    const c = await newCase();
    const t = tokenOf((await intake.issueLink(c.id, ADMIN, false)).url);
    // A partial draft saves; a submit of the partial draft is refused and changes nothing.
    await intake.saveSection(t, "ACCOUNT", { legalName: "Acme" });
    await expect(intake.submitSection(t, "ACCOUNT")).rejects.toMatchObject({
      response: { code: "INTAKE_ANSWERS_INVALID" },
    });
    expect(
      (await prisma.intakeSection.findFirstOrThrow({ where: { caseId: c.id, key: "ACCOUNT" } }))
        .status,
    ).toBe("DRAFT");
    // Unknown (secret-shaped) field refused, nothing written.
    await expect(
      intake.saveSection(t, "ACCOUNT", { ...ACCOUNT, password: "hunter2" }),
    ).rejects.toBeDefined();
    expect(
      (await prisma.intakeSection.findFirstOrThrow({ where: { caseId: c.id, key: "ACCOUNT" } }))
        .answers,
    ).toEqual({ legalName: "Acme" });

    await intake.saveSection(t, "ACCOUNT", ACCOUNT);
    const submitted = await intake.submitSection(t, "ACCOUNT");
    expect(submitted.sections[0]).toMatchObject({ status: "SUBMITTED", editable: false });
    await expect(intake.saveSection(t, "ACCOUNT", ACCOUNT)).rejects.toMatchObject({
      response: { code: "INTAKE_SECTION_LOCKED" },
    });

    await expect(
      intake.review(c.id, "ACCOUNT", "request_changes", "  ", ADMIN),
    ).rejects.toBeDefined();
    const back = await intake.review(
      c.id,
      "ACCOUNT",
      "request_changes",
      "Is the legal name exactly as registered?",
      ADMIN,
    );
    expect(back.sections[0]).toMatchObject({ status: "CHANGES_REQUESTED", reviewedById: ADMIN });
    expect(sent.at(-1)!.subject).toBe("A few questions about your Account answers");
    expect(sent.at(-1)!.html).toContain("Is the legal name exactly as registered?");

    await intake.saveSection(t, "ACCOUNT", { ...ACCOUNT, legalName: "Acme Wholesale, LLC" });
    await intake.submitSection(t, "ACCOUNT");
    const ok = await intake.review(c.id, "ACCOUNT", "approve", undefined, ADMIN);
    expect(ok.sections[0].status).toBe("APPROVED");
    await expect(intake.review(c.id, "ACCOUNT", "approve", undefined, ADMIN)).rejects.toMatchObject(
      {
        response: { code: "INTAKE_SECTION_NOT_REVIEWABLE" },
      },
    );
  });

  it("acceptance: server-side snapshot, frozen after a catalog price change, re-accept supersedes, rows append-only", async () => {
    planMonthly = 99;
    const c = await newCase({ planKey: "GROWTH", interval: "month", setupFeeCents: 50000 });
    const t = tokenOf((await intake.issueLink(c.id, ADMIN, false)).url);
    const a1 = await intake.accept(t, {
      acceptedName: "Pat Example",
      acceptedEmail: "pat@example.invalid",
      ip: "203.0.113.9",
      userAgent: "UA/1",
    });
    expect(a1.acceptance!.orderSnapshot).toMatchObject({
      planKey: "GROWTH",
      recurringDue: 99,
      setupFee: 500,
      setupFeeCents: 50000,
      dueToday: 599,
      catalogVersion: 12,
    });
    const row1 = await prisma.orderAcceptance.findFirstOrThrow({ where: { caseId: c.id } });
    expect(row1).toMatchObject({
      ip: "203.0.113.9",
      userAgent: "UA/1",
      termsVersion: TERMS_VERSION,
      supersededAt: null,
    });

    // The catalog price moves: the live preview follows it, the accepted snapshot does not.
    planMonthly = 149;
    const after = await intake.session(t);
    expect(after.order!.dueToday).toBe(649);
    expect(after.acceptance!.orderSnapshot.dueToday).toBe(599);
    expect(
      (await prisma.orderAcceptance.findUniqueOrThrow({ where: { id: row1.id } })).orderSnapshot,
    ).toEqual(row1.orderSnapshot);

    // Re-accepting (a re-quote) supersedes the prior row; exactly one current row.
    await intake.accept(t, {
      acceptedName: "Pat Example",
      acceptedEmail: "pat@example.invalid",
      ip: null,
      userAgent: null,
    });
    const rows = await prisma.orderAcceptance.findMany({
      where: { caseId: c.id },
      orderBy: { acceptedAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].supersededAt).not.toBeNull();
    expect(rows[1].supersededAt).toBeNull();
    expect((rows[1].orderSnapshot as { dueToday: number }).dueToday).toBe(649);

    // The DB itself refuses any change to an accepted row (append-only trigger).
    await expect(
      prisma.$executeRaw`UPDATE "OrderAcceptance" SET "acceptedName" = 'Someone else' WHERE id = ${rows[1].id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRaw`UPDATE "OrderAcceptance" SET "supersededAt" = now() WHERE id = ${rows[0].id}`,
    ).rejects.toThrow(/immutable/);
  });

  it("an unpriceable deal (no plan) cannot be accepted, and the page says so without an error", async () => {
    const c = await newCase({});
    const t = tokenOf((await intake.issueLink(c.id, ADMIN, false)).url);
    const s = await intake.session(t);
    expect(s).toMatchObject({ order: null, orderUnavailable: true, acceptance: null });
    await expect(
      intake.accept(t, {
        acceptedName: "Pat",
        acceptedEmail: "pat@example.invalid",
        ip: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ response: { code: "INTAKE_ORDER_NOT_READY" } });
    expect(await prisma.orderAcceptance.count({ where: { caseId: c.id } })).toBe(0);
  });

  it("uploads: allowlisted type stored under onboarding/<caseId>/, sha256 recorded; the customer deletes only their own", async () => {
    const c = await newCase();
    const t = tokenOf((await intake.issueLink(c.id, ADMIN, false)).url);
    const buf = Buffer.from("sku,name\nA1,Chips\n");
    const s = await intake.uploadAsCustomer(t, "DATA_FILES", "customers", {
      originalname: "../customers list.csv",
      mimetype: "text/csv",
      size: buf.length,
      buffer: buf,
    });
    expect(s.files).toHaveLength(1);
    const row = await prisma.intakeFile.findFirstOrThrow({ where: { caseId: c.id } });
    expect(row.storageKey).toMatch(
      new RegExp(`^onboarding/${c.id}/[0-9a-f-]{36}-customers_list\\.csv$`),
    );
    expect(row).toMatchObject({ containsPii: true, uploadedBy: "customer", sizeBytes: buf.length });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.has(row.storageKey)).toBe(true);

    await expect(
      intake.uploadAsCustomer(t, "DATA_FILES", "products", {
        originalname: "x.html",
        mimetype: "text/html",
        size: 5,
        buffer: Buffer.from("<p>"),
      }),
    ).rejects.toBeDefined();
    await expect(
      intake.uploadAsCustomer(t, "DATA_FILES", "passwords", {
        originalname: "x.csv",
        mimetype: "text/csv",
        size: 1,
        buffer: Buffer.from("a"),
      }),
    ).rejects.toBeDefined();
    expect(await prisma.intakeFile.count({ where: { caseId: c.id } })).toBe(1);

    // An admin-uploaded file is not the customer's to delete.
    await intake.uploadAsAdmin(
      c.id,
      "ACCOUNT",
      "logo",
      { originalname: "logo.png", mimetype: "image/png", size: 3, buffer: Buffer.from("png") },
      ADMIN,
    );
    const adminFile = await prisma.intakeFile.findFirstOrThrow({
      where: { caseId: c.id, uploadedBy: ADMIN },
    });
    await expect(intake.deleteAsCustomer(t, adminFile.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const afterDelete = await intake.deleteAsCustomer(t, row.id);
    expect(afterDelete.files.map((f) => f.id)).toEqual([adminFile.id]);
    expect(stored.has(row.storageKey)).toBe(false);
    expect(await intake.signedFileUrl(c.id, adminFile.id)).toEqual({
      url: expect.stringContaining(adminFile.storageKey),
    });
  });

  it("files follow their section's state: once APPROVED (or otherwise locked) the customer can neither add nor delete (#2431 fold a)", async () => {
    const c = await newCase();
    const t = tokenOf((await intake.issueLink(c.id, ADMIN, false)).url);
    const csv = (name: string) => ({
      originalname: name,
      mimetype: "text/csv",
      size: 3,
      buffer: Buffer.from("a,b"),
    });
    await intake.uploadAsCustomer(t, "DATA_FILES", "customers", csv("customers.csv"));
    const f = await prisma.intakeFile.findFirstOrThrow({ where: { caseId: c.id } });
    expect(stored.has(f.storageKey)).toBe(true);

    // The admin approves the section (set directly: this pin is about the file gates).
    await prisma.intakeSection.update({
      where: { caseId_key: { caseId: c.id, key: "DATA_FILES" } },
      data: { status: "APPROVED" },
    });

    await expect(
      intake.uploadAsCustomer(t, "DATA_FILES", "products", csv("products.csv")),
    ).rejects.toMatchObject({ response: { code: "INTAKE_SECTION_LOCKED" } });
    expect(await prisma.intakeFile.count({ where: { caseId: c.id } })).toBe(1);

    await expect(intake.deleteAsCustomer(t, f.id)).rejects.toMatchObject({
      response: { code: "INTAKE_SECTION_LOCKED" },
    });
    // Nothing moved: the row is live and the stored object is still there.
    expect(
      (await prisma.intakeFile.findUniqueOrThrow({ where: { id: f.id } })).deletedAt,
    ).toBeNull();
    expect(stored.has(f.storageKey)).toBe(true);

    // Sent back for changes → editable again, so the customer can fix their files.
    await prisma.intakeSection.update({
      where: { caseId_key: { caseId: c.id, key: "DATA_FILES" } },
      data: { status: "CHANGES_REQUESTED" },
    });
    await intake.deleteAsCustomer(t, f.id);
    expect(stored.has(f.storageKey)).toBe(false);
  });

  it("accept is idempotent: a double submit of the same order, versions and signer keeps ONE current row (#2431 fold d)", async () => {
    planMonthly = 99;
    const c = await newCase({ planKey: "GROWTH", interval: "month" });
    const t = tokenOf((await intake.issueLink(c.id, ADMIN, false)).url);
    const signer = {
      acceptedName: "Pat Example",
      acceptedEmail: "pat@example.invalid",
      ip: "203.0.113.9",
      userAgent: "UA/1",
    };
    await intake.accept(t, signer);
    const first = await prisma.orderAcceptance.findFirstOrThrow({ where: { caseId: c.id } });
    await intake.accept(t, { ...signer, ip: "203.0.113.10" });
    const rows = await prisma.orderAcceptance.findMany({ where: { caseId: c.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(first);
    expect(
      await prisma.onboardingEvent.count({ where: { caseId: c.id, type: "order.accepted" } }),
    ).toBe(1);

    // A different signer is a new acceptance (it supersedes).
    await intake.accept(t, { ...signer, acceptedName: "Sam Example" });
    expect(await prisma.orderAcceptance.count({ where: { caseId: c.id } })).toBe(2);
  });

  it("a case's token never opens another case's data", async () => {
    const a = await newCase();
    const b = await newCase();
    const ta = tokenOf((await intake.issueLink(a.id, ADMIN, false)).url);
    await intake.issueLink(b.id, ADMIN, false);
    const s = await intake.session(ta);
    expect(s.companyName).toBe(a.companyName);
    await intake.uploadAsAdmin(
      b.id,
      "DATA_FILES",
      "stock",
      { originalname: "s.csv", mimetype: "text/csv", size: 1, buffer: Buffer.from("x") },
      ADMIN,
    );
    const bFile = await prisma.intakeFile.findFirstOrThrow({ where: { caseId: b.id } });
    await expect(intake.deleteAsCustomer(ta, bFile.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
