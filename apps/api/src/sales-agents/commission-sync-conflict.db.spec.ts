/**
 * #2201 — real-Postgres pin: a write conflict raised inside `syncInvoiceCommissionSafe`, when it runs
 * in the CALLER's Serializable transaction (as the credit-sync paths in credit-notes.service.ts call
 * it), makes `retryOnTxConflict` re-run the WHOLE transaction. The transaction's own write persists
 * exactly once, and there is no silent ROLLBACK.
 *
 * The conflict is a genuine SQLSTATE 40001 raised by Postgres on the caller's tx (a DO block with
 * `RAISE ... USING ERRCODE`), so Postgres really aborts the tx and the error arrives in the driver
 * adapter's own shape, never a hand-built stub. The commission algorithm itself is spied out: this
 * pins the wrapper's conflict contract, not the accrual math.
 *
 * Before the fix the wrapper swallowed the 40001, so the tx "committed" an aborted transaction:
 * either the COMMIT errored or the write silently vanished. Red either way.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js); the tenant it writes is a throwaway
 * `qa-2201-<run>` slug approved by `assertTestTenant`, deleted in `afterAll`.
 */

import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CommissionEngineService } from "./commission-engine.service";
import { retryOnTxConflict } from "../common/tx-retry";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);

describeDb(
  "syncInvoiceCommissionSafe — write conflict in the caller's tx retries it (#2201)",
  () => {
    let prisma: PrismaService;
    let engine: CommissionEngineService;
    const slugs: string[] = [];

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      prisma = new PrismaService(new TenantContextService());
      await prisma.$connect();
      // Entitlements/audit are never reached: syncInvoiceCommission is spied out per test.
      engine = new CommissionEngineService(prisma, {} as any, {} as any);
    });

    afterAll(async () => {
      if (slugs.length) {
        await prisma.tenant.deleteMany({ where: { slug: { in: slugs } } }).catch(() => {
          // Best-effort: a failed cleanup must never mask the test's own result.
        });
      }
      await prisma?.$disconnect();
    });

    it("a real 40001 on attempt 1 re-runs the whole tx; its write persists exactly once", async () => {
      const slug = assertTestTenant(`qa-2201-${RUN_SUFFIX}`, "commission-sync-conflict.db.spec.ts");
      slugs.push(slug);

      let syncCalls = 0;
      jest
        .spyOn(engine, "syncInvoiceCommission")
        .mockImplementation(async (_id: string, db: any) => {
          syncCalls += 1;
          if (syncCalls === 1) {
            await db.$executeRawUnsafe(
              `DO $$ BEGIN RAISE EXCEPTION '#2201 forced serialization failure' USING ERRCODE = '40001'; END $$`,
            );
          }
        });

      let attempts = 0;
      await retryOnTxConflict("#2201 pin", () =>
        prisma.$transaction(
          async (tx: any) => {
            attempts += 1;
            await tx.tenant.create({ data: { slug, name: `#2201 ${slug}` } });
            // Last statement in the tx, the exact position where a swallowed conflict turns the
            // caller's COMMIT into a silent ROLLBACK.
            await engine.syncInvoiceCommissionSafe("inv-2201", tx);
          },
          { isolationLevel: "Serializable" },
        ),
      );

      expect(attempts).toBe(2);
      expect(syncCalls).toBe(2);
      expect(await prisma.tenant.count({ where: { slug } })).toBe(1);
    });
  },
);
