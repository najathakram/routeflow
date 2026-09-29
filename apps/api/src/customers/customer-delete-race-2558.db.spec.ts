/**
 * #2579 / SA-510e (follow-up to #2558 / SA-510a), real Postgres: the customer-delete
 * time-of-check/time-of-use race, proved by BEHAVIOUR (no spy, no new-module symbol).
 *
 * A second connection (T2) holds the customer's DRAFT invoice row `FOR UPDATE`. `deleteAllCustomers`
 * (T1) passes its pre-flight and its in-transaction read (plain reads, the invoice is still DRAFT)
 * and then blocks on the invoice delete behind T2's row lock, observed via `pg_blocking_pids`
 * (the stats snapshot is cleared before every poll). T2 then flips the invoice to OVERDUE and
 * commits, and T1's delete re-evaluates the row it waited on:
 *   - fixed code: the delete is a compare-and-set scoped to the non-blocking statuses, so it
 *     removes 0 of the 1 row it read ⇒ 409, rollback: invoice, its item and the customer byte-identical;
 *   - pre-fix code (e35abb0b): the delete is scoped by customer only, so the OVERDUE invoice is
 *     destroyed and the call resolves ⇒ RED.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS
 * set, DATABASE_URL pointed at the compose/dbspec Postgres). The tenant is a throwaway
 * `qa-2558-<run>` slug approved by `assertTestTenant`; `afterAll` deletes exactly what it created.
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

describeDb(
  "customer delete: an invoice turned OVERDUE while the delete waits on it survives (#2579, SA-510e)",
  () => {
    let url: string;
    let prisma: PrismaService;
    let obs: Client; // observer: snapshots and the pg_blocking_pids polls, outside any tx
    let tenantCtx: TenantContextService;
    let service: CustomersService;
    let tenantId: string;
    let invoiceId: string;
    let itemId: string;
    let customerId: string;

    /** The whole row as Postgres stores it, for a byte-identical comparison. */
    async function rowJson(table: string, id: string): Promise<string | null> {
      const r = await obs.query(`SELECT to_jsonb(t)::text AS j FROM "${table}" t WHERE t.id = $1`, [
        id,
      ]);
      return r.rows[0]?.j ?? null;
    }

    beforeAll(async () => {
      url = requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      obs = new Client({ connectionString: url });
      await obs.connect();

      const slug = assertTestTenant(`qa-2558-${RUN}`, "customer-delete-race-2558.db.spec.ts");
      tenantId = (await prisma.tenant.create({ data: { slug, name: `2558 ${slug}` } })).id;
      const user = await prisma.user.create({
        data: {
          email: `c2558-${RUN}@example.invalid`,
          username: `c2558-${RUN}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      customerId = (
        await prisma.customer.create({
          data: { userId: user.id, businessName: "2558 race", contactName: "2558", tenantId },
        })
      ).id;
      invoiceId = (
        await prisma.invoice.create({
          data: {
            tenantId,
            customerId,
            invoiceNumber: `INV-2558-${RUN}`,
            status: "DRAFT",
            subtotal: 50,
            total: 50,
          },
        })
      ).id;
      // #2594 / SA-516: the child is an InvoiceItem, NOT an InvoicePayment. A payment is a money
      // record, which the delete's pre-flight now refuses outright, so T1 would never reach the
      // CAS this race exercises.
      itemId = (
        await prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId,
            description: "2558 race line",
            qty: 1,
            unitPrice: 50,
            subtotal: 50,
          },
        })
      ).id;

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
      await prisma.invoiceItem.deleteMany({ where: { tenantId } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
      await obs?.end().catch(() => undefined);
      await prisma?.$disconnect();
    });

    it("T2 holds the invoice, T1's delete blocks on it, T2 flips it to OVERDUE and commits: 409, nothing destroyed", async () => {
      const itemBefore = await rowJson("InvoiceItem", itemId);
      const customerBefore = await rowJson("Customer", customerId);
      expect(itemBefore).not.toBeNull();
      expect(customerBefore).not.toBeNull();

      const t2 = new Client({ connectionString: url });
      await t2.connect();
      let invoiceAfterFlip: string;
      let outcome: { ok: true; value: unknown } | { ok: false; e: any };
      try {
        await t2.query("BEGIN");
        await t2.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [invoiceId]);
        const t2pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

        const t1 = tenantCtx
          .run(tenantId, () => service.deleteAllCustomers())
          .then(
            (value) => ({ ok: true as const, value }),
            (e) => ({ ok: false as const, e }),
          );

        // Entry condition: T1 is really waiting on T2's row lock (the stats snapshot is cleared
        // before every poll — pg_stat_activity is cached inside a transaction).
        let blocked = false;
        for (let i = 0; i < 200 && !blocked; i++) {
          const r = await obs.query(
            `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid))) AS n`,
            [t2pid],
          );
          blocked = r.rows[0].n > 0;
          if (!blocked) await new Promise((res) => setTimeout(res, 50));
        }
        expect(blocked).toBe(true);

        // The invoice is issued and falls overdue while the delete waits on it.
        const flipped = await t2.query(
          `UPDATE "Invoice" SET status = 'OVERDUE' WHERE id = $1 RETURNING to_jsonb("Invoice".*)::text AS j`,
          [invoiceId],
        );
        invoiceAfterFlip = flipped.rows[0].j;
        await t2.query("COMMIT");

        outcome = await t1;
      } finally {
        await t2.end().catch(() => undefined);
      }

      // Pre-fix the call resolves and the invoice is gone; fixed, the CAS refuses and rolls back.
      expect(outcome.ok).toBe(false);
      expect((outcome as { e: unknown }).e).toBeInstanceOf(ConflictException);
      expect(await rowJson("Invoice", invoiceId)).toBe(invoiceAfterFlip);
      expect(await rowJson("InvoiceItem", itemId)).toBe(itemBefore);
      expect(await rowJson("Customer", customerId)).toBe(customerBefore);
    });
  },
);
