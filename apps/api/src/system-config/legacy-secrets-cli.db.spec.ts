/**
 * AI limits PR-2: how `encrypt-legacy-secrets.mjs` WIRES its gates, run as a child process against the lane database
 * (needs `npm run build -w apps/api`: the CLI loads dist/common/encryption.service.js). Each refusal must leave the
 * plaintext row exactly as it was; deleting a gate from the CLI turns a case red. Tenants are throwaway `qa-legcli-*`
 * slugs, plus ONE non-test tenant for the "a local-looking host holding a live tenant is live" cases (last, removed
 * after). The lane database must hold no other plaintext secret row: the CLI works over the whole database.
 */
import { ConfigService } from "@nestjs/config";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { Pool } from "pg";
import { EncryptionService } from "../common/encryption.service";
import { decryptIfSecret } from "../common/secret-at-rest";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SECRET_KEYS } from "./system-config.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require("../../scripts/lib/legacy-secrets-core.cjs");

const SCRIPT = path.resolve(__dirname, "../../scripts/encrypt-legacy-secrets.mjs");
const RUN = randomUUID().slice(0, 8);
const KEY = "cd".repeat(32);
const OTHER_KEY = "ef".repeat(32);
const PLAIN = "smtp-pass-CLI-PLAINTEXT-7777";

