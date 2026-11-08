/**
 * AI limits PR-2 (SA-1102 §4, owner ruling 2026-11-05 "never store keys unencrypted"): `encrypt-legacy-secrets` against a
 * real database. Secret config rows written before encryption exist (plaintext) beside encrypted ones; the core finds
 * them without reading a value, and `--apply` rewrites each plaintext row through the real `EncryptionService`: one row
 * per transaction, row-locked, decrypt-verified before the UPDATE, compare-and-swap on the old value, so a second run
 * finds nothing and the encrypted rows are never touched.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-legsec-<run>-<n>` slug (`assertTestTenant`);
 * the PlatformConfig `claude.apiKey` row is restored afterwards.
 */
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { EncryptionService } from "../common/encryption.service";
import { ENCRYPTED_FORMAT } from "../common/secret-at-rest";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require("../../scripts/lib/legacy-secrets-core.cjs");

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
  const mine = (refs: Array<{ tenantId: string | null }>) =>
    refs.filter((r) => r.tenantId && tenantIds.includes(r.tenantId));

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
    const t = tenantIds[0];
    const before = await read(t, "email.smtpPassword");
    const refs = await core.plaintextRefs(pool);
    const res = await core.encryptAll({ client: pool, cipher, refs, apply: false, log });
    expect(res.encrypted).toBe(0);
    expect(res.wouldEncrypt).toBeGreaterThanOrEqual(2);
    expect(await read(t, "email.smtpPassword")).toBe(before);
  });

  it("L-3: apply rewrites each plaintext row to the cipher shape that decrypts to the original; others are untouched", async () => {
    const t = tenantIds[0];
    const encryptedBefore = await read(t, "anthropic.apiKey");
    const refs = await core.plaintextRefs(pool);
    const res = await core.encryptAll({ client: pool, cipher, refs, apply: true, log });
    expect(res).toMatchObject({ failed: 0, skippedProtected: 0 });
    expect(res.encrypted).toBeGreaterThanOrEqual(2);
    const smtp = await read(t, "email.smtpPassword");
    expect(smtp).toMatch(ENCRYPTED_FORMAT);
    expect(cipher.decrypt(smtp)).toBe(PLAIN_SMTP);
    const claude = (
      await pool.query(`SELECT value FROM "PlatformConfig" WHERE key = 'claude.apiKey'`)
    ).rows[0].value;
    expect(claude).toMatch(ENCRYPTED_FORMAT);
    expect(cipher.decrypt(claude)).toBe(PLAIN_CLAUDE);
    expect(await read(t, "anthropic.apiKey")).toBe(encryptedBefore); // byte-identical
    expect(await read(t, "zoho.clientSecret")).toBe("");
    expect(await read(t, "brand.primaryColor")).toBe("#123456");
  });

  it("L-4: a second run finds nothing for these rows (idempotent)", async () => {
    const refs = await core.plaintextRefs(pool);
    expect(mine(refs)).toEqual([]);
    expect(refs.filter((r: { table: string }) => r.table === "PlatformConfig")).toEqual([]);
  });

  it("L-5: a protected tenant's row is skipped and counted unless that tenant is allowed by id", async () => {
    const guarded = await makeTenant(2);
    await put(guarded, "zoho.refreshToken", "zoho-refresh-PLAINTEXT-4444");
    const refs = mine(await core.plaintextRefs(pool));
    const skipped = await core.encryptAll({
      client: pool,
      cipher,
      refs,
      apply: true,
      protectedIds: new Set([guarded]),
      allowProtected: new Set(),
      log,
    });
    expect(skipped).toMatchObject({ encrypted: 0, skippedProtected: 1 });
    expect(await read(guarded, "zoho.refreshToken")).toBe("zoho-refresh-PLAINTEXT-4444");
    const allowed = await core.encryptAll({
      client: pool,
      cipher,
      refs,
      apply: true,
      protectedIds: new Set([guarded]),
      allowProtected: new Set([guarded]),
      log,
    });
    expect(allowed).toMatchObject({ encrypted: 1, skippedProtected: 0 });
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
  });

  it("L-8: nothing the run logged carries a secret value", () => {
    const logged = out.join("\n");
    for (const v of [PLAIN_SMTP, PLAIN_ANTHROPIC, PLAIN_CLAUDE, "PLAINTEXT"])
      expect(logged).not.toContain(v);
  });
});
