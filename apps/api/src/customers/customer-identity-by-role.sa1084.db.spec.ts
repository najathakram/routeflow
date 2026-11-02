/**
 * SA-1084: real-Postgres proof that the customer identity columns (tax ID, tobacco license number, authorization
 * license number) reach only the readers that name them, and that each role gets the shape it is meant to:
 *   - SI-1 a driver reads a customer with neither identity value, not even the last 4;
 *   - SI-2 a buyer reading its own row gets `taxIdLast4` only and no customer license;
 *   - SI-3 a staff list carries neither value, the detail carries `taxIdLast4` only;
 *   - SI-6 an edit with no tax ID keeps it, a typed one replaces it, `null` clears it;
 *   - SI-7 a plain include, `customer: true` and a findMany never carry the columns (the class, not four sites);
 *   - SI-9 the staff authorizations tab and the buyer's licenses page still show the license number;
 *   - SI-10 another business's customer is neither readable nor changed.
 *
 * SAFETY: two throwaway `qa-sa1084-<run>-a|b` tenants (`assertTestTenant`). `afterAll` deletes exactly their rows, in
 * FK order. Collected only by `jest.db.config.js`; run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { Logger, NotFoundException } from "@nestjs/common";
import { PrismaClient, UserRole, UserStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CustomersService } from "./customers.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const TAX_ID = "12-3456789";
const TOBACCO_LICENSE = "TL-5550142";
const AUTH_LICENSE = "AUTH-9930017";
const OTHER_TAX_ID = "98-7654321";
const IDENTITY_KEYS = ["taxId", "tobaccoLicenseNo", "licenseNumber"] as const;

function identityValuesIn(value: unknown): string[] {
  const text = JSON.stringify(value);
  return [TAX_ID, TOBACCO_LICENSE, AUTH_LICENSE, OTHER_TAX_ID].filter((v) => text.includes(v));
}

describeDb("SA-1084 — customer identity fields by role on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let customers: CustomersService;
  let authorizations: AuthorizationsService;
  const run = randomUUID().slice(0, 8);
  const slugs = ["a", "b"].map((s) =>
    assertTestTenant(`qa-sa1084-${run}-${s}`, "customer-identity-by-role.sa1084.db.spec.ts"),
  );
  let tenantA = "";
  let tenantB = "";
  let customerA = "";
  let customerAUser = "";
  let customerB = "";
  let categoryId = "";
  let operator: JwtPayload;
  let driver: JwtPayload;
  let buyer: JwtPayload;

  const payload = (sub: string, role: UserRole, tenantId: string): JwtPayload => ({
    sub,
    username: `u-${sub.slice(0, 6)}`,
    role,
    status: UserStatus.ACTIVE,
    forcePasswordChange: false,
    tenantId,
    tenantSlug: tenantId === tenantA ? slugs[0] : slugs[1],
  });

  async function user(tenantId: string, tag: string, role: UserRole) {
    return raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `sa1084-${tag}-${run}`,
        role,
        tenantId,
      },
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    customers = Object.assign(Object.create(CustomersService.prototype), {
      prisma,
      logger: new Logger("sa1084-customers"),
    });
    authorizations = Object.assign(Object.create(AuthorizationsService.prototype), { prisma });
    tenantA = (await raw.tenant.create({ data: { slug: slugs[0], name: `SA1084 ${slugs[0]}` } }))
      .id;
    tenantB = (await raw.tenant.create({ data: { slug: slugs[1], name: `SA1084 ${slugs[1]}` } }))
      .id;

    const buyerUser = await user(tenantA, "buyer", "CUSTOMER");
    customerAUser = buyerUser.id;
    const cA = await raw.customer.create({
      data: {
        userId: buyerUser.id,
        tenantId: tenantA,
        businessName: `SA1084 Acme ${run}`,
        contactName: "Acme Buyer",
        taxId: TAX_ID,
        tobaccoLicenseNo: TOBACCO_LICENSE,
      },
    });
    customerA = cA.id;
    const buyerB = await user(tenantB, "buyerb", "CUSTOMER");
    const cB = await raw.customer.create({
      data: {
        userId: buyerB.id,
        tenantId: tenantB,
        businessName: `SA1084 Other ${run}`,
        contactName: "Other Buyer",
        taxId: OTHER_TAX_ID,
      },
    });
    customerB = cB.id;

    const category = await raw.trackedCategory.create({
      data: { tenantId: tenantA, name: `SA1084 Cat ${run}`, requiresLicense: true },
    });
    categoryId = category.id;
    await raw.customerAuthorization.create({
      data: {
        tenantId: tenantA,
        customerId: customerA,
        trackedCategoryId: categoryId,
        status: "VERIFIED",
        licenseNumber: AUTH_LICENSE,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    });

    operator = payload((await user(tenantA, "op", "OPERATOR")).id, UserRole.OPERATOR, tenantA);
    driver = payload((await user(tenantA, "drv", "DRIVER")).id, UserRole.DRIVER, tenantA);
    buyer = payload(customerAUser, UserRole.CUSTOMER, tenantA);
  }, 120_000);

  afterAll(async () => {
    const tenantId = { in: [tenantA, tenantB].filter(Boolean) };
    await raw.customerAuthorization.deleteMany({ where: { tenantId } });
    await raw.trackedCategory.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  const asTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  it("SI-1: a driver reads a customer with no identity value at all", async () => {
    const row = await asTenant(tenantA, () => customers.findOne(customerA, driver));
    expect(identityValuesIn(row)).toEqual([]);
    for (const k of IDENTITY_KEYS) expect(row).not.toHaveProperty(k);
    expect(row).not.toHaveProperty("taxIdLast4");
    expect(row.businessName).toBe(`SA1084 Acme ${run}`);
  }, 60_000);

  it("SI-2: a buyer reading its own row gets taxIdLast4 only, and no customer license", async () => {
    const mine = await asTenant(tenantA, () => customers.findMyProfile(buyer));
    const viaFindOne = await asTenant(tenantA, () => customers.findOne(customerA, buyer));
    for (const row of [mine, viaFindOne]) {
      expect((row as { taxIdLast4?: string | null }).taxIdLast4).toBe("6789");
      expect(identityValuesIn(row)).toEqual([]);
      for (const k of IDENTITY_KEYS) expect(row).not.toHaveProperty(k);
      expect(row).not.toHaveProperty("tobaccoLicenseLast4");
    }
  }, 60_000);

  it("SI-3: the staff list carries neither value; the detail carries taxIdLast4 only", async () => {
    const list = await asTenant(tenantA, () =>
      customers.findAll({ search: `SA1084 Acme ${run}`, limit: 5 } as never),
    );
    expect(list.data.length).toBe(1);
    expect(identityValuesIn(list)).toEqual([]);
    for (const k of IDENTITY_KEYS) expect(list.data[0]).not.toHaveProperty(k);
    const detail = await asTenant(tenantA, () => customers.findOne(customerA, operator));
    expect((detail as { taxIdLast4?: string | null }).taxIdLast4).toBe("6789");
    expect(identityValuesIn(detail)).toEqual([]);
    for (const k of IDENTITY_KEYS) expect(detail).not.toHaveProperty(k);
  }, 60_000);

  it("SI-6: an edit with no tax ID keeps it, a typed one replaces it, null clears it", async () => {
    const stored = async () =>
      (await raw.customer.findUniqueOrThrow({ where: { id: customerA } })).taxId;
    await asTenant(tenantA, () => customers.update(customerA, { contactName: "Acme Buyer 2" }));
    expect(await stored()).toBe(TAX_ID);
    await asTenant(tenantA, () => customers.update(customerA, { taxId: "55-5555555" }));
    expect(await stored()).toBe("55-5555555");
    await asTenant(tenantA, () => customers.update(customerA, { taxId: null as never }));
    expect(await stored()).toBeNull();
    // put it back for the rows below
    await raw.customer.update({ where: { id: customerA }, data: { taxId: TAX_ID } });
  }, 60_000);

  it("SI-7: a plain read, an include and `customer: true` never carry the columns; naming one still reads it", async () => {
    const db = () => prisma.forTenant();
    await asTenant(tenantA, async () => {
      const plain = await db().customer.findFirstOrThrow({ where: { id: customerA } });
      const many = await db().customer.findMany({ where: { id: customerA } });
      const viaInclude = await db().user.findFirstOrThrow({
        where: { id: customerAUser },
        include: { customer: true },
      });
      for (const v of [plain, many, viaInclude]) {
        expect(identityValuesIn(v)).toEqual([]);
        expect(JSON.stringify(v)).not.toMatch(/taxId|tobaccoLicenseNo/);
      }
      const named = await db().customer.findFirstOrThrow({
        where: { id: customerA },
        select: { taxId: true, tobaccoLicenseNo: true },
      });
      expect(named).toEqual({ taxId: TAX_ID, tobaccoLicenseNo: TOBACCO_LICENSE });
      const optedIn = await db().customer.findFirstOrThrow({
        where: { id: customerA },
        omit: { taxId: false },
      });
      expect(optedIn.taxId).toBe(TAX_ID);
    });
  }, 60_000);

  it("SI-9: the staff authorizations tab and the buyer's licenses page still show the license number", async () => {
    const staff = await asTenant(tenantA, () => authorizations.findForCustomer(customerA));
    expect(staff.map((a) => a.licenseNumber)).toEqual([AUTH_LICENSE]);
    const mine = await asTenant(tenantA, () => authorizations.listForBuyer(customerA));
    expect(JSON.stringify(mine)).toContain(AUTH_LICENSE);
    // a read that does not ask for it never carries it
    const plain = await asTenant(tenantA, () =>
      prisma.forTenant().customerAuthorization.findMany({ where: { customerId: customerA } }),
    );
    expect(JSON.stringify(plain)).not.toContain(AUTH_LICENSE);
  }, 60_000);

  it("SI-10: another business's customer is not readable from this one, and an edit does not reach it", async () => {
    await expect(
      asTenant(tenantA, () => customers.findOne(customerB, operator)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      asTenant(tenantA, () => customers.update(customerB, { taxId: "00-0000000" })),
    ).rejects.toBeInstanceOf(NotFoundException);
    const other = await raw.customer.findUniqueOrThrow({ where: { id: customerB } });
    expect(other.taxId).toBe(OTHER_TAX_ID);
  }, 60_000);
});
