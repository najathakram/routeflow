import type { Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EmailService } from "../email/email.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-1048 A1/A2: the monthly income and expense totals of the customer income chart round by roundMoney.
 * 1 + 1.135 is 2.135: the old hand cents round (and toFixed) gave 2.13, roundMoney gives 2.14.
 */
describe("CustomersService.getIncomeChart rounds monthly totals by roundMoney (SA-1048 A1/A2)", () => {
  it("2.135 of income and of expenses in one month is 2.14", async () => {
    const prisma = createMockPrisma();
    const stub = (provide: Type<unknown>) => ({ provide, useValue: {} });
    const moduleRef = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        stub(CommissionEngineService),
        stub(ConfigService),
        stub(StorageService),
        stub(MeterService),
        stub(PlanCatalogService),
        stub(EntitlementAuthority),
        stub(RegulatedLedgerService),
        stub(EmailService),
      ],
    }).compile();
    const service = moduleRef.get(CustomersService);

    const day = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15);
    const row = (amount: number) => ({ amount, paidAt: day, settledAt: day, date: day });
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", businessName: "Acme Foods" });
    prisma.invoicePayment.findMany.mockResolvedValue([row(1), row(1.135)]);
    prisma.expense.findMany.mockResolvedValue([row(1), row(1.135)]);

    const chart = await service.getIncomeChart("cust-1");

    const label = day.toLocaleString("en-US", { month: "short", year: "numeric" });
    const month = chart.find((m) => m.month === label);
    expect([month?.income, month?.expenses]).toEqual([2.14, 2.14]);
  });
});
