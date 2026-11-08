/**
 * AI limits PR-2: `encrypt-legacy-secrets` core against a real database (owner 2026-11-05: never store keys
 * unencrypted). Runs only under `npm run local:test:db`; tenants are throwaway `qa-legsec-<run>-<n>` slugs and the
 * PlatformConfig `claude.apiKey` row is restored afterwards.
 */
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { EncryptionService } from "../common/encryption.service";
import { ENCRYPTED_FORMAT, decryptIfSecret } from "../common/secret-at-rest";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PLATFORM_SECRET_KEYS } from "../platform-admin/platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SECRET_KEYS } from "./system-config.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require("../../scripts/lib/legacy-secrets-core.cjs");

type Ref = { table: string; id: string; tenantId: string | null; key: string };
const RUN = randomUUID().slice(0, 8);
const PLAIN_SMTP = "smtp-pass-PLAINTEXT-1111";
const PLAIN_ANTHROPIC = "sk-ant-api03-PLAINPLAINPLAINPLAINPLAINPLAIN2222";
const PLAIN_CLAUDE = "sk-ant-api03-PLATFORMPLATFORMPLATFORMPLATFORM3333";

describeDb("encrypt-legacy-secrets core (AI limits PR-2)", () => {
  let prisma: PrismaService;
  let pool: Pool;
  let cipher: EncryptionService;
  let priorClaude: string | null = null;
  const tenantIds: string[] = [];
  const out: string[] = [];
  const log = (line: string) => out.push(line);

  const config = (k: string) => (k === "ENCRYPTION_KEY" ? "ab".repeat(32) : undefined);

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    pool = new Pool({ connectionString: url });
    cipher = new EncryptionService({ get: config } as unknown as ConfigService);
    const rows = await pool.query(`SELECT value FROM "PlatformConfig" WHERE key = 'claude.apiKey'`);
    priorClaude = rows.rows[0]?.value ?? null;
    await pool.query(`DELETE FROM "PlatformConfig" WHERE key = 'claude.apiKey'`);
  });

  afterAll(async () => {
    const swallow = () => undefined;
    await pool.query(`DELETE FROM "PlatformConfig" WHERE key = 'claude.apiKey'`).catch(swallow);
    if (priorClaude !== null) {
      await pool
        .query(
          `INSERT INTO "PlatformConfig" ("id","key","value","updatedAt") VALUES (gen_random_uuid()::text, 'claude.apiKey', $1, now())`,
          [priorClaude],
        )
        .catch(swallow);
    }
    for (const id of tenantIds) await prisma.tenant.delete({ where: { id } }).catch(swallow);
    await pool?.end();
    await prisma?.$disconnect();
  });

  async function makeTenant(n: number) {
    const slug = assertTestTenant(`qa-legsec-${RUN}-${n}`, "legacy-secrets.db.spec.ts");
    const t = await prisma.tenant.create({ data: { slug, name: `legsec ${slug}` } });
    tenantIds.push(t.id);
    return t.id;
  }
  const put = (tenantId: string, key: string, value: string) =>
    pool.query(
      `INSERT INTO "SystemConfig" ("id","tenantId","key","value","updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, now())`,
      [tenantId, key, value],
    );
  const read = async (tenantId: string, key: string) =>
    (
      await pool.query(`SELECT value FROM "SystemConfig" WHERE "tenantId" = $1 AND key = $2`, [
        tenantId,
        key,
      ])
    ).rows[0]?.value as string;
  const mine = (refs: Ref[]) => refs.filter((r) => r.tenantId && tenantIds.includes(r.tenantId));

  // this spec's own rows (its tenants plus the platform row it seeded), never another tenant's
  const scoped = async (): Promise<Ref[]> => {
    const all: Ref[] = await core.plaintextRefs(pool);
    return [...mine(all), ...all.filter((r) => r.table === "PlatformConfig")];
  };
  const audits = async (tenantId: string | null) =>
    (
      await pool.query(
        `SELECT meta FROM "AuditLog" WHERE "tenantId" IS NOT DISTINCT FROM $1 AND action = $2`,
        [tenantId, core.AUDIT_ACTION],
      )
    ).rows;

  it("L-1: it finds exactly the plaintext secret rows, by reference, never reading a value", async () => {
    const t = await makeTenant(1);
    await put(t, "email.smtpPassword", PLAIN_SMTP);
    await put(t, "anthropic.apiKey", cipher.encrypt(PLAIN_ANTHROPIC)); // already encrypted
    await put(t, "zoho.clientSecret", ""); // cleared sentinel
    await put(t, "brand.primaryColor", "#123456"); // not a secret key
    await pool.query(
      `INSERT INTO "PlatformConfig" ("id","key","value","updatedAt") VALUES (gen_random_uuid()::text, 'claude.apiKey', $1, now())`,
      [PLAIN_CLAUDE],
    );
    const refs = await core.plaintextRefs(pool);
    const found = [
      ...mine(refs),
      ...refs.filter((r: { table: string }) => r.table === "PlatformConfig"),
    ];
    expect(found.map((r: { key: string }) => r.key).sort()).toEqual([
      "claude.apiKey",
      "email.smtpPassword",
    ]);
    expect(JSON.stringify(refs)).not.toContain(PLAIN_SMTP);
    expect(JSON.stringify(refs)).not.toContain(PLAIN_CLAUDE);
  });

  it("L-2: a dry run (apply: false) changes nothing", async () => {
    const before = await read(tenantIds[0], "email.smtpPassword");
    const res = await core.encryptAll({
      client: pool,
      cipher,
      refs: await scoped(),
      apply: false,
      log,
    });
    expect(res).toMatchObject({ encrypted: 0 });
    expect(res.wouldEncrypt).toBeGreaterThanOrEqual(2);
    expect(await read(tenantIds[0], "email.smtpPassword")).toBe(before);
    expect(await audits(tenantIds[0])).toEqual([]);
  });

  it("L-3: apply rewrites each plaintext row to the cipher shape that decrypts to the original; others are untouched", async () => {
    const t = tenantIds[0];
    const encryptedBefore = await read(t, "anthropic.apiKey");
    const refs = await scoped();
    const res = await core.encryptAll({ client: pool, cipher, refs, apply: true, log });
    expect(res).toMatchObject({ failed: 0, skippedProtected: 0, encrypted: 2 });
    const smtp = await read(t, "email.smtpPassword");
    expect(smtp).toMatch(ENCRYPTED_FORMAT);
    // the production read path (the helper SystemConfigService.get / PlatformConfigService.getValue call)
    expect(decryptIfSecret(SECRET_KEYS, cipher, "email.smtpPassword", smtp)).toBe(PLAIN_SMTP);
    const claude = (
      await pool.query(`SELECT value FROM "PlatformConfig" WHERE key = 'claude.apiKey'`)
    ).rows[0].value;
    expect(claude).toMatch(ENCRYPTED_FORMAT);
    expect(decryptIfSecret(PLATFORM_SECRET_KEYS, cipher, "claude.apiKey", claude)).toBe(
      PLAIN_CLAUDE,
    );
    // one audit row per encrypted row, in the same transaction: the key name only, never a value
    expect((await audits(t)).map((a) => a.meta)).toEqual([
      { key: "email.smtpPassword", actor: "script" },
    ]);
    expect((await audits(null)).map((a) => a.meta)).toEqual([
      { key: "claude.apiKey", actor: "script" },
    ]);
    expect(await read(t, "anthropic.apiKey")).toBe(encryptedBefore); // byte-identical
    expect(await read(t, "zoho.clientSecret")).toBe("");
    expect(await read(t, "brand.primaryColor")).toBe("#123456");
  });

  it("L-4: a second run finds nothing for these rows (idempotent)", async () => {
    const refs = await core.plaintextRefs(pool);
    expect(
      mine(refs).length +
        refs.filter((r: { table: string }) => r.table === "PlatformConfig").length,
    ).toBe(0);
  });

  it("L-5: a protected tenant's row is skipped and counted unless that tenant is allowed by id", async () => {
    const guarded = await makeTenant(2);
    await put(guarded, "zoho.refreshToken", "zoho-refresh-PLAINTEXT-4444");
    const refs = mine(await core.plaintextRefs(pool));
    const run = (allowProtected: Set<string>) =>
      core.encryptAll({
        client: pool,
        cipher,
        refs,
        apply: true,
        protectedIds: new Set([guarded]),
        allowProtected,
        log,
      });
    expect(await run(new Set())).toMatchObject({ encrypted: 0, skippedProtected: 1 });
    expect(await read(guarded, "zoho.refreshToken")).toBe("zoho-refresh-PLAINTEXT-4444");
    expect(await run(new Set([guarded]))).toMatchObject({ encrypted: 1, skippedProtected: 0 });
    expect(cipher.decrypt(await read(guarded, "zoho.refreshToken"))).toBe(
      "zoho-refresh-PLAINTEXT-4444",
    );
  });

  it("L-6: a row changed by someone else between the read and the write is left alone (compare and swap)", async () => {
    const t = await makeTenant(3);
    await put(t, "email.smtpPassword", "first-PLAINTEXT-5555");
    const [ref] = mine(await core.plaintextRefs(pool));
    // the writer re-saved the secret (encrypted) after the plan was made: nothing to do for this row
    await pool.query(`UPDATE "SystemConfig" SET value = $1 WHERE id = $2`, [
      cipher.encrypt("second"),
      ref.id,
    ]);
    const res = await core.encryptAll({ client: pool, cipher, refs: [ref], apply: true, log });
    expect(res).toMatchObject({ encrypted: 0, already: 1 });
    expect(cipher.decrypt(await read(t, "email.smtpPassword"))).toBe("second");
  });

  it("L-7: a cipher that will not round-trip fails the row, which stays plaintext, and the run reports it", async () => {
    const t = await makeTenant(4);
    await put(t, "email.smtpPassword", "third-PLAINTEXT-6666");
    const refs = mine(await core.plaintextRefs(pool));
    const broken = { encrypt: (s: string) => cipher.encrypt(s), decrypt: () => "not the original" };
    const res = await core.encryptAll({ client: pool, cipher: broken, refs, apply: true, log });
    expect(res).toMatchObject({ encrypted: 0, failed: 1 });
    expect(await read(t, "email.smtpPassword")).toBe("third-PLAINTEXT-6666");
    expect(await audits(t)).toEqual([]);
  });
});
