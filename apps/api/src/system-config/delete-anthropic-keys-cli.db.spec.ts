/**
 * AI limits PR-2c: how `delete-tenant-anthropic-keys.mjs` WIRES its gates, run as a child process against the lane
 * database. Every refusal must name its own reason and leave the key row exactly as it was; removing or forcing any gate
 * in the CLI turns a case red. A fake terminal (a preload that sets isTTY, with the typed answers piped in) reaches the
 * typed-phrase paths. Tenants are throwaway `qa-delcli-*` slugs, plus non-test `acme-delcli-*` ones for the "a local-looking
 * host holding a live tenant is live" cases (created in nested groups, removed after). The lane database must hold no
 * other business key row and no other non-test tenant: the CLI works over the whole database.
 */
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require("../../scripts/lib/delete-anthropic-keys-core.cjs");

const SCRIPT = path.resolve(__dirname, "../../scripts/delete-tenant-anthropic-keys.mjs");
const RUN = randomUUID().slice(0, 8);
const SECRET = "sk-ant-api03-CLIDELETECLIDELETECLIDELETE9999";
const PLATFORM_VALUE = "platform-key-must-survive-8888";
const APPLY = ["--apply", "--after-pr3"];

describeDb("delete-tenant-anthropic-keys CLI gate wiring (AI limits PR-2c)", () => {
  let prisma: PrismaService;
  let pool: Pool;
  let url: string;
  let priorPlatform: string | null = null;
  let preload: string;
  let qa: string;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    pool = new Pool({ connectionString: url });
    if ((await core.keyRefs(pool)).length > 0 || (await core.liveTenantCount(pool)) > 0)
      throw new Error(
        "business key rows or non-test tenants not made by this spec: use a throwaway database",
      );
    const rows = await pool.query(`SELECT value FROM "PlatformConfig" WHERE key = 'claude.apiKey'`);
    priorPlatform = rows.rows[0]?.value ?? null;
    await pool.query(`DELETE FROM "PlatformConfig" WHERE key = 'claude.apiKey'`);
    await pool.query(
      `INSERT INTO "PlatformConfig" ("id","key","value","updatedAt") VALUES (gen_random_uuid()::text, 'claude.apiKey', $1, now())`,
      [PLATFORM_VALUE],
    );
    preload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "delcli-")), "fake-tty.cjs");
    fs.writeFileSync(
      preload,
      `const m = process.env.FAKE_TTY;
if (m === "stdin" || m === "both") process.stdin.isTTY = true;
if (m === "stdout" || m === "both") process.stdout.isTTY = true;
`,
    );
    qa = await makeTenant(`qa-delcli-${RUN}-1`);
  });

  afterAll(async () => {
    const swallow = () => undefined;
    await pool.query(`DELETE FROM "PlatformConfig" WHERE key = 'claude.apiKey'`).catch(swallow);
    if (priorPlatform !== null)
      await pool
        .query(
          `INSERT INTO "PlatformConfig" ("id","key","value","updatedAt") VALUES (gen_random_uuid()::text, 'claude.apiKey', $1, now())`,
          [priorPlatform],
        )
        .catch(swallow);
    for (const id of tenantIds) {
      await pool.query(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, [id]).catch(swallow);
      await prisma.tenant.delete({ where: { id } }).catch(swallow);
    }
    await pool?.end();
    await prisma?.$disconnect();
    if (preload) fs.rmSync(path.dirname(preload), { recursive: true, force: true });
  });

  async function makeTenant(slug: string) {
    const t = await prisma.tenant.create({ data: { slug, name: `delcli ${slug}` } });
    tenantIds.push(t.id);
    return t.id;
  }
  async function setConfig(tenantId: string, key: string, value: string) {
    await pool.query(`DELETE FROM "SystemConfig" WHERE "tenantId" = $1 AND key = $2`, [
      tenantId,
      key,
    ]);
    await pool.query(
      `INSERT INTO "SystemConfig" ("id","tenantId","key","value","updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, now())`,
      [tenantId, key, value],
    );
  }
  // a fresh key row and no earlier audit row for the tenant, so each case reads only its own run
  const seedKey = async (tenantId: string) => {
    await pool.query(`DELETE FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2`, [
      tenantId,
      core.AUDIT_ACTION,
    ]);
    await setConfig(tenantId, "anthropic.apiKey", SECRET);
  };
  const hasKey = async (tenantId: string) =>
    (
      await pool.query(
        `SELECT 1 FROM "SystemConfig" WHERE "tenantId" = $1 AND key = 'anthropic.apiKey' AND value <> ''`,
        [tenantId],
      )
    ).rowCount === 1;
  const audits = async (tenantId: string) =>
    (
      await pool.query(`SELECT meta FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2`, [
        tenantId,
        core.AUDIT_ACTION,
      ])
    ).rows;
  function run(
    args: string[],
    {
      env = {},
      tty,
      input = "",
    }: { env?: Record<string, string>; tty?: string; input?: string } = {},
  ) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, ...env };
    delete childEnv.PROTECTED_TENANT_SLUGS;
    Object.assign(childEnv, env);
    const nodeArgs = tty ? ["--require", preload, SCRIPT, ...args] : [SCRIPT, ...args];
    if (tty) childEnv.FAKE_TTY = tty;
    const r = spawnSync("node", nodeArgs, { encoding: "utf8", env: childEnv, input });
    return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
  }

  it("E-1: a dry run counts, prints no value, and changes nothing (no audit row)", async () => {
    await seedKey(qa);
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 business key row\(s\) found/);
    expect(r.out).toMatch(/would delete 1/);
    expect(r.out).toMatch(/DRY RUN, nothing written/);
    expect(r.out).not.toContain(SECRET);
    expect(await hasKey(qa)).toBe(true);
    expect(await audits(qa)).toEqual([]);
  });

  it("E-2: --apply without --after-pr3 is refused (the API still reads the key), the row stays", async () => {
    await seedKey(qa);
    const r = run(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--after-pr3/);
    expect(await hasKey(qa)).toBe(true);
  });

  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production", PROTECTED_TENANT_SLUGS: "" }],
    ["RAILWAY_ENVIRONMENT set", { RAILWAY_ENVIRONMENT: "production", PROTECTED_TENANT_SLUGS: "" }],
  ])(
    "E-3: %s makes the target live even for test tenants: it needs the override",
    async (_n, env) => {
      await seedKey(qa);
      const r = run(APPLY, { env });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/--live-tenant-override/);
      expect(await hasKey(qa)).toBe(true);
    },
  );

  it("E-4: the right flags on a local test-only database delete, audit by key name, and leave every other row alone; a second run deletes 0", async () => {
    await seedKey(qa);
    await setConfig(qa, "email.smtpPassword", "smtp-keep-me");
    const r = run(APPLY);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/deleted 1 key row\(s\)/);
    expect(r.out).not.toContain(SECRET);
    expect(await hasKey(qa)).toBe(false);
    expect((await audits(qa)).map((a) => a.meta)).toEqual([
      { key: "anthropic.apiKey", actor: "script" },
    ]);
    // the platform key and another setting survive a full apply
    const platform = await pool.query(
      `SELECT value FROM "PlatformConfig" WHERE key = 'claude.apiKey'`,
    );
    expect(platform.rows.map((x) => x.value)).toEqual([PLATFORM_VALUE]);
    const smtp = await pool.query(
      `SELECT value FROM "SystemConfig" WHERE "tenantId" = $1 AND key = 'email.smtpPassword'`,
      [qa],
    );
    expect(smtp.rows.map((x) => x.value)).toEqual(["smtp-keep-me"]);
    const again = run(APPLY);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/0 business key row\(s\) found/);
    expect(again.out).toMatch(/deleted 0 key row\(s\)/);
    expect((await audits(qa)).length).toBe(1);
  });

  describe("a local-looking host that holds a non-test tenant (a tunnel to production) is live", () => {
    let acme: string;
    const acmeSlug = `acme-delcli-${RUN}`;

    beforeAll(async () => {
      acme = await makeTenant(acmeSlug);
    });

    const gates: [string, string[], string | undefined, RegExp][] = [
      ["no override", [], undefined, /--live-tenant-override/],
      ["backup but no override", ["--backup-taken"], "both", /--live-tenant-override/],
      ["override, no backup", ["--live-tenant-override"], "both", /--backup-taken/],
      [
        "override and backup, no terminal",
        ["--live-tenant-override", "--backup-taken"],
        undefined,
        /real terminal/,
      ],
      [
        "override and backup, stdin only a terminal",
        ["--live-tenant-override", "--backup-taken"],
        "stdin",
        /real terminal/,
      ],
      [
        "override and backup, stdout only a terminal",
        ["--live-tenant-override", "--backup-taken"],
        "stdout",
        /real terminal/,
      ],
    ];
    it.each(gates)(
      "E-5: %s: refused for its own reason, the row stays",
      async (_n, flags, tty, reason) => {
        await seedKey(qa);
        const r = run([...APPLY, ...flags], { tty, input: "DELETE 1 LIVE\n" });
        expect(r.code).toBe(1);
        // No "test" in the pattern: a message the CLI scrubs reaches CI with the database password ("test") starred out.
        expect(r.out).toMatch(/treated as live/);
        expect(r.out).toMatch(reason);
        expect(r.out).not.toMatch(/deleted \d/);
        expect(await hasKey(qa)).toBe(true);
        expect(await audits(qa)).toEqual([]);
      },
    );

    const live = ["--live-tenant-override", "--backup-taken"];

    it("E-6: the typed phrase must match exactly: a wrong one writes nothing", async () => {
      await seedKey(qa);
      for (const input of ["", "delete 1 live\n", "DELETE 2 LIVE\n", "yes\n"]) {
        const r = run([...APPLY, ...live], { tty: "both", input });
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/typed confirmation did not match/);
        expect(await hasKey(qa)).toBe(true);
      }
      expect(await audits(qa)).toEqual([]);
    });

    it("E-7: every gate and the right phrase: the row is deleted and audited", async () => {
      await seedKey(qa);
      const r = run([...APPLY, ...live], { tty: "both", input: "DELETE 1 LIVE\n" });
      expect(r.out).toMatch(/deleted 1 key row\(s\)/);
      expect(r.code).toBe(0);
      expect(await hasKey(qa)).toBe(false);
      expect((await audits(qa)).length).toBe(1);
    });

    describe("a protected tenant", () => {
      const env = () => ({ PROTECTED_TENANT_SLUGS: acmeSlug });

      beforeEach(async () => {
        await seedKey(qa);
        await seedKey(acme);
      });

      it("E-8: the dry run counts it and prints no tenant id", () => {
        const r = run([], { env: env() });
        expect(r.code).toBe(0);
        expect(r.out).toMatch(/protected tenant\(s\) with a key row: 1/);
        expect(r.out).not.toContain(acme);
        expect(r.out).not.toContain(qa);
      });

      it("E-9: --allow-protected naming a tenant that is not protected is refused before anything runs", async () => {
        const r = run([...APPLY, ...live, "--allow-protected", qa], {
          env: env(),
          tty: "both",
          input: "DELETE 1 LIVE\n",
        });
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/not protected/);
        expect(await hasKey(qa)).toBe(true);
        expect(await hasKey(acme)).toBe(true);
      });

      it("E-10: without --allow-protected its row is skipped (counted) and the others go", async () => {
        const r = run([...APPLY, ...live], { env: env(), tty: "both", input: "DELETE 1 LIVE\n" });
        expect(r.out).toMatch(/skipped protected 1/);
        expect(r.out).not.toContain(acme);
        expect(r.code).toBe(0);
        expect(await hasKey(qa)).toBe(false);
        expect(await hasKey(acme)).toBe(true);
      });

      it("E-11: a wrong protected phrase is refused BEFORE any delete: both rows stay", async () => {
        const r = run([...APPLY, ...live, "--allow-protected", acme], {
          env: env(),
          tty: "both",
          input: "DELETE 2 LIVE\nALLOW PROTECTED nope\n",
        });
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/override refused/);
        expect(r.out).not.toMatch(/deleted \d/);
        expect(await hasKey(qa)).toBe(true);
        expect(await hasKey(acme)).toBe(true);
        expect(await audits(acme)).toEqual([]);
      });

      it("E-12: both phrases right: both rows are deleted and audited", async () => {
        const r = run([...APPLY, ...live, "--allow-protected", acme], {
          env: env(),
          tty: "both",
          input: `DELETE 2 LIVE\nALLOW PROTECTED ${acme}\n`,
        });
        expect(r.out).toMatch(/deleted 2 key row\(s\)/);
        expect(r.code).toBe(0);
        expect(await hasKey(qa)).toBe(false);
        expect(await hasKey(acme)).toBe(false);
        expect((await audits(acme)).length).toBe(1);
      });
    });
  });
});
