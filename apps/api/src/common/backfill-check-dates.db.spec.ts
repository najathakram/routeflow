/**
 * DB-lane spec for `../../scripts/backfill-check-dates.mjs` (post-dated check payments PR-1) —
 * proves the actual read → write → re-read round trip against a REAL Postgres: dry-run makes no
 * writes, `--apply` sets `checkDate` and leaves `status` untouched, and a row outside scope
 * (CLEARED/BOUNCED, non-CHECK, DRAFT/VOID, or already-backfilled) is left exactly alone. The
 * decision logic itself (`shouldBackfillCheckDate`/`deriveCheckDate`/`planCheckDateBackfill`) is
 * locked without a database in the sibling `backfill-check-dates-script.spec.ts` — this file
 * only needs to prove the script's real read-then-write mechanism against a real table.
 *
 * Lives under `src/common` (not next to the script under `scripts/`) because `jest.db.config.js`
 * inherits `rootDir: "src"` from the base Jest config — a spec under `apps/api/scripts/` would
 * never be discovered by `npm run local:test:db`, matching the sibling precedent
 * `backfill-subscription-reconciliation.db.spec.ts`.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY (L-129 — never let a spec run an unscoped write against a shared database): every
 * invocation below passes `--tenant-id <TENANT_ID>`, scoping the CLI's scan/apply to exactly
 * this file's own fixture tenant — a `qa-` slug approved by `assertTestTenant`. `afterAll`
 * deletes exactly the rows this file created (FK order: InvoicePayment → Invoice → Customer →
 * User → Tenant).
 *
 * NOT EXECUTED as part of this PR's authoring session (no local Postgres / docker-compose
 * access from that environment) — written and reviewed for shape/correctness against the real
 * schema, to run the next time `npm run local:test:db` runs in this repo.
 */
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-check-dates.mjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
const TENANT_SLUG = assertTestTenant(
  `qa-checkdate-${RUN_SUFFIX}`,
  "backfill-check-dates.db.spec.ts",
);

// A fixed, deterministic cutoff so every fixture's settledAt can be placed unambiguously on
// either side of it, independent of when this suite happens to run.
const SINCE = "2026-09-15T00:00:00.000Z";
const FUTURE_SETTLED_AT = new Date("2026-10-01T15:30:00.000Z");
const PAST_SETTLED_AT = new Date("2026-09-01T00:00:00.000Z");

function childEnv(dbUrl: string, tenantId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  env.DATABASE_URL = dbUrl;
  return env;
}

function runCli(dbUrl: string, tenantId: string, extraArgs: string[] = []): string {
  return execSync(`node "${CLI}" --since ${SINCE} --tenant-id ${tenantId} ${extraArgs.join(" ")}`, {
    cwd: API_DIR,
    encoding: "utf8",
    env: childEnv(dbUrl, tenantId),
  });
}

describeDb("post-dated check payments PR-1: backfill-check-dates.mjs — real Postgres", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let dbUrl: string;
  let tenantId: string;
  let customerId: string;
  let invoiceId: string;

  beforeAll(async () => {
    dbUrl = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: dbUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    const tenant = await prisma.tenant.create({
      data: { slug: TENANT_SLUG, name: `CheckDate backfill ${TENANT_SLUG}` },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        email: `${TENANT_SLUG}@example.invalid`,
        username: TENANT_SLUG,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `CheckDate backfill customer`,
        contactName: `CheckDate backfill contact`,
        tenantId,
      },
    });
    customerId = customer.id;

    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-CHECKDATE-${RUN_SUFFIX}`,
        status: "SENT",
        subtotal: 100,
        total: 100,
      },
    });
    invoiceId = invoice.id;
  });

  afterAll(async () => {
    await prisma.invoicePayment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
    await pool.end();
  });

  async function createPayment(overrides: {
    method?: string;
    status?: string;
    checkStatus?: string | null;
    settledAt?: Date | null;
    checkDate?: Date | null;
  }) {
    return prisma.invoicePayment.create({
      data: {
        invoiceId,
        tenantId,
        amount: 100,
        method: (overrides.method ?? "CHECK") as never,
        status: (overrides.status ?? "PAID") as never,
        checkStatus: (overrides.checkStatus === undefined
          ? "RECORDED"
          : overrides.checkStatus) as never,
        settledAt: overrides.settledAt === undefined ? FUTURE_SETTLED_AT : overrides.settledAt,
        checkDate: overrides.checkDate ?? null,
      },
    });
  }

  it("REG-PR1-CHK-DB1: dry run makes no writes — a qualifying row's checkDate is still null on re-read", async () => {
    const payment = await createPayment({});

    runCli(dbUrl, tenantId); // no --apply

    const reread = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reread.checkDate).toBeNull();
    expect(reread.status).toBe("PAID");
  });

  it("REG-PR1-CHK-DB2: --apply sets checkDate to settledAt's UTC date and never changes status", async () => {
    const payment = await createPayment({});

    runCli(dbUrl, tenantId, ["--apply"]);

    const reread = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reread.checkDate?.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(reread.status).toBe("PAID");
  });

  it("REG-PR1-CHK-DB3: a CLEARED check is left untouched by --apply", async () => {
    const payment = await createPayment({ checkStatus: "CLEARED" });

    runCli(dbUrl, tenantId, ["--apply"]);

    const reread = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reread.checkDate).toBeNull();
  });

  it("REG-PR1-CHK-DB4: a non-CHECK payment is left untouched by --apply", async () => {
    const payment = await createPayment({ method: "CASH", checkStatus: null });

    runCli(dbUrl, tenantId, ["--apply"]);

    const reread = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reread.checkDate).toBeNull();
  });

  it("REG-PR1-CHK-DB5: a DRAFT check payment is left untouched by --apply", async () => {
    const payment = await createPayment({ status: "DRAFT" });

    runCli(dbUrl, tenantId, ["--apply"]);

    const reread = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reread.checkDate).toBeNull();
  });

  it("REG-PR1-CHK-DB6: a settledAt before the cutoff is left untouched by --apply", async () => {
    const payment = await createPayment({ settledAt: PAST_SETTLED_AT });

    runCli(dbUrl, tenantId, ["--apply"]);

    const reread = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reread.checkDate).toBeNull();
  });

  it("REG-PR1-CHK-DB7: rerunning --apply on an already-backfilled row is idempotent (0 further changes)", async () => {
    const payment = await createPayment({});
    runCli(dbUrl, tenantId, ["--apply"]);
    const first = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });

    const output = runCli(dbUrl, tenantId, ["--apply"]);

    const second = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(second.checkDate?.toISOString()).toBe(first.checkDate?.toISOString());
    expect(output).toContain("0 change(s)");
  });
});
