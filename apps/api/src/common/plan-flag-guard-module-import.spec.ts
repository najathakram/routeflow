import "reflect-metadata";
import { EstimatesModule } from "../estimates/estimates.module";
import { RecurringInvoicesModule } from "../recurring-invoices/recurring-invoices.module";
import { CreditNotesModule } from "../credit-notes/credit-notes.module";
import { SuppliersModule } from "../suppliers/suppliers.module";
import { MessagesModule } from "../messages/messages.module";
import { CustomersModule } from "../customers/customers.module";
import { EntitlementsModule } from "../billing/entitlements.module";

/**
 * WP5a/5b/5c: PlanFlagGuard is only PROVIDED (and EXPORTED) by EntitlementsModule
 * (see entitlements.module.ts). Any module whose controller applies
 * `@UseGuards(PlanFlagGuard)` — class-level or handler-level — must import
 * EntitlementsModule, or Nest's DI container has no provider to resolve the guard's
 * own EntitlementsService/PlanCatalogService dependencies and boot fails. This is a
 * pure metadata check (no full Nest app needed) so it fails fast in `npx tsc
 * --noEmit`-adjacent unit test time rather than only at `nest build`/boot.
 */
describe("modules using PlanFlagGuard import EntitlementsModule", () => {
  it.each([
    ["EstimatesModule", EstimatesModule],
    ["RecurringInvoicesModule", RecurringInvoicesModule],
    ["CreditNotesModule", CreditNotesModule],
    ["SuppliersModule", SuppliersModule],
    ["MessagesModule", MessagesModule],
    ["CustomersModule", CustomersModule],
  ])("%s imports EntitlementsModule", (_name, moduleClass) => {
    const imports = (Reflect.getMetadata("imports", moduleClass) ?? []) as unknown[];
    expect(imports).toContain(EntitlementsModule);
  });
});
