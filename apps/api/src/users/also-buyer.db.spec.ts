/**
 * W-839 / SA-937 MUST 7 — real Postgres: `alsoBuyer` on GET /users/me (UsersService.getMe) is true only for an ACTIVE link
 * of the caller's OWN tenant. Two throwaway tenants: a buyer linked ONLY to tenant B never makes tenant A's driver
 * `alsoBuyer` (the cross-tenant-oracle guard, SA-937 §3). Then, in tenant A, every non-qualifying buyer / link / customer
 * state is false and only the email's case may differ.
 *
 * Run via `npm run local:test:db`. Tenants are `qa-alsobuyer-<run>-a|b` slugs approved by `assertTestTenant`; afterAll
 * deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { CustomerLinkStatus, Prisma, UserRole, UserStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { UsersService } from "./users.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "also-buyer.db.spec.ts";
const RUN = randomUUID().slice(0, 8);
const EMAIL = `sam-${RUN}@example.invalid`;

describeDb("users: alsoBuyer is an ACTIVE buyer link of THIS tenant only (SA-937)", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let users: UsersService;
  let tenantA: string;
  let tenantB: string;
  let driverId: string;
  let buyerId: string;
  let customerA: string;
  let customerB: string;

  const me = () => ctx.run(tenantA, () => users.getMe(driverId)) as Promise<any>;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    users = new UsersService(prisma, {} as never, { get: () => ({}) } as never);
    const a = assertTestTenant(`qa-alsobuyer-${RUN}-a`, SPEC);
    const b = assertTestTenant(`qa-alsobuyer-${RUN}-b`, SPEC);
    tenantA = (await prisma.tenant.create({ data: { slug: a, name: `Also buyer ${a}` } })).id;
    tenantB = (await prisma.tenant.create({ data: { slug: b, name: `Also buyer ${b}` } })).id;
    driverId = (
      await prisma.user.create({
        data: {
          tenantId: tenantA,
          username: `driver-${RUN}`,
          email: EMAIL,
          role: UserRole.DRIVER,
          status: UserStatus.ACTIVE,
        },
      })
    ).id;
    // Stored in a different case: the match is case-insensitive (Google / Apple buyer rows may not be lowercased).
    buyerId = (
      await prisma.buyerAccount.create({
        data: { email: EMAIL.toUpperCase(), passwordHash: "x", name: "Sam", emailVerified: true },
      })
    ).id;
    const mkCustomer = async (tenantId: string, tag: string) => {
      const owner = await prisma.user.create({
        data: {
          tenantId,
          username: `cust-${tag}-${RUN}`,
          email: `cust-${tag}-${RUN}@example.invalid`,
          role: UserRole.CUSTOMER,
        },
      });
      return (
        await prisma.customer.create({
          data: { tenantId, userId: owner.id, businessName: `${tag} ${RUN}`, contactName: tag },
        })
      ).id;
    };
    customerA = await mkCustomer(tenantA, "a");
    customerB = await mkCustomer(tenantB, "b");
  }, 120_000);

  afterAll(async () => {
    await prisma.customerLink.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB].filter(Boolean) } },
    });
    await prisma.customer.deleteMany({
      where: { id: { in: [customerA, customerB].filter(Boolean) } },
    });
    if (buyerId) await prisma.buyerAccount.deleteMany({ where: { id: buyerId } });
    await prisma.user.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB].filter(Boolean) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } });
    await prisma?.$disconnect();
  }, 120_000);

  const resetBuyer = () =>
    prisma.buyerAccount.update({
      where: { id: buyerId },
      data: { status: "ACTIVE", emailVerified: true, deletedAt: null, mergedIntoId: null },
    });
  const linkIn = async (tenantId: string, customerId: string, status: CustomerLinkStatus) => {
    await prisma.customerLink.deleteMany({ where: { customerId } });
    await prisma.customerLink.create({
      data: { tenantId, customerId, buyerAccountId: buyerId, status },
    });
  };
  const clearLinks = () =>
    prisma.customerLink.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });

  beforeEach(async () => {
    await clearLinks();
    await resetBuyer();
    await prisma.customer.update({ where: { id: customerA }, data: { deletedAt: null } });
  });

  it("an ACTIVE link ONLY in tenant B: tenant A's driver is not alsoBuyer (no cross-tenant oracle)", async () => {
    await linkIn(tenantB, customerB, CustomerLinkStatus.ACTIVE);
    expect((await me()).alsoBuyer).toBe(false);
  });

  it("an ACTIVE link in tenant A, the email differing only in case: alsoBuyer", async () => {
    await linkIn(tenantA, customerA, CustomerLinkStatus.ACTIVE);
    expect((await me()).alsoBuyer).toBe(true);
  });

  it.each([
    CustomerLinkStatus.INVITED,
    CustomerLinkStatus.PENDING_SELLER_APPROVAL,
    CustomerLinkStatus.DISCONNECTED,
  ])("a %s link is not alsoBuyer", async (status) => {
    await linkIn(tenantA, customerA, status);
    expect((await me()).alsoBuyer).toBe(false);
  });

  it.each<[string, Prisma.BuyerAccountUpdateInput]>([
    ["unverified", { emailVerified: false }],
    ["SUSPENDED", { status: "SUSPENDED" }],
    ["deleted", { deletedAt: new Date() }],
    ["merged", { mergedIntoId: randomUUID() }],
  ])("a %s buyer is not alsoBuyer", async (_label, data) => {
    await linkIn(tenantA, customerA, CustomerLinkStatus.ACTIVE);
    await prisma.buyerAccount.update({ where: { id: buyerId }, data });
    expect((await me()).alsoBuyer).toBe(false);
  });

  it("a deleted customer is not alsoBuyer", async () => {
    await linkIn(tenantA, customerA, CustomerLinkStatus.ACTIVE);
    await prisma.customer.update({ where: { id: customerA }, data: { deletedAt: new Date() } });
    expect((await me()).alsoBuyer).toBe(false);
  });
});
