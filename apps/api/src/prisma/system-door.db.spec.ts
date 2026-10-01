import { randomUUID } from "crypto";
import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TenantContextGuard, TenantContextMissingError } from "../tenant/tenant-context-guard";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/**
 * SA-619 PR-2b/2c (real PG): the system door against a real database. The forSystem client's array
 * `$transaction` really commits both statements with NO tenant context under an ENFORCING guard; the
 * bare client's array form is refused before anything is sent; systemTransaction commits a tenant-owned
 * write that names its tenant and refuses (writing nothing) one that does not.
 * Run by the F prover / F2 (needs the local compose DB).
 */
const RUN = randomUUID().slice(0, 8);

describeDb("system door on a real database (SA-619 PR-2b)", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  const slugs: string[] = [];

  const slug = (label: string) => {
    const s = assertTestTenant(`qa-619-${RUN}-${label}`, "system-door.db.spec.ts");
    slugs.push(s);
    return s;
  };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(
      ctx,
      new TenantContextGuard({ enforce: true, log: { warn: jest.fn() } }),
    );
    await prisma.$connect();
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const s of slugs) {
      const t = await prisma.tenant.findUnique({ where: { slug: s } }).catch(swallow);
      if (t) {
        await prisma.customer.deleteMany({ where: { tenantId: t.id } }).catch(swallow);
        await prisma.user.deleteMany({ where: { tenantId: t.id } }).catch(swallow);
        await prisma.tenant.delete({ where: { id: t.id } }).catch(swallow);
      }
    }
    await prisma?.$disconnect();
  });

  it("the forSystem client's array $transaction commits both writes with no tenant context, enforced", async () => {
    const a = slug("arr-a");
    const b = slug("arr-b");
    const out = await prisma
      .forSystem("test: array transaction through the system door")
      .$transaction([
        prisma.tenant.create({ data: { slug: a, name: a } }),
        prisma.tenant.create({ data: { slug: b, name: b } }),
      ]);
    expect(out).toHaveLength(2);
    expect(await prisma.tenant.count({ where: { slug: { in: [a, b] } } })).toBe(2);
  }, 60_000);

  it("the bare client's array $transaction with no context is refused before anything is sent", async () => {
    const s = slug("arr-refused");
    await expect(
      prisma.$transaction([prisma.tenant.create({ data: { slug: s, name: s } })]),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(await prisma.tenant.count({ where: { slug: s } })).toBe(0);
  }, 60_000);

  it("systemTransaction: a tenant-owned write naming its tenant commits; one that does not is refused and writes nothing", async () => {
    const s = slug("sys");
    const tenant = await prisma.tenant.create({ data: { slug: s, name: s } });
    const user = await prisma.systemTransaction("test: seed a user through the system door", (tx) =>
      tx.user.create({
        data: { email: `${s}@example.invalid`, username: s, role: "CUSTOMER", tenantId: tenant.id },
      }),
    );
    expect(user.tenantId).toBe(tenant.id);
    const u2 = `${s}-2`;
    await expect(
      prisma.systemTransaction("test: a create with no tenant", (tx) =>
        tx.user.create({
          data: { email: `${u2}@example.invalid`, username: u2, role: "CUSTOMER" },
        }),
      ),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(await prisma.user.count({ where: { username: u2 } })).toBe(0);
  }, 60_000);
});
