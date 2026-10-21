/**
 * Row 510 (rulings Q5 + brief 3) — the counter sale and the staff restriction protocol:
 *  - the body DTO accepts the ack (`restrictionOverrides`, `warningHash`) under the app's whitelist +
 *    forbidNonWhitelisted pipe, and still refuses an unknown top-level field (the keys are additive);
 *  - the counter judges its sale through the ONE jurisdiction helper (L8 `sale-fulfilment.ts`): the create gate maps a
 *    counter sale to the COUNTER kind, judged at the STORE's state whatever the customer's address (the engine side is
 *    pinned by selling-restrictions.store-state.spec.ts);
 *  - a delivered order of the same customer stays on the customer's address.
 */
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CounterSaleDto } from "./counter-sale.dto";
import * as rGate from "../order-restriction-gate";
import { judgedAtStore, saleFulfilmentKind } from "../../selling-restrictions/sale-fulfilment";

const PID = "11111111-1111-4111-8111-111111111111";
const body = (extra: Record<string, unknown> = {}) => ({
  walkIn: true,
  items: [{ productId: PID, qty: 1 }],
  payment: { method: "CARD" },
  ...extra,
});
const check = async (extra: Record<string, unknown>) => {
  const dto = plainToInstance(CounterSaleDto, body(extra));
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errors };
};

describe("counter sale body: the restriction ack", () => {
  it("accepts restrictionOverrides + warningHash and keeps them on the DTO", async () => {
    const { dto, errors } = await check({
      warningHash: "rw1:abc",
      restrictionOverrides: [{ lineKey: "n:0", reason: "Licensed buyer" }],
    });
    expect(errors).toHaveLength(0);
    expect(dto.warningHash).toBe("rw1:abc");
    expect(dto.restrictionOverrides).toEqual([{ lineKey: "n:0", reason: "Licensed buyer" }]);
  });

  it("an ack-free body is unchanged", async () => {
    expect((await check({})).errors).toHaveLength(0);
  });

  it("still refuses an unknown top-level field, and a malformed override entry", async () => {
    expect((await check({ bogus: 1 })).errors.length).toBeGreaterThan(0);
    expect(
      (await check({ restrictionOverrides: [{ lineKey: 5, reason: {} }] })).errors.length,
    ).toBeGreaterThan(0);
    expect((await check({ warningHash: "x".repeat(81) })).errors.length).toBeGreaterThan(0);
  });
});

describe("a counter sale is judged by the STORE's state (the L8 helper, sale-fulfilment.ts)", () => {
  it("the create gate gives a counter sale the COUNTER kind, judged at the store", () => {
    const args = rGate.create({
      tenant: "t1",
      customerId: "c1",
      user: { role: "OPERATOR", sub: "u1" } as never,
      lineItemsData: [{ productId: "p1" }],
      fulfillPath: "PICKUP",
      options: { counterSale: true },
      dto: undefined,
    });
    expect(args.fulfilmentKind).toBe("COUNTER");
    expect(judgedAtStore(args.fulfilmentKind)).toBe(true);
    expect(args.document).toBe("ORDER");
    // without the counter flag the same PICKUP order is still the store's (every pickup), a ROUTE order is not
    expect(saleFulfilmentKind({ counterSale: false, fulfillPath: "PICKUP" })).toBe("PICKUP");
    expect(judgedAtStore("PICKUP")).toBe(true);
    expect(saleFulfilmentKind({ counterSale: false, fulfillPath: "ROUTE" })).toBe("DELIVERY");
    expect(judgedAtStore("DELIVERY")).toBe(false);
  });

  it("a counter sale stays COUNTER whatever path column it carries", () => {
    const args = rGate.create({
      tenant: "t1",
      customerId: "c1",
      user: { role: "OPERATOR", sub: "u1" } as never,
      lineItemsData: [{ productId: "p1" }],
      fulfillPath: "ROUTE",
      options: { counterSale: true },
      dto: undefined,
    });
    expect(args.fulfilmentKind).toBe("COUNTER");
  });
});
