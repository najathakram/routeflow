/**
 * DB-lane spec for `scripts/report-suspended-stamp-census.mjs`: plants SUSPENDED tenants of mixed class / reason
 * (qa-* / acme-* placeholders, never a real client), runs the script as a child process with
 * --target-host=<the lane host>, and asserts exact count DELTAS against a baseline run (the lane DB may hold
 * other specs' rows). Also pins: a deleted tenant is excluded, no id / slug reaches the output, and a write inside
 * withReadOnlyTx is refused by Postgres (25006).
 */
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client, Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(API_DIR, "scripts", "report-suspended-stamp-census.mjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require("../../scripts/lib/report-suspended-stamp-census.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withReadOnlyTx } = require("../../scripts/lib/report-839-regulated-void-residue.cjs");

const SUFFIX = randomUUID().slice(0, 8);
const slug = (p: string, n: string) => `${p}-sc${SUFFIX}-${n}`;

describeDb("report-suspended-stamp-census.mjs (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const host = new URL(dbUrl).hostname;
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const slugs: string[] = [];

  function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: dbUrl };
    for (const k of Object.keys(env))
      if (k.startsWith("RAILWAY_") || k.startsWith("POSTGRES_")) delete env[k];
    return env;
  }

  function census(): { json: any; raw: string } {
    const res = spawnSync(process.execPath, [SCRIPT, `--target-host=${host}`, "--json"], {
      encoding: "utf8",
      cwd: API_DIR,
      env: childEnv(),
    });
    expect(res.status).toBe(0);
    return { json: JSON.parse(res.stdout), raw: res.stdout };
  }

  async function plant(
    prefix: string,
    n: string,
    o: {
      cls: "PRODUCTION" | "DEMO" | "TEST" | "INTERNAL";
      status?: "SUSPENDED" | "ACTIVE";
      reason?: string | null;
      deleted?: boolean;
      sub?: "none" | "stripe" | "nostripe";
    },
  ) {
    const s = slug(prefix, n);
    slugs.push(s);
    const t = await prisma.tenant.create({
      data: {
        slug: s,
        name: s,
        class: o.cls,
        status: o.status ?? "SUSPENDED",
        readOnlyReason: o.reason ?? null,
        deletedAt: o.deleted ? new Date() : null,
      },
    });
    if (o.sub && o.sub !== "none")
      await prisma.tenantSubscription.create({
        data: { tenantId: t.id, stripeSubId: o.sub === "stripe" ? `sub_${s}` : null },
      });
    return s;
  }

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: slugs } } });
    await prisma.$disconnect();
    await pool.end();
  });

  it("counts SUSPENDED tenants by class and reason, excludes deleted, leaks no id or slug", async () => {
    const before = census().json.classes;
    await plant("acme", "p1", { cls: "PRODUCTION", sub: "stripe" });
    await plant("acme", "p2", { cls: "PRODUCTION", sub: "nostripe" });
    await plant("acme", "p3", { cls: "PRODUCTION", reason: "overdue_suspended" });
    await plant("acme", "p4", { cls: "PRODUCTION", reason: "admin_set", sub: "stripe" });
    await plant("acme", "p5", { cls: "PRODUCTION", reason: "weird_reason" });
    await plant("acme", "p6", { cls: "PRODUCTION", deleted: true, sub: "stripe" });
    await plant("acme", "p7", { cls: "PRODUCTION", status: "ACTIVE" });
    await plant("qa", "t1", { cls: "TEST" });
    await plant("qa", "t2", { cls: "TEST", reason: "admin_set" });
    await plant("qa", "d1", { cls: "DEMO", reason: "overdue_suspended" });

    const { json, raw } = census();
    const d = (c: string, f: (x: any) => number) => f(json.classes[c]) - f(before[c]);
    expect(d("PRODUCTION", (x) => x.suspended)).toBe(5);
    expect(d("PRODUCTION", (x) => x.byReason.null)).toBe(2);
    expect(d("PRODUCTION", (x) => x.byReason.overdue_suspended)).toBe(1);
    expect(d("PRODUCTION", (x) => x.byReason.admin_set)).toBe(1);
    expect(d("PRODUCTION", (x) => x.byReason.other)).toBe(1);
    expect(d("PRODUCTION", (x) => x.reinstatableNow)).toBe(4);
    expect(d("PRODUCTION", (x) => x.subscription.present)).toBe(3);
    expect(d("PRODUCTION", (x) => x.subscription.withStripeSubId)).toBe(2);
    expect(d("PRODUCTION", (x) => x.subscription.absent)).toBe(2);
    expect(d("TEST", (x) => x.suspended)).toBe(2);
    expect(d("TEST", (x) => x.byReason.null)).toBe(1);
    expect(d("TEST", (x) => x.byReason.admin_set)).toBe(1);
    expect(d("TEST", (x) => x.reinstatableNow)).toBe(1);
    expect(d("DEMO", (x) => x.suspended)).toBe(1);
    expect(d("INTERNAL", (x) => x.suspended)).toBe(0);
    expect(json.classes.TEST.subscription).toBeUndefined();

    const ids = (
      await prisma.tenant.findMany({ where: { slug: { in: slugs } }, select: { id: true } })
    ).map((t) => t.id);
    for (const needle of [...slugs, ...ids, SUFFIX]) expect(raw).not.toContain(needle);
  });

  it("plain-text output carries the header and the what-the-numbers-mean footer, no ids", () => {
    const res = spawnSync(process.execPath, [SCRIPT, `--target-host=${host}`], {
      encoding: "utf8",
      cwd: API_DIR,
      env: childEnv(),
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/SUSPENDED/);
    expect(res.stdout).toMatch(/what the numbers mean/i);
    expect(res.stdout).toMatch(/does not call Stripe/i);
    expect(res.stdout).not.toContain(SUFFIX);
  });

  it("a write inside withReadOnlyTx is refused by Postgres (25006) and the session is UTC", async () => {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query(lib.SET_UTC);
      const tz = await client.query("SHOW TimeZone");
      expect(tz.rows[0].TimeZone).toBe("UTC");
      let code: string | undefined;
      await withReadOnlyTx(client, async () => {
        try {
          await client.query(`UPDATE "Tenant" SET name = name WHERE false`);
        } catch (e: any) {
          code = e.code;
        }
      }).catch(() => undefined);
      expect(code).toBe("25006");
    } finally {
      await client.end();
    }
  });
});
