import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { EntitlementsModule } from "../billing/entitlements.module";
import { CommissionEngineService } from "./commission-engine.service";
import { CommissionReconciliationService } from "./commission-reconciliation.service";
import { SalesAgentsController } from "./sales-agents.controller";
import { SalesAgentsService } from "./sales-agents.service";
import { CommissionStatementsController } from "./commission-statements.controller";
import { CommissionStatementsService } from "./commission-statements.service";

/**
 * Sales agents & commissions (flag.sales_agents). Two halves share this module:
 * - WP3: CommissionEngineService (invoice sync engine consumed by invoices/
 *   credit-notes/orders hooks) + CommissionReconciliationService (hourly cron).
 * - WP5 (this half): the agent-records + statements/payouts API — controllers
 *   and services below. Only CommissionEngineService is exported; consumer
 *   modules (invoices, credit-notes, orders) import CommissionsModule one-way,
 *   never the reverse — no cycles.
 *
 * See .claude/pipeline/plans/2026-08-22-sales-agents-engine.md for the full
 * engine design (money semantics, rate precedence, the ledger invariant).
 */
@Module({
  imports: [PrismaModule, EntitlementsModule],
  controllers: [SalesAgentsController, CommissionStatementsController],
  providers: [
    CommissionEngineService,
    CommissionReconciliationService,
    SalesAgentsService,
    CommissionStatementsService,
  ],
  exports: [CommissionEngineService],
})
export class CommissionsModule {}
