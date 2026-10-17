import "reflect-metadata";
import { EntitlementsModule } from "../billing/entitlements.module";
import { BuyerModule } from "../buyer/buyer.module";
import { CustomerUnitPricesModule } from "../customers/customer-unit-prices.module";
import { CustomersModule } from "../customers/customers.module";
import { ReturnsModule } from "../returns/returns.module";

/**
 * S19b nit 5: the services that read the customer layer take `EntitlementsService` as @Optional() (existing unit specs build
 * them without it). Optional must never hide a wiring gap in production: each owning module must (transitively) provide
 * EntitlementsService, or flag-on tenants would silently price at the tier. This fails if a module loses that import.
 */
type Mod = new (...a: never[]) => unknown;
const imports = (m: Mod): Mod[] =>
  (Reflect.getMetadata("imports", m) ?? []).map((i: any) => i?.module ?? i);
const exportsOf = (m: Mod): unknown[] => Reflect.getMetadata("exports", m) ?? [];
/** Imports EntitlementsModule directly, or a module that re-exports it. */
const providesEntitlements = (m: Mod): boolean =>
  imports(m).some((i) => i === EntitlementsModule || exportsOf(i).includes(EntitlementsModule));

describe("EntitlementsService is resolvable where the customer layer is read (no silent flag-off)", () => {
  it.each([
    ["CustomerUnitPricesModule (K6, /price-layer)", CustomerUnitPricesModule],
    ["BuyerModule (BuyerDashboardService tiles)", BuyerModule],
    ["CustomersModule (CustomerPriceHistoryService)", CustomersModule],
    ["ReturnsModule (InlineReturnsQuoteService)", ReturnsModule],
  ])("%s imports EntitlementsModule (directly or via a re-export)", (_n, mod) => {
    expect(providesEntitlements(mod as Mod)).toBe(true);
  });
});
