/**
 * SA-218 (1) / #2116 — mergeCustomers takes Order rows before Invoice rows.
 *
 * House lock order: advisory → Return → Order → Invoice → rows. mergeCustomers used to re-point
 * the secondary customer's invoices BEFORE its orders inside one transaction — an Invoice → Order
 * edge that deadlocks (40P01) against any writer taking Order FOR UPDATE then an Invoice (#2083's
 * invoices update()). The fix only swaps the two moves: orders, then invoices, then estimates and
 * credit notes as before. The interleaving itself is proven on real Postgres in
 * `common/sa218-lock-order.db.spec.ts`; this pins the statement order the fix relies on.
 */
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";
import { createOpLogTx } from "../testing/op-log-tx";

const PRIMARY = { id: "cust-primary", userId: "user-primary", deletedAt: null };
const SECONDARY = { id: "cust-secondary", userId: "user-secondary", deletedAt: null };

describe("mergeCustomers — Order rows before Invoice rows (SA-218 (1), #2116)", () => {
  // SA-900: a SUPER_ADMIN merge runs with NO tenant (null); it must still lock the Returns first.
  it.each([["tenant-1"], [null]])(
    "REG-SA218-1: re-points the secondary's orders first, then invoices, then estimates and credit notes (tenant %s)",
    async (tenant: string | null) => {
      const { tx, log } = createOpLogTx((op, args) =>
        op === "customer.findUnique" && args?.where?.id === PRIMARY.id ? PRIMARY : undefined,
      );
      const prisma = {
        forTenant: () => ({
          customer: {
            findUnique: async ({ where }: any) =>
              where.id === PRIMARY.id ? PRIMARY : where.id === SECONDARY.id ? SECONDARY : null,
          },
        }),
        tenantTransaction: jest.fn((fn: (t: any) => unknown) => fn(tx)),
        getTenantId: () => tenant,
      };
      const module = await Test.createTestingModule({
        providers: [
          CustomersService,
          { provide: PrismaService, useValue: prisma },
          ...[
            ConfigService,
            StorageService,
            MeterService,
            PlanCatalogService,
            EntitlementAuthority,
            CommissionEngineService,
            RegulatedLedgerService,
            EmailService,
          ].map((provide) => ({ provide, useValue: {} })),
        ],
      }).compile();
      const service = module.get(CustomersService);

      await expect(service.mergeCustomers(PRIMARY.id, SECONDARY.id)).resolves.toEqual(PRIMARY);

      const ops = log.map((e) => e.op);
      // SA-893 (ROW_LOCK_ORDER, amends SA-218 (1)'s "first statement"): both customers' Returns are locked FIRST, then
      // the Order re-point is the first write: nothing, above all no Invoice row, is locked before the Orders.
      expect(ops[0]).toBe("$queryRaw");
      expect(log[0].sql).toMatch(
        /FROM "Return" WHERE "customerId" IN \(\?, \?\) AND \(\?::text IS NULL OR "tenantId" = \?\) ORDER BY id FOR UPDATE/,
      );
      expect(log[0].values).toEqual([PRIMARY.id, SECONDARY.id, tenant, tenant]);
      expect(ops[1]).toBe("order.updateMany");
      expect(ops.indexOf("order.updateMany")).toBeLessThan(ops.indexOf("invoice.updateMany"));
      // Nothing else moved: invoices, then estimates and credit notes, exactly as before the swap.
      const moves = ops.filter((op) => op.endsWith(".updateMany")).map((op) => op.split(".")[0]);
      expect(moves.slice(0, 4)).toEqual(["order", "invoice", "estimate", "creditNote"]);
      // Every move re-points secondary → primary (the swap changed the order, not the writes).
      for (const model of ["order", "invoice"]) {
        expect(log.find((e) => e.op === `${model}.updateMany`)?.args).toEqual({
          where: { customerId: SECONDARY.id },
          data: { customerId: PRIMARY.id },
        });
      }
    },
  );
});
