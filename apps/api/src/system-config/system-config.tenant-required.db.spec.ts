/**
 * SA-1102 PR-A (S-8 and the real half of S-11): against a real database. Two throwaway businesses each hold their own
 * `anthropic.apiKey` row. With NO tenant in context `SystemConfigService.get` used to return one of them (the unscoped
 * `findFirst`); it now throws SYSTEM_CONFIG_TENANT_REQUIRED. The plaintext-secret report then counts a legacy plaintext
 * row and not an encrypted one, naming keys and counts only.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-1102-<run>-<n>` slug (`assertTestTenant`).
 */
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { SystemConfigService } from "./system-config.service";
import { PlaintextSecretsReport } from "./plaintext-secrets-report.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const KEY_A = "sk-ant-api03-TENANTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa111";
const KEY_B = "sk-ant-api03-TENANTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBb222";

describeDb("SystemConfigService fails closed without a tenant (SA-1102 S-8)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: SystemConfigService;
  let report: PlaintextSecretsReport;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const encryption = new EncryptionService({ get: () => undefined } as unknown as ConfigService);
    service = new SystemConfigService(prisma, encryption);
    report = new PlaintextSecretsReport(prisma);
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      await prisma.systemConfig.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  async function makeTenant(n: number) {
    const slug = assertTestTenant(
      `qa-1102-${RUN}-${n}`,
      "system-config.tenant-required.db.spec.ts",
    );
    const t = await prisma.tenant.create({ data: { slug, name: `1102 ${slug}` } });
    tenantIds.push(t.id);
    return t.id;
  }

  it("S-8: with two businesses holding a key, a read with no tenant throws and returns neither", async () => {
    const a = await makeTenant(1);
    const b = await makeTenant(2);
    await tenantCtx.run(a, () => service.set("anthropic.apiKey", KEY_A));
    await tenantCtx.run(b, () => service.set("anthropic.apiKey", KEY_B));

    // Each business still reads its OWN key.
    await expect(tenantCtx.run(a, () => service.get("anthropic.apiKey"))).resolves.toBe(KEY_A);
    await expect(tenantCtx.run(b, () => service.get("anthropic.apiKey"))).resolves.toBe(KEY_B);

    // No tenant in context: the unscoped client would have returned one of them.
    const err: any = await tenantCtx
      .run(null, () => service.get("anthropic.apiKey"))
      .then(
        (v) => ({ leaked: v }),
        (e) => e,
      );
    expect(err.leaked).toBeUndefined();
    expect(err.getResponse?.()).toMatchObject({ code: "SYSTEM_CONFIG_TENANT_REQUIRED" });
    await expect(tenantCtx.run(null, () => service.set("anthropic.apiKey", "x"))).rejects.toThrow();
    // Nothing was written by the refused set.
    await expect(tenantCtx.run(a, () => service.get("anthropic.apiKey"))).resolves.toBe(KEY_A);
  });

  it("S-11 (real rows): the report counts a legacy plaintext secret, not an encrypted one", async () => {
    const before = await report.counts();
    const c = await makeTenant(3);
    const d = await makeTenant(4);
    // c: a legacy row written before F5-004 (plaintext). d: written through the service (encrypted).
    await prisma.systemConfig.create({
      data: { tenantId: c, key: "anthropic.apiKey", value: KEY_A },
    });
    await tenantCtx.run(d, () => service.set("anthropic.apiKey", KEY_B));

    const after = await report.counts();
    expect(after.systemConfig["anthropic.apiKey"] ?? 0).toBe(
      (before.systemConfig["anthropic.apiKey"] ?? 0) + 1,
    );
    expect(JSON.stringify(after)).not.toContain("sk-ant");
    expect(JSON.stringify(after)).not.toContain(c);
  });
});
