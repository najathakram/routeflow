/**
 * Addendum D, Branch B — DB lane for the customers-without-a-state card: GET buckets, POST bulk-state
 * and its undo, PATCH state / POST minimal.
 * What a mocked prisma cannot prove: the bucket query's relation filters and keyset run against the
 * schema; the bulk write (createMany + updateMany + audit row) really shares ONE Postgres transaction
 * (a failure after the writes leaves nothing); `@updatedAt` moves on updateMany, so the undo's
 * "untouched since" guard holds and a repeat undo restores 0; the undo's deleteMany relation filter
 * (no route stop) runs; another tenant's customers and addresses are never written.
 *
 * Run via `npm run local:test:db`. Every tenant is a throwaway `qa-ustate-<run>-*` slug approved by
 * `assertTestTenant`, and afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { NotFoundException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CustomerAddressStateService } from "../customers/customer-address-state.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AUDIT_BULK_STATE_SET, UnknownStateBulkService } from "./unknown-state-bulk.service";
import { UnknownStateCustomersService } from "./unknown-state-customers.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const op = { sub: "u-ustate-op", username: "ustate-operator" } as JwtPayload;
const SPEC = "unknown-state-bulk.db.spec.ts";
const RUN = randomUUID().slice(0, 8);

describeDb("customers without a state: buckets, bulk set and undo against real Postgres", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let list: UnknownStateCustomersService;
  let bulk: UnknownStateBulkService;
  let single: CustomerAddressStateService;
  let tenantA: string;
  let tenantB: string;

  const asA = <T>(fn: () => Promise<T>) => ctx.run(tenantA, fn);
  const asB = <T>(fn: () => Promise<T>) => ctx.run(tenantB, fn);
  const addressesOf = (customerId: string) =>
    prisma.customerAddress.findMany({ where: { customerId }, orderBy: { createdAt: "asc" } });

  async function mkCustomer(tenantId: string, name: string, state?: string) {
    const handle = `ustate-${RUN}-${randomUUID().slice(0, 6)}`;
    const user = await prisma.user.create({
      data: { email: `${handle}@example.invalid`, username: handle, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: name, contactName: "Acme", tenantId },
    });
    if (state !== undefined) {
      await prisma.customerAddress.create({
        data: {
          tenantId,
          customerId: customer.id,
          line1: "1 Test St",
          city: "Testville",
          state,
          stateCode: null,
          stateNeedsReview: true,
          zip: "75201",
          isDefault: true,
          addressType: "BILLING",
        },
      });
    }
    return customer.id;
  }

  async function wipe(tenantId: string) {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.customerAddress.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
  }

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const engine = new SellingRestrictionsService(prisma, new ProductLabelsService(prisma));
    list = new UnknownStateCustomersService(prisma, engine);
    bulk = new UnknownStateBulkService(prisma, engine);
    single = new CustomerAddressStateService(prisma);
    const slugA = assertTestTenant(`qa-ustate-${RUN}-a`, SPEC);
    const slugB = assertTestTenant(`qa-ustate-${RUN}-b`, SPEC);
    tenantA = (await prisma.tenant.create({ data: { slug: slugA, name: `UState ${slugA}` } })).id;
    tenantB = (await prisma.tenant.create({ data: { slug: slugB, name: `UState ${slugB}` } })).id;
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await wipe(t);
      await prisma.tenant.deleteMany({ where: { id: t } });
    }
    await prisma?.$disconnect();
  }, 120_000);

  beforeEach(async () => {
    jest.restoreAllMocks();
    for (const t of [tenantA, tenantB]) await wipe(t);
  });

  async function addClean(tenantId: string, customerId: string, code: string, isDefault: boolean) {
    await prisma.customerAddress.create({
      data: {
        tenantId,
        customerId,
        line1: "1 Test St",
        city: "Testville",
        state: code,
        stateCode: code,
        stateNeedsReview: false,
        zip: "",
        isDefault,
        addressType: "BILLING",
      },
    });
  }

  it("needsDefault: clean-coded customers with no or conflicting defaults are found and paged without the pre-filter", async () => {
    const noDefault = await mkCustomer(tenantA, "Delta Acme");
    await addClean(tenantA, noDefault, "TX", false);
    await addClean(tenantA, noDefault, "NY", false);
    const conflict = await mkCustomer(tenantA, "Echo Acme");
    await addClean(tenantA, conflict, "TX", true);
    await addClean(tenantA, conflict, "NY", true);
    const resolved = await mkCustomer(tenantA, "Foxtrot Acme");
    await addClean(tenantA, resolved, "TX", true);
    await addClean(tenantA, resolved, "NY", false);
    const other = await mkCustomer(tenantB, "Other tenant");
    await addClean(tenantB, other, "TX", false);
    await addClean(tenantB, other, "NY", false);

    const r = await asA(() => list.list({}));
    expect(r.needsDefault.total).toBe(2);
    expect(r.needsDefault.rows.map((x) => x.name)).toEqual(["Delta Acme", "Echo Acme"]);
    expect(r.needsDefault.rows[0].choices?.map((c) => c.state)).toEqual(["TX", "NY"]);
    expect(r.customersTotal).toBe(2);
    const p1 = await asA(() => list.list({ bucket: "needsDefault", limit: 1 }));
    const p2 = await asA(() =>
      list.list({ bucket: "needsDefault", limit: 1, cursor: p1.needsDefault.nextCursor as string }),
    );
    expect(p2.needsDefault.rows.map((x) => x.name)).toEqual(["Echo Acme"]);
    expect(p2.needsDefault.nextCursor).toBeNull();
  });

  it("buckets come back from the real relation filters, tenant-scoped and name-sorted", async () => {
    await mkCustomer(tenantA, "Bravo Acme");
    await mkCustomer(tenantA, "Alpha Acme");
    await mkCustomer(tenantA, "Charlie Acme", "Unknown");
    await mkCustomer(tenantB, "Other tenant");
    const r = await asA(() => list.list({}));
    expect(r.noAddress.rows.map((x) => x.name)).toEqual(["Alpha Acme", "Bravo Acme"]);
    expect(r.unusableState.rows).toEqual([
      expect.objectContaining({ name: "Charlie Acme", suggestedState: "TX" }),
    ]);
    expect(r.customersTotal).toBe(3);
    const p1 = await asA(() => list.list({ bucket: "noAddress", limit: 1 }));
    const p2 = await asA(() =>
      list.list({ bucket: "noAddress", limit: 1, cursor: p1.noAddress.nextCursor as string }),
    );
    expect(p2.noAddress.rows.map((x) => x.name)).toEqual(["Bravo Acme"]);
    expect(p2.noAddress.nextCursor).toBeNull();
  }, 30_000);

  it("bulk-state writes and its audit row share ONE transaction: a failing audit leaves nothing", async () => {
    const n1 = await mkCustomer(tenantA, "No address");
    const u1 = await mkCustomer(tenantA, "Unusable", "Unknown");
    const original = prisma.tenantTransaction.bind(prisma);
    jest.spyOn(prisma, "tenantTransaction").mockImplementationOnce(((fn: any, opts?: any) =>
      original(async (tx: any) => {
        const failingAudit = new Proxy(tx, {
          get(target, key) {
            if (key !== "auditLog") return target[key];
            return {
              create: async () => {
                throw new Error("audit insert failed");
              },
            };
          },
        });
        return fn(failingAudit);
      }, opts)) as typeof prisma.tenantTransaction);
    await expect(
      asA(() => bulk.bulkSet({ bucket: "noAddress", customerIds: [n1], state: "TX" }, op)),
    ).rejects.toThrow("audit insert failed");
    expect(await addressesOf(n1)).toEqual([]);
    expect((await addressesOf(u1))[0]).toMatchObject({ stateCode: null, state: "Unknown" });
  }, 30_000);

  it("bulk set then undo: prior state restored, created address removed, repeat restores 0, other tenant untouched", async () => {
    const n1 = await mkCustomer(tenantA, "No address");
    const u1 = await mkCustomer(tenantA, "Unusable", "Unknown");
    const foreign = await mkCustomer(tenantB, "Other tenant");

    const a = await asA(() =>
      bulk.bulkSet({ bucket: "noAddress", customerIds: [n1, foreign], state: "TX" }, op),
    );
    expect(a.changed).toBe(1);
    expect(await addressesOf(foreign)).toEqual([]);
    const b = await asA(() =>
      bulk.bulkSet({ bucket: "unusableState", customerIds: [u1], state: "Texas" }, op),
    );
    expect((await addressesOf(u1))[0]).toMatchObject({ state: "TX", stateCode: "TX" });
    expect(
      await prisma.auditLog.count({ where: { tenantId: tenantA, action: AUDIT_BULK_STATE_SET } }),
    ).toBe(2);

    expect(await asA(() => bulk.undo({ changedAddressIds: b.changedAddressIds }, op))).toEqual({
      restored: 1,
    });
    expect((await addressesOf(u1))[0]).toMatchObject({
      state: "Unknown",
      stateCode: null,
      stateNeedsReview: true,
    });
    expect(await asA(() => bulk.undo({ changedAddressIds: a.changedAddressIds }, op))).toEqual({
      restored: 1,
    });
    expect(await addressesOf(n1)).toEqual([]);

    expect(await asA(() => bulk.undo({ changedAddressIds: b.changedAddressIds }, op))).toEqual({
      restored: 0,
    });
    await expect(
      asB(() => bulk.undo({ changedAddressIds: b.changedAddressIds }, op)),
    ).rejects.toThrow(NotFoundException);
  }, 30_000);

  it("an address edited after the bulk write is not restored", async () => {
    const u1 = await mkCustomer(tenantA, "Unusable", "Unknown");
    const b = await asA(() =>
      bulk.bulkSet({ bucket: "unusableState", customerIds: [u1], state: "TX" }, op),
    );
    await new Promise((r) => setTimeout(r, 5));
    await prisma.customerAddress.update({
      where: { id: b.changedAddressIds[0] },
      data: { line1: "2 Elm St" },
    });
    expect(await asA(() => bulk.undo({ changedAddressIds: b.changedAddressIds }, op))).toEqual({
      restored: 0,
    });
    expect((await addressesOf(u1))[0]).toMatchObject({ stateCode: "TX", line1: "2 Elm St" });
  }, 30_000);

  it("PATCH state and POST minimal write through the tenant client; another tenant's ids are 404s", async () => {
    const n1 = await mkCustomer(tenantA, "No address");
    const r = await asA(() => single.addMinimal(n1, { state: "TX", zip: "75201" }, op));
    expect((await addressesOf(n1))[0]).toMatchObject({
      id: r.addressId,
      tenantId: tenantA,
      stateCode: "TX",
      isDefault: true,
      addressType: "BILLING",
    });
    const u1 = await mkCustomer(tenantA, "Review", "Washington");
    const [addr] = await addressesOf(u1);
    await expect(
      asB(() => single.setState(u1, addr.id, { state: "WA", confirmReview: true }, op)),
    ).rejects.toThrow(NotFoundException);
    await asA(() => single.setState(u1, addr.id, { state: "WA", confirmReview: true }, op));
    expect((await addressesOf(u1))[0]).toMatchObject({ stateCode: "WA", stateNeedsReview: false });
  }, 30_000);
});
