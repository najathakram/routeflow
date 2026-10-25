/**
 * DB-lane spec for `../../scripts/backfill-b294-order-line-taxrate.mjs` (T15, owner-run B294 backfill): the dry run, the
 * saved plan, the apply and the idempotent rerun against a REAL Postgres. The classification rules are locked without a
 * database in `backfill-b294-is-empty-script.spec.ts`.
 *
 * Proves: the dry run writes nothing; selection is by emptiness not a date bound (a pre-fix AND a post-fix invoice whose lines
 * are all 0: the pre-fix one is planned, the post-fix one is held as REVIEW `post-fix` and counted per tenant id and per
 * creation source, SA-960); an already-rated invoice, a VOID invoice and an unverifiable one are left alone; --apply writes
 * exactly the planned lines' taxRate and nothing else (no amount, total or status moves); a rerun plans 0 for the tenant.
 *
 * Collected only by `jest.db.config.js`, run via `npm run local:test:db`. SAFETY (L-129): the spec's own qa- tenant is a
 * test tenant (assertTestTenant), the CLI runs `--local` (refuses a non-local host), and afterAll deletes what it made.
 */
import { execFileSync, execSync } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_DIR, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-b294-order-line-taxrate.mjs");
const RUN = randomUUID().slice(0, 8);

function cliEnv(dbUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  env.DATABASE_URL = dbUrl;
  return env;
}

describeDb("backfill-b294-order-line-taxrate.mjs, real Postgres", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let dbUrl: string;
  let tenantId = "";
  let customerId = "";
  let orderId = "";
  const inv: Record<string, string> = {};
  const item: Record<string, string> = {};

  const makeInvoice = async (
    key: string,
    over: { createdAt?: Date; status?: string; taxRate?: number; taxAmount?: number } = {},
  ) => {
    const taxAmount = over.taxAmount ?? 7.5;
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId,
        invoiceNumber: `INV-B294-${RUN}-${key}`,
        status: (over.status ?? "SENT") as any,
        subtotal: 100,
        taxAmount,
        total: 100 + taxAmount,
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      } as any,
    });
    const line = await prisma.invoiceItem.create({
      data: {
        invoiceId: invoice.id,
        tenantId,
        description: "Cola",
        qty: 1,
        unitPrice: 100,
        subtotal: 100,
        taxRate: over.taxRate ?? 0,
      } as any,
    });
    inv[key] = invoice.id;
    item[key] = line.id;
  };
  const rateOf = async (key: string) =>
    Number((await prisma.invoiceItem.findUniqueOrThrow({ where: { id: item[key] } })).taxRate);
  const snapshot = async (key: string) => {
    const i = await prisma.invoice.findUniqueOrThrow({ where: { id: inv[key] } });
    return `${i.subtotal}|${i.taxAmount}|${i.total}|${i.status}`;
  };

  const dryRun = () => {
    const out = execFileSync("node", [CLI, "--local"], {
      cwd: API_DIR,
      encoding: "utf8",
      env: cliEnv(dbUrl),
    });
    const file = /^plan: (.+)$/m.exec(out)?.[1]?.trim() ?? "";
    const hash = /^plan hash: (\w+)$/m.exec(out)?.[1] ?? "";
    const plan = JSON.parse(readFileSync(file, "utf8"));
    const mine = (plan.apply as Array<{ invoiceId: string; rate: number }>).filter((a) =>
      Object.values(inv).includes(a.invoiceId),
    );
    const review = (plan.review as Array<{ invoiceId: string; reason: string }>).filter((r) =>
      Object.values(inv).includes(r.invoiceId),
    );
    return { out, file, hash, mine, review };
  };

  beforeAll(async () => {
    dbUrl = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: dbUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const slug = assertTestTenant(`qa-b294-${RUN}`, "backfill-b294-order-line-taxrate.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `b294 ${slug}` } })).id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "b294", contactName: "b294", tenantId } as any,
      })
    ).id;
    orderId = (
      await prisma.order.create({
        data: {
          tenantId,
          customerId,
          orderNumber: `ORD-B294-${RUN}`,
          subtotal: 100,
          tax: 7.5,
          total: 107.5,
          status: "DELIVERED",
        } as any,
      })
    ).id;
    await makeInvoice("old", { createdAt: new Date("2026-09-01T00:00:00Z") });
    await makeInvoice("postfix"); // created now: after the stamping fix, lines still all 0
    await makeInvoice("rated", { taxRate: 0.075 }); // not empty
    await makeInvoice("void", { status: "VOID" }); // never touched
    await makeInvoice("unverified", { taxAmount: 7.33 }); // 7.33 on 100 reproduces at 7.33%, created now -> held as post-fix like "postfix"
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    await prisma.invoiceItem
      .deleteMany({ where: { invoiceId: { in: Object.values(inv) } } })
      .catch(swallow);
    await prisma.invoice.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.order.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.customer.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma.$disconnect();
    await pool.end();
  });

  it("a dry run writes nothing, plans the pre-fix empty invoice and HOLDS the post-fix one as REVIEW post-fix with counts (SA-960)", async () => {
    const before = await Promise.all(Object.keys(inv).map(snapshot));
    const { out, mine, review } = dryRun();
    expect(out).toMatch(/DRY-RUN/);
    expect(mine.map((a) => a.invoiceId)).toEqual([inv.old]);
    expect(review.find((r) => r.invoiceId === inv.postfix)?.reason).toBe("post-fix");
    expect(out).toMatch(/REVIEW post-fix: \d+ verified all-zero/);
    expect(out).toContain(`by tenant id ${tenantId}: 2`); // "postfix" and "unverified" (7.33 on 100 is a provable rate, created now)
    expect(out).toMatch(/by creation source APP: \d+/);
    expect(mine.every((a) => a.rate === 0.075)).toBe(true);
    expect(await Promise.all(Object.keys(inv).map(snapshot))).toEqual(before);
    for (const k of Object.keys(inv)) expect(await rateOf(k)).toBe(k === "rated" ? 0.075 : 0);
  }, 90_000);

  it("--apply writes exactly the planned lines' taxRate and no amount; the rest is untouched", async () => {
    const amounts = await Promise.all(Object.keys(inv).map(snapshot));
    const { file, hash } = dryRun();
    const head = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    execFileSync(
      "node",
      [
        CLI,
        "--apply",
        "--plan",
        file,
        "--confirm-plan",
        hash,
        "--guard-sha",
        head,
        "--i-have-a-fresh-backup",
        "--local",
      ],
      { cwd: API_DIR, encoding: "utf8", env: cliEnv(dbUrl) },
    );
    expect(await rateOf("old")).toBe(0.075);
    expect(await rateOf("postfix")).toBe(0); // held: a live writer, never stamped
    expect(await rateOf("rated")).toBe(0.075); // it already was
    expect(await rateOf("void")).toBe(0);
    expect(await rateOf("unverified")).toBe(0);
    expect(await Promise.all(Object.keys(inv).map(snapshot))).toEqual(amounts); // no amount, total or status moved
  }, 90_000);

  it("a rerun is idempotent: nothing of this tenant is planned again", async () => {
    const { mine } = dryRun();
    expect(mine).toEqual([]);
    expect(await rateOf("old")).toBe(0.075);
  }, 90_000);
});
