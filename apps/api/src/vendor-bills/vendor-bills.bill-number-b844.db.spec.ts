/**
 * B844 against real Postgres (DB lane; run by the prover on the compose DB, the builder does not run it).
 * Twelve concurrent creates under one tenant must all succeed with twelve DISTINCT BILL numbers. Before the fix the
 * number was read outside the creating tx, so concurrent creates read the same last number and all but one failed on
 * @@unique([tenantId, billNumber]).
 *
 * SAFETY: one throwaway `qa-b844-<sfx>` tenant (`assertTestTenant`); `afterAll` deletes exactly its rows.
 */
import { randomUUID } from "crypto";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("sharp", () => ({ __esModule: true, default: jest.fn() }));

import { VendorBillsService } from "./vendor-bills.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "vendor-bills.bill-number-b844.db.spec.ts";
const sfx = randomUUID().slice(0, 8);
const TENANT = `qa-b844-${sfx}-tenant`;
const SLUG = assertTestTenant(`qa-b844-${sfx}`, SPEC);

describeDb("B844 concurrent vendor bill creates mint distinct numbers (real Postgres)", () => {
  let tenantCtx: TenantContextService;
  let prisma: PrismaService;
  let service: VendorBillsService;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const stub = (o: object) => o as any;
    service = new VendorBillsService(
      prisma,
      stub({ get: jest.fn().mockResolvedValue(null), getAll: jest.fn().mockResolvedValue({}) }),
      stub({}),
      stub({
        normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
        findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
        findScanDuplicate: jest.fn().mockResolvedValue(null),
      }),
      stub({}),
      stub({}),
      stub({}),
    );
    await prisma.tenant.create({ data: { id: TENANT, slug: SLUG, name: `ACME ${SLUG}` } });
  });

  afterAll(async () => {
    await prisma.vendorBillItem.deleteMany({ where: { tenantId: TENANT } }).catch(() => undefined);
    await prisma.vendorBill.deleteMany({ where: { tenantId: TENANT } }).catch(() => undefined);
    await prisma.tenantConfig.deleteMany({ where: { tenantId: TENANT } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("twelve concurrent creates all succeed with twelve distinct billNumbers", async () => {
    const make = (i: number) =>
      tenantCtx.run(TENANT, () =>
        service.create({
          items: [{ description: `Sample line ${i}`, qty: 1, unitCost: 10 }],
          allowDuplicate: true,
        } as any),
      );
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => make(i)));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const numbers = results.map((r) => (r as PromiseFulfilledResult<any>).value.billNumber);
    expect(new Set(numbers).size).toBe(12);
  });
});
