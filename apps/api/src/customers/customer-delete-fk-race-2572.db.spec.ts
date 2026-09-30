/**
 * #2572, real Postgres: an invoice INSERTed for a customer while a bulk customer delete runs.
 *
 * T2 (its own connection, an interactive transaction) inserts a DRAFT invoice for the customer
 * and does NOT commit: the row is invisible to T1's reads and compare-and-sets, and it holds
 * FOR KEY SHARE on the customer row. T1 (`deleteAllCustomers` / `deleteImportedCustomers`) passes
 * every guard and then blocks on its customer-row delete, observed via `pg_blocking_pids` with
 * the stats snapshot cleared per poll. T2 commits; T1's delete now violates the foreign key:
 *   - fixed code: a 409 ConflictException; the customer, its user and T2's invoice byte-identical;
 *   - pre-fix code: the raw Prisma P2003 (a 500 at the controller) ⇒ RED by behaviour.
 * No spy and no symbol from customer-delete-preflight.ts. Each path gets its own throwaway tenant:
 * once T2 has committed, a DRAFT invoice is deletable, so a reused customer would not race.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS
 * set, DATABASE_URL pointed at the compose/dbspec Postgres). Tenants are `qa-2572-<run>-<n>` slugs
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

describeDb("customer delete vs a concurrent invoice insert: 409, not a raw P2003 (#2572)", () => {
  let prisma: PrismaService;
  let second: PrismaService; // T2: its own client, its own connection
  let obs: Client; // observer: snapshots and the pg_blocking_pids polls
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

  async function seedCustomer() {
    seq += 1;
    const slug = assertTestTenant(
      `qa-2572-${RUN}-${seq}`,
      "customer-delete-fk-race-2572.db.spec.ts",
    );
    const tenantId = (await prisma.tenant.create({ data: { slug, name: `2572 ${slug}` } })).id;
    tenantIds.push(tenantId);
    const user = await prisma.user.create({
      data: {
        email: `c2572-${RUN}-${seq}@example.invalid`,
        username: `c2572-${RUN}-${seq}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "2572 race", contactName: "2572", tenantId },
    });
    return { tenantId, userId: user.id, customerId: customer.id };
  }

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    second = new PrismaService(new TenantContextService());
    await prisma.$connect();
    await second.$connect();
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
    await second?.$disconnect();
    await prisma?.$disconnect();
  });

  it.each([
    ["deleteAllCustomers", (s: CustomersService) => s.deleteAllCustomers()],
    [
      "deleteImportedCustomers (no buyer link ⇒ selected)",
      (s: CustomersService) => s.runImportedCustomersCleanup(),
    ],
  ])(
    "%s: T2's uncommitted invoice insert blocks the customer delete, T2 commits ⇒ 409, customer, user and invoice kept",
    async (_n, run) => {
      const { tenantId, userId, customerId } = await seedCustomer();
      const customerBefore = await rowJson("Customer", customerId);
      const userBefore = await rowJson("User", userId);
      expect(customerBefore).not.toBeNull();
      expect(userBefore).not.toBeNull();

      // T2: insert, report its pid, then hold the transaction open until released.
      let release!: () => void;
      const released = new Promise<void>((res) => (release = res));
      let inserted!: (v: { pid: number; invoiceId: string }) => void;
      const insertedP = new Promise<{ pid: number; invoiceId: string }>((res) => (inserted = res));
      const t2 = second.$transaction(
        async (h) => {
          const [{ pid }] = await h.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          const inv = await h.invoice.create({
            data: {
              tenantId,
              customerId,
              invoiceNumber: `INV-2572-${RUN}-${seq}`,
              status: "DRAFT",
              subtotal: 20,
              total: 20,
            },
          });
          inserted({ pid, invoiceId: inv.id });
          await released;
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
      let outcome: { ok: true; value: unknown } | { ok: false; e: any };
      let invoiceId: string;
      try {
        const got = await insertedP;
        invoiceId = got.invoiceId;

        const t1 = tenantCtx
          .run(tenantId, () => run(service))
          .then(
            (value) => ({ ok: true as const, value }),
            (e) => ({ ok: false as const, e }),
          );

        // Entry condition: T1 is really waiting on T2 (its customer-row delete behind T2's KEY SHARE).
        let blocked = false;
        for (let i = 0; i < 200 && !blocked; i++) {
          const r = await obs.query(
            `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid))) AS n`,
            [got.pid],
          );
          blocked = r.rows[0].n > 0;
          if (!blocked) await new Promise((res) => setTimeout(res, 50));
        }
        expect(blocked).toBe(true);

        release();
        await t2; // T2 commits
        outcome = await t1;
      } finally {
        release();
        await t2.catch(() => undefined);
      }

      // Pre-fix this is the raw P2003 (a PrismaClientKnownRequestError), not a 409.
      expect(outcome.ok).toBe(false);
      expect((outcome as { e: unknown }).e).toBeInstanceOf(ConflictException);
      expect(await rowJson("Customer", customerId)).toBe(customerBefore);
      expect(await rowJson("User", userId)).toBe(userBefore);
      const inv = await rowJson("Invoice", invoiceId);
      expect(inv).not.toBeNull();
      expect(JSON.parse(inv as string).customerId).toBe(customerId);
    },
  );
});
