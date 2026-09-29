/**
 * #2628 / SA-530 (owner policy 4b), real Postgres: a VOID invoice blocks a customer hard delete.
 *
 * `CUSTOMER_DELETE_NON_BLOCKING` is now `[DRAFT]` only, so the derived blocking set holds VOID: a
 * voided invoice is an issued document with a number and a history, and must survive its
 * customer's deletion. Each case seeds a customer whose ONLY invoice is VOID (its own throwaway
 * tenant):
 *   - `deleteAllCustomers`, `deleteImportedCustomers` and `batchDelete` refuse with a 409, and the
 *     invoice and the customer are byte-identical afterwards;
 *   - `deleteCustomer(id, force)` still soft-deletes the customer (records preserved).
 * Pre-fix, the two bulk paths hard-delete the VOID invoice with its customer, and `batchDelete`
 * passes its pre-flight: RED.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS
 * set, DATABASE_URL pointed at the compose/dbspec Postgres). Tenants are `qa-2628-<run>-<n>` slugs
 * approved by `assertTestTenant`; `afterAll` deletes exactly what they hold.
 */
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { Client } from "pg";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("a VOID invoice blocks a customer hard delete (#2628, SA-530)", () => {
  let prisma: PrismaService;
  let obs: Client;
  let tenantCtx: TenantContextService;
  let service: CustomersService;
  const tenantIds: string[] = [];
  let seq = 0;

  async function rowJson(table: string, id: string): Promise<string | null> {
    const r = await obs.query(`SELECT to_jsonb(t)::text AS j FROM "${table}" t WHERE t.id = $1`, [
      id,
    ]);
    return r.rows[0]?.j ?? null;
  }

  /** A customer whose only invoice is VOID, in a fresh approved test tenant. */
  async function seedVoidOnly() {
    seq += 1;
    const slug = assertTestTenant(`qa-2628-${RUN}-${seq}`, "customer-delete-void-2628.db.spec.ts");
    const tenantId = (await prisma.tenant.create({ data: { slug, name: `2628 ${slug}` } })).id;
    tenantIds.push(tenantId);
    const user = await prisma.user.create({
      data: {
        email: `c2628-${RUN}-${seq}@example.invalid`,
        username: `c2628-${RUN}-${seq}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "2628 void", contactName: "2628", tenantId },
      })
    ).id;
    const invoiceId = (
      await prisma.invoice.create({
        data: {
          tenantId,
          customerId,
          invoiceNumber: `INV-2628-${RUN}-${seq}`,
          status: "VOID",
          subtotal: 40,
          total: 40,
        },
      })
    ).id;
    return { tenantId, customerId, invoiceId };
  }

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    obs = new Client({ connectionString: url });
    await obs.connect();

    const stub = {} as never;
    service = new CustomersService(
      prisma,
      { get: () => null } as never,
      stub,
      stub,
      stub,
      { can: async () => false } as never, // EntitlementAuthority (#2241)
      stub,
      { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) } as never,
      stub,
    );
  });

  afterAll(async () => {
    const where = { tenantId: { in: tenantIds } };
    await prisma.invoice.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await obs?.end().catch(() => undefined);
    await prisma?.$disconnect();
  });

  it.each([
    ["deleteAllCustomers", (s: CustomersService) => s.deleteAllCustomers()],
    [
      "runImportedCustomersCleanup (no buyer link ⇒ selected; #2629 keeps the body behind a 409 guard)",
      (s: CustomersService) => s.runImportedCustomersCleanup(),
    ],
    ["batchDelete", (s: CustomersService, id: string) => s.batchDelete([id])],
  ])(
    "%s: a customer whose only invoice is VOID ⇒ 409; invoice and customer byte-identical",
    async (_n, run) => {
      const { tenantId, customerId, invoiceId } = await seedVoidOnly();
      const before = [await rowJson("Invoice", invoiceId), await rowJson("Customer", customerId)];
      expect(before.every((r) => r !== null)).toBe(true);

      const caught: any = await tenantCtx
        .run(tenantId, () => (run as any)(service, customerId))
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain(customerId);

      expect([await rowJson("Invoice", invoiceId), await rowJson("Customer", customerId)]).toEqual(
        before,
      );
    },
  );

  it("deleteCustomer(id, force): the soft delete still works; the VOID invoice is kept", async () => {
    const { tenantId, customerId, invoiceId } = await seedVoidOnly();
    const invoiceBefore = await rowJson("Invoice", invoiceId);

    await expect(
      tenantCtx.run(tenantId, () => service.deleteCustomer(customerId, true)),
    ).resolves.toEqual({ success: true, softDeleted: true });

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(customer.deletedAt).not.toBeNull();
    expect(await rowJson("Invoice", invoiceId)).toBe(invoiceBefore);
  });
});
