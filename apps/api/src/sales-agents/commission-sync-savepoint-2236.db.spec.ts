/**
 * #2236 / SA-393, real Postgres: `syncInvoiceCommissionSafe` inside a CALLER's transaction.
 *
 * A statement error aborts a whole Postgres transaction, so a bare catch around the commission sync
 * cannot save the caller: its next statement fails with 25P02, or its COMMIT silently becomes a
 * ROLLBACK. SA-393 runs the sync under `SAVEPOINT commission_sync`. The unit spec pins the SQL it
 * issues; this spec pins what Postgres actually does with it:
 *   - a NON-conflict error (division by zero, SQLSTATE 22012) raised by the sync after it wrote:
 *     ROLLBACK TO undoes only the sync's write, the error is logged, and the caller's statements
 *     before AND after the sync commit (no 25P02);
 *   - a clean sync: RELEASE, and both its write and the caller's commit;
 *   - a CONFLICT (SQLSTATE 40001) raised by the sync: rethrown, so the caller's transaction fails
 *     and nothing it wrote commits (its retry loop re-runs the whole transaction).
 * Reverting to a bare try/catch turns the first case into a 25P02 failure of the caller: RED.
 *
 * The forced failure stands in for a commission bug: the sync is replaced for the test with one
 * that writes (a marker on the tenant row, standing in for the commission rows it would touch),
 * then raises a real Postgres error on the caller's transaction client. SA-393a's conditions.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS
 * set, DATABASE_URL pointed at the compose/dbspec Postgres). The tenant is a throwaway
 * `qa-2236-<run>` slug approved by `assertTestTenant`; `afterAll` deletes it.
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { CommissionEngineService } from "./commission-engine.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { txConflictState } from "../common/tx-retry";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "commission sync in a caller tx: SAVEPOINT semantics on real Postgres (#2236, SA-393)",
  () => {
    let prisma: PrismaService;
    let engine: CommissionEngineService;
    let tenantId: string;

    const nameNow = async () =>
      (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }))
        .name;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      prisma = new PrismaService(new TenantContextService());
      await prisma.$connect();
      const slug = assertTestTenant(`qa-2236-${RUN}`, "commission-sync-savepoint-2236.db.spec.ts");
      tenantId = (await prisma.tenant.create({ data: { slug, name: "orig" } })).id;
      engine = new CommissionEngineService(prisma, {} as never, {} as never);
    });

    afterAll(async () => {
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
    });

    afterEach(() => jest.restoreAllMocks());

    /** Replace the sync with one that writes on the caller's tx, then raises a real PG error. */
    const failingSync = (raise: (db: any) => Promise<unknown>) =>
      jest
        .spyOn(engine, "syncInvoiceCommission")
        .mockImplementation(async (_id: string, db: any) => {
          await db.tenant.update({ where: { id: tenantId }, data: { name: "written-by-sync" } });
          await raise(db);
        });

    it("a NON-conflict error: rolled back to the savepoint, logged; the caller's writes before and after it commit (no 25P02)", async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { name: "orig" } });
      failingSync((db) => db.$executeRaw`SELECT 1 / 0`); // SQLSTATE 22012 aborts the tx
      const logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      await prisma.$transaction(async (tx) => {
        await tx.tenant.update({ where: { id: tenantId }, data: { name: "caller-before" } });
        await engine.syncInvoiceCommissionSafe("inv-2236", tx);
        // Without the savepoint this statement fails with 25P02 (current transaction is aborted).
        await tx.tenant.update({ where: { id: tenantId }, data: { name: "caller-after" } });
      });

      expect(await nameNow()).toBe("caller-after"); // committed; the sync's own write was undone
      expect(logged).toHaveBeenCalledTimes(1); // SA-393a: ONE log line
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("Commission sync failed for invoice inv-2236"),
        expect.anything(),
      );
    });

    it("the sync's write alone is undone by ROLLBACK TO (the caller's earlier write survives)", async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { name: "orig" } });
      failingSync((db) => db.$executeRaw`SELECT 1 / 0`);
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      await prisma.$transaction(async (tx) => {
        await tx.tenant.update({ where: { id: tenantId }, data: { name: "caller-before" } });
        await engine.syncInvoiceCommissionSafe("inv-2236", tx);
      });

      expect(await nameNow()).toBe("caller-before");
    });

    it("a clean sync: RELEASE, and the sync's write and the caller's both commit", async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { name: "orig" } });
      jest
        .spyOn(engine, "syncInvoiceCommission")
        .mockImplementation(async (_id: string, db: any) => {
          await db.tenant.update({ where: { id: tenantId }, data: { name: "written-by-sync" } });
        });
      const logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      const seenInTx = await prisma.$transaction(async (tx) => {
        await tx.tenant.update({ where: { id: tenantId }, data: { name: "caller-before" } });
        await engine.syncInvoiceCommissionSafe("inv-2236", tx);
        return (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } })).name;
      });

      expect(seenInTx).toBe("written-by-sync");
      expect(await nameNow()).toBe("written-by-sync");
      expect(logged).not.toHaveBeenCalled();
    });

    it("a CONFLICT (40001): rethrown, the caller's transaction fails and nothing it wrote commits", async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { name: "orig" } });
      failingSync((db) =>
        db.$executeRawUnsafe(
          `DO $$ BEGIN RAISE EXCEPTION 'forced conflict' USING ERRCODE = '40001'; END $$`,
        ),
      );

      const caught: any = await prisma
        .$transaction(async (tx) => {
          await tx.tenant.update({ where: { id: tenantId }, data: { name: "caller-before" } });
          await engine.syncInvoiceCommissionSafe("inv-2236", tx);
          await tx.tenant.update({ where: { id: tenantId }, data: { name: "caller-after" } });
        })
        .catch((e) => e);

      expect(txConflictState(caught)).not.toBeNull(); // what the caller's retry loop keys on
      expect(await nameNow()).toBe("orig");
    });
  },
);