describeDb("encrypt-legacy-secrets CLI gate wiring (AI limits PR-2)", () => {
  let prisma: PrismaService;
  let pool: Pool;
  let url: string;
  let priorClaude: string | null = null;
  const tenantIds: string[] = [];
  const cipher = (hex: string) =>
    new EncryptionService({
      get: (k: string) => (k === "ENCRYPTION_KEY" ? hex : undefined),
    } as unknown as ConfigService);

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    pool = new Pool({ connectionString: url });
    const rows = await pool.query(`SELECT value FROM "PlatformConfig" WHERE key = 'claude.apiKey'`);
    priorClaude = rows.rows[0]?.value ?? null;
    await pool.query(`DELETE FROM "PlatformConfig" WHERE key = 'claude.apiKey'`);
    const foreign = await core.plaintextRefs(pool);
    if (foreign.length > 0)
      throw new Error(
        `${foreign.length} plaintext secret row(s) not made by this spec: use a throwaway database`,
      );
  });

  afterAll(async () => {
    const swallow = () => undefined;
    await pool.query(`DELETE FROM "PlatformConfig" WHERE key = 'claude.apiKey'`).catch(swallow);
    if (priorClaude !== null)
      await pool
        .query(
          `INSERT INTO "PlatformConfig" ("id","key","value","updatedAt") VALUES (gen_random_uuid()::text, 'claude.apiKey', $1, now())`,
          [priorClaude],
        )
        .catch(swallow);
    for (const id of tenantIds) await prisma.tenant.delete({ where: { id } }).catch(swallow);
    await pool?.end();
    await prisma?.$disconnect();
  });

  async function seed(slug: string, plain: string, canary?: string) {
    const t = await prisma.tenant.create({ data: { slug, name: `legcli ${slug}` } });
    tenantIds.push(t.id);
    const put = (key: string, value: string) =>
      pool.query(
        `INSERT INTO "SystemConfig" ("id","tenantId","key","value","updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, now())`,
        [t.id, key, value],
      );
    await put("email.smtpPassword", plain);
    if (canary) await put("zoho.clientSecret", canary);
    return t.id;
  }
  const read = async (tenantId: string) =>
    (
      await pool.query(
        `SELECT value FROM "SystemConfig" WHERE "tenantId" = $1 AND key = 'email.smtpPassword'`,
        [tenantId],
      )
    ).rows[0].value as string;
  const audits = async (tenantId: string) =>
    (
      await pool.query(`SELECT meta FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2`, [
        tenantId,
        core.AUDIT_ACTION,
      ])
    ).rows;
  function run(args: string[], env: Record<string, string> = {}) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, ...env };
    if (!("ENCRYPTION_KEY" in env)) delete childEnv.ENCRYPTION_KEY;
    const r = spawnSync("node", [SCRIPT, ...args], {
      encoding: "utf8",
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
  }

  it("C-1: no 64-hex ENCRYPTION_KEY (the dev placeholder) is refused, even on a local test-only database", async () => {
    const t = await seed(`qa-legcli-${RUN}-1`, PLAIN);
    const r = run(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/64-hex/);
    expect(await read(t)).toBe(PLAIN);
  });

  it("C-2: a key that cannot read a ciphertext already stored is refused before any write", async () => {
    const t = await seed(`qa-legcli-${RUN}-2`, PLAIN, cipher(KEY).encrypt("proof"));
    const r = run(["--apply"], { ENCRYPTION_KEY: OTHER_KEY });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not the API's key/);
    expect(await read(t)).toBe(PLAIN);
  });

  it("C-3: --allow-protected naming a tenant that is not protected is refused", async () => {
    const t = await seed(`qa-legcli-${RUN}-3`, PLAIN, cipher(KEY).encrypt("proof"));
    const r = run(["--apply", "--allow-protected", t], { ENCRYPTION_KEY: KEY });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not protected/);
    expect(await read(t)).toBe(PLAIN);
  });

  it("C-4: a dry run changes nothing and writes no audit row, with or without a key", async () => {
    const t = await seed(`qa-legcli-${RUN}-4`, PLAIN);
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/would encrypt/);
    expect(r.out).not.toContain(PLAIN);
    expect(await read(t)).toBe(PLAIN);
    expect(await audits(t)).toEqual([]);
  });

  it("C-5: the right key on a local test-only database encrypts, audits each row by key name, and the production reader gets the original back", async () => {
    const t = await seed(`qa-legcli-${RUN}-5`, PLAIN, cipher(KEY).encrypt("proof"));
    const r = run(["--apply"], { ENCRYPTION_KEY: KEY });
    expect(r.out).not.toContain(PLAIN);
    expect(r.code).toBe(0);
    const stored = await read(t);
    expect(stored).not.toBe(PLAIN);
    expect(decryptIfSecret(SECRET_KEYS, cipher(KEY), "email.smtpPassword", stored)).toBe(PLAIN);
    expect((await audits(t)).map((a) => a.meta)).toEqual([
      { key: "email.smtpPassword", actor: "script" },
    ]);
  });

  describe("a local-looking host that holds a non-test tenant (a tunnel to production) is live", () => {
    let live: { id: string };
    let t: string;
    const liveSlug = `acme-legcli-${RUN}`;

    beforeAll(async () => {
      t = await seed(`qa-legcli-${RUN}-6`, PLAIN, cipher(KEY).encrypt("proof"));
      live = await prisma.tenant.create({ data: { slug: liveSlug, name: "acme" } });
      tenantIds.push(live.id);
    });

    it("C-6: --apply needs the override, then the backup, then a real terminal; each leaves the row plaintext", async () => {
      const gates: [string[], RegExp][] = [
        [[], /--live-tenant-override/],
        [["--live-tenant-override"], /--backup-taken/],
        [["--live-tenant-override", "--backup-taken"], /real terminal/],
      ];
      for (const [flags, refusal] of gates) {
        const r = run(["--apply", ...flags], { ENCRYPTION_KEY: KEY });
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/treated as live/);
        expect(r.out).toMatch(refusal);
        expect(await read(t)).toBe(PLAIN);
      }
      expect(await audits(t)).toEqual([]);
    });

    it("C-7: a protected non-test tenant on a local-looking host ends the run, override or not, and no id is printed", async () => {
      const r = run(["--apply", "--live-tenant-override", "--backup-taken"], {
        ENCRYPTION_KEY: KEY,
        PROTECTED_TENANT_SLUGS: liveSlug,
      });
      // The refusal itself, not its wording: the CLI scrubs the database password out of every error it throws, and CI's
      // password is the word "test" (db-migrations.yml), so "non-test" reaches the log as "non-***". The run ends with
      // exit 1 BEFORE any later gate speaks, nothing is written, and no id is printed; the one fact it states is a count.
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/env-listed 1/);
      expect(r.out).not.toMatch(
        /treated as live|real terminal|--backup-taken|encrypted \d|would encrypt/,
      );
      expect(r.out).not.toContain(live.id);
      expect(await read(t)).toBe(PLAIN);
      expect(await audits(t)).toEqual([]);
    });
  });
});
