/**
 * AI limits PR-2: how `encrypt-legacy-secrets.mjs` WIRES its gates, run as a child process against the lane database
 * (needs `npm run build -w apps/api`: the CLI loads dist/common/encryption.service.js). Each refusal must leave the
 * plaintext row exactly as it was; deleting a gate from the CLI turns a case red. Tenants are throwaway `qa-legcli-*`
 * slugs, plus ONE non-test tenant for the "a local-looking host holding a live tenant is live" case, removed after.
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

const SCRIPT = path.resolve(__dirname, "../../scripts/encrypt-legacy-secrets.mjs");
const RUN = randomUUID().slice(0, 8);
const KEY = "cd".repeat(32);
const OTHER_KEY = "ef".repeat(32);
const PLAIN = "smtp-pass-CLI-PLAINTEXT-7777";

describeDb("encrypt-legacy-secrets CLI gate wiring (AI limits PR-2)", () => {
  let prisma: PrismaService;
  let pool: Pool;
  let url: string;
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
  });

  afterAll(async () => {
    for (const id of tenantIds)
      await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
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

  it("C-4: the right key on a local test-only database encrypts, and the production reader gets the original back", async () => {
    const t = await seed(`qa-legcli-${RUN}-4`, PLAIN, cipher(KEY).encrypt("proof"));
    const r = run(["--apply"], { ENCRYPTION_KEY: KEY });
    expect(r.out).not.toContain(PLAIN);
    expect(r.code).toBe(0);
    const stored = await read(t);
    expect(stored).not.toBe(PLAIN);
    expect(decryptIfSecret(SECRET_KEYS, cipher(KEY), "email.smtpPassword", stored)).toBe(PLAIN);
  });

  it("C-5: a local-looking host that holds a non-test tenant is live: --apply needs the override", async () => {
    const t = await seed(`qa-legcli-${RUN}-5`, PLAIN, cipher(KEY).encrypt("proof"));
    const live = await prisma.tenant.create({ data: { slug: `acme-legcli-${RUN}`, name: "acme" } });
    tenantIds.push(live.id);
    const r = run(["--apply"], { ENCRYPTION_KEY: KEY });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/treated as live/);
    expect(r.out).toMatch(/--live-tenant-override/);
    expect(await read(t)).toBe(PLAIN);
  });
});
