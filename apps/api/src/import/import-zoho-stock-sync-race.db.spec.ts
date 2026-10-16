/**
 * R11 (inventory TEST-PLAN W1b, B568 / SA-136b): the Zoho closing-stock sync racing a sale must not blind-overwrite.
 *
 * Stock 10 (OPENING 10). The sync CSV says "Closing Stock 10" (the report was cut before the sale). While
 * `ImportService.importInventory` is between its unlocked product read and its write, a sale of 3 commits
 * (counter 7, one SALE movement with stockAfter 7). On master the existing-product branch then writes the
 * ABSOLUTE closing value `currentStock = 10` with no transaction and no lock, and compares the CSV value against the
 * STALE read (10 === 10) so it records no movement at all: the sale is erased from the counter and the ledger still
 * says 7. Correct: the sale survives, i.e. the counter equals the ledger sum (7, or 10 with an offsetting
 * movement, never a blind 10 with no row); the counter and the movement land in one transaction with `stockAfter`.
 *
 * RED on master by design (tests only, no fix): counter 10 vs ledger 7. Linked bug: B568 (registry: open).
 *
 * INTERLEAVE (deterministic, no sleep decides the outcome): `prisma.forTenant()` is wrapped so the first
 * `product.findFirst` that finds the product commits the sale right after it returns, i.e. exactly inside the
 * read-to-write window the unlocked branch leaves open. The spec asserts the sale really ran before trusting the
 * outcome. No lock is involved on master, so there is no blocked backend to count.
 *
 * Real ImportService over a real PrismaService, test tenant `qa-r11-*` only (spec-owned fixtures).
 */
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";
import { ImportService } from "./import.service";

describeDb("R11 / B568: Zoho stock sync during a sale keeps the sale", () => {
  let w: OrderStockWorld;
  let importService: ImportService;

  beforeAll(async () => {
    w = await buildOrderStockWorld("r11", "import-zoho-stock-sync-race.db.spec.ts");
    const stub = {} as any;
    importService = new ImportService(w.prisma, stub, stub, stub, stub, stub, stub);
  }, 120_000);
  afterAll(async () => {
    jest.restoreAllMocks();
    await w?.cleanup();
  }, 120_000);

  it("B568: stock 10, sync closing 10 || a sale of 3 -> the counter keeps the sale (never a blind 10)", async () => {
    const productId = await w.product("r11", 10);
    const name = (await w.prisma.product.findUniqueOrThrow({ where: { id: productId } })).name;
    let saleRan = false;

    // The sale commits right after the sync's pre-write product read, before its write.
    const real = w.prisma.forTenant.bind(w.prisma);
    jest.spyOn(w.prisma, "forTenant").mockImplementation(((...args: any[]) => {
      const client: any = (real as any)(...args);
      return new Proxy(client, {
        get(target, prop) {
          const value = target[prop];
          if (prop !== "product") return value;
          return new Proxy(value, {
            get(model, method) {
              if (method !== "findFirst") return model[method];
              return async (...a: any[]) => {
                const found = await model.findFirst(...a);
                if (found && !saleRan) {
                  saleRan = true;
                  await w.bookOrder({ status: "CONFIRMED", lines: [{ productId, qty: 3 }] });
                }
                return found;
              };
            },
          });
        },
      });
    }) as any);

    const csv = Buffer.from(`Item Name,SKU,Closing Stock\n${name},,10\n`);
    const result = await w.inTenant(() => importService.importInventory(csv, w.jwt.sub));
    jest.restoreAllMocks();

    expect(saleRan).toBe(true); // the sale really committed inside the read-to-write window
    expect(result).toMatchObject({ updated: 1, skipped: 0, errors: [] });

    const counter = await w.stockOf(productId);
    const ledgerSum = Number(
      (
        await w.pool.query(
          `SELECT COALESCE(SUM(quantity), 0) AS s FROM "StockMovement" WHERE "productId" = $1`,
          [productId],
        )
      ).rows[0].s,
    );
    // Master: { counter: 10, ledgerSum: 7 }: the sync wrote an absolute 10 over the sale and recorded nothing.
    expect({ counter, ledgerSum }).toEqual({ counter: ledgerSum, ledgerSum });
    expect([7, 10]).toContain(counter);
    expect(
      (await w.movements(productId)).some((m) => m.type === "SALE" && Number(m.quantity) === -3),
    ).toBe(true);
    await expectLedgerConsistent(w.tenantId, w.productIds);
  });
});
