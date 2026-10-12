import "reflect-metadata";
import { RequestMethod, ValidationPipe } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { CounterDayCloseController } from "./day-close.controller";
import { DayCloseDto, DayCloseQueryDto } from "./day-close.dto";
import { CounterSaleController } from "../counter-sale.controller";
import { OrdersController } from "../../orders.controller";

/** The HTTP edge of the day close: the route list, the role on every route, the DTO pipe, and that no other GET route can take them. */
const routeOf = (name: keyof CounterDayCloseController) => {
  const fn = CounterDayCloseController.prototype[name] as unknown as object;
  return {
    method: RequestMethod[Reflect.getMetadata("method", fn)],
    path: Reflect.getMetadata("path", fn) as string,
    roles: Reflect.getMetadata("roles", fn) as string[] | undefined,
    guards: Reflect.getMetadata("__guards__", fn) as unknown[] | undefined,
  };
};

describe("CounterDayCloseController: routes", () => {
  it("is the exact route list, under the orders base", () => {
    expect(Reflect.getMetadata("path", CounterDayCloseController)).toBe("orders");
    expect(
      (["state", "latest", "byId", "close", "reopen", "report"] as const).map((n) => {
        const r = routeOf(n);
        return `${r.method} ${r.path}`;
      }),
    ).toEqual([
      "GET counter-sale/day-close",
      "GET counter-sale/day-close/latest",
      "GET counter-sale/day-close/:id",
      "POST counter-sale/day-close",
      "POST counter-sale/day-close/:id/reopen",
      "POST counter-sale/day-close/:id/report",
    ]);
  });

  it("every route is OPERATOR (which admits TENANT_ADMIN) behind the roles guard", () => {
    for (const n of ["state", "latest", "byId", "close", "reopen", "report"] as const) {
      expect(routeOf(n).roles).toEqual([UserRole.OPERATOR]);
      expect(routeOf(n).guards).toHaveLength(1);
    }
    expect(Reflect.getMetadata("__guards__", CounterDayCloseController)).toHaveLength(1);
  });

  it("no GET route of the other orders controllers can take the day-close path", () => {
    const takes = (template: string) =>
      ["orders/counter-sale/day-close", "orders/counter-sale/day-close/latest"].some((p) =>
        new RegExp(`^${template.replace(/:[^/]+/g, "[^/]+")}$`).test(p),
      );
    for (const ctrl of [OrdersController, CounterSaleController]) {
      const base = String(Reflect.getMetadata("path", ctrl));
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const fn = (ctrl.prototype as unknown as Record<string, unknown>)[name];
        if (typeof fn !== "function" || Reflect.getMetadata("method", fn) !== RequestMethod.GET)
          continue;
        const sub = String(Reflect.getMetadata("path", fn) ?? "");
        expect(takes([base, sub].filter(Boolean).join("/").replace(/\/+/g, "/"))).toBe(false);
      }
    }
  });
});

describe("the body / query pipe (the app's global ValidationPipe)", () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const body = (value: unknown) => pipe.transform(value, { type: "body", metatype: DayCloseDto });
  const ok = { openingFloat: 100.25, denominations: [{ kind: "bill", value: 20, count: 4 }] };

  it("accepts the contract's request, with an optional note and register", async () => {
    await expect(body({ ...ok, notes: "n", registerKey: "b" })).resolves.toBeDefined();
    await expect(body(ok)).resolves.toBeDefined();
  });

  it("refuses a client counted / expected (not fields), a bad float, bad denominations, long notes and a bad register", async () => {
    for (const bad of [
      { ...ok, counted: 5 },
      { ...ok, expected: 5 },
      { ...ok, openingFloat: 0.001 },
      { ...ok, openingFloat: -1 },
      { ...ok, openingFloat: "5" },
      { ...ok, denominations: [{ kind: "bill", value: 7, count: 1 }] },
      { ...ok, denominations: "all of it" },
      { ...ok, notes: "x".repeat(501) },
      { ...ok, registerKey: "no spaces" },
      { denominations: ok.denominations },
    ]) {
      await expect(body(bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("the query takes only an optional valid registerKey", async () => {
    const q = (v: unknown) => pipe.transform(v, { type: "query", metatype: DayCloseQueryDto });
    await expect(q({})).resolves.toBeDefined();
    await expect(q({ registerKey: "b" })).resolves.toBeDefined();
    await expect(q({ registerKey: "x y" })).rejects.toMatchObject({ status: 400 });
    await expect(q({ day: "2026-10-08" })).rejects.toMatchObject({ status: 400 });
  });
});
