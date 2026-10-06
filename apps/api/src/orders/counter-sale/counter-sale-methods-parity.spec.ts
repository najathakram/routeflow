import "reflect-metadata";
import * as PrismaEnums from "@prisma/client";
import { COUNTER_SALE_METHODS } from "./counter-sale.dto";
import { toPrismaMethod, type CounterPaymentMethod } from "./counter-sale-payment";

/**
 * L-072: a hand-typed local mirror of a shared list is how drift ships. `COUNTER_SALE_METHODS` (the DTO's
 * IsIn list) mirrors `COUNTER_SALE_PAYMENT_METHOD_VALUES` (the shared contract: API source never
 * value-imports @routeflow/types; the spec requires it), and every method that is a
 * payment must map to a real Prisma `PaymentMethod`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SHARED: readonly string[] = require("@routeflow/types").COUNTER_SALE_PAYMENT_METHOD_VALUES;

describe("counter sale payment methods: pinned against their sources (L-072)", () => {
  it("the DTO list is set-equal to the shared contract's COUNTER_SALE_PAYMENT_METHOD_VALUES", () => {
    expect([...COUNTER_SALE_METHODS].sort()).toEqual([...SHARED].sort());
  });

  it("CASH / CARD / CHECK map to real Prisma PaymentMethod values, exactly CASH, CREDIT_CARD, CHECK", () => {
    const prismaValues = Object.values(PrismaEnums.PaymentMethod) as string[];
    const targets = (COUNTER_SALE_METHODS as readonly CounterPaymentMethod[])
      .map((m) => toPrismaMethod(m))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    for (const t of targets) expect(prismaValues).toContain(t);
    expect([...targets].sort()).toEqual(["CASH", "CHECK", "CREDIT_CARD"]);
  });

  it("ON_ACCOUNT is the ONLY method that is not a payment", () => {
    const nonPayments = (COUNTER_SALE_METHODS as readonly CounterPaymentMethod[]).filter(
      (m) => toPrismaMethod(m) === null,
    );
    expect(nonPayments).toEqual(["ON_ACCOUNT"]);
  });

  it("no method maps to a wallet application (CREDIT_NOTE / ADVANCE): a counter tender is external money", () => {
    for (const m of COUNTER_SALE_METHODS as readonly CounterPaymentMethod[]) {
      expect(["CREDIT_NOTE", "ADVANCE"]).not.toContain(toPrismaMethod(m));
    }
  });
});
