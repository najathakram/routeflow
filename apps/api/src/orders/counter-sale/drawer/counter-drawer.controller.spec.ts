import "reflect-metadata";
import { RequestMethod, ValidationPipe } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { CounterDrawerController } from "./counter-drawer.controller";
import {
  CorrectOpeningFloatDto,
  OpeningFloatQueryDto,
  RecordOpeningFloatDto,
} from "./counter-drawer.dto";
import { TillPermissionGuard } from "../till-permission.guard";
import { RolesGuard } from "../../../auth/guards/roles.guard";
import { CounterSaleController } from "../counter-sale.controller";
import { OrdersController } from "../../orders.controller";

/** The HTTP edge of the drawer events: the route list, the role on each route, the guards and the DTO pipe. */
const routeOf = (name: keyof CounterDrawerController) => {
  const fn = CounterDrawerController.prototype[name] as unknown as object;
  return {
    method: RequestMethod[Reflect.getMetadata("method", fn)],
    path: Reflect.getMetadata("path", fn) as string,
    roles: Reflect.getMetadata("roles", fn) as string[] | undefined,
    guards: Reflect.getMetadata("__guards__", fn) as unknown[] | undefined,
  };
};

describe("CounterDrawerController: routes and roles", () => {
  it("is the exact route list under the orders base", () => {
    expect(Reflect.getMetadata("path", CounterDrawerController)).toBe("orders");
    expect(
      (["read", "record", "correct"] as const).map(
        (n) => `${routeOf(n).method} ${routeOf(n).path}`,
      ),
    ).toEqual([
      "GET counter-sale/drawer/opening-float",
      "POST counter-sale/drawer/opening-float",
      "PATCH counter-sale/drawer/opening-float",
    ]);
  });

  it("read and record are OPERATOR behind the roles guard AND the till guard", () => {
    for (const n of ["read", "record"] as const) {
      expect(routeOf(n).roles).toEqual([UserRole.OPERATOR]);
      expect(routeOf(n).guards).toEqual([RolesGuard, TillPermissionGuard]);
    }
  });

  it("correct is TENANT_ADMIN only (RolesGuard), so an OPERATOR is refused", () => {
    expect(routeOf("correct").roles).toEqual([UserRole.TENANT_ADMIN]);
    expect(routeOf("correct").guards).toEqual([RolesGuard, TillPermissionGuard]);
  });

  it("no GET route of the other orders controllers can take the drawer path", () => {
    const path = "orders/counter-sale/drawer/opening-float";
    for (const ctrl of [OrdersController, CounterSaleController]) {
      const base = String(Reflect.getMetadata("path", ctrl));
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const fn = (ctrl.prototype as unknown as Record<string, unknown>)[name];
        if (typeof fn !== "function" || Reflect.getMetadata("method", fn) !== RequestMethod.GET)
          continue;
        const sub = String(Reflect.getMetadata("path", fn) ?? "");
        const tpl = [base, sub].filter(Boolean).join("/").replace(/\/+/g, "/");
        expect(new RegExp(`^${tpl.replace(/:[^/]+/g, "[^/]+")}$`).test(path)).toBe(false);
      }
    }
  });
});

describe("the body / query pipe (the app's global ValidationPipe)", () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const run = (value: unknown, metatype: any, type: "body" | "query" = "body") =>
    pipe.transform(value, { type, metatype });
  const ws = "2026-10-24T04:00:00.000Z";

  it("accepts the contract's record request, with or without a breakdown and register", async () => {
    await expect(
      run({ windowStart: ws, amount: 150.25 }, RecordOpeningFloatDto),
    ).resolves.toBeDefined();
    await expect(
      run(
        {
          windowStart: ws,
          amount: 40,
          registerKey: "b",
          denominations: [{ kind: "bill", value: 10, count: 4 }],
        },
        RecordOpeningFloatDto,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a body tenantId / byId / at (not fields), a bad amount, bad date, bad denominations and a bad register", async () => {
    for (const bad of [
      { windowStart: ws, amount: 1, tenantId: "x" },
      { windowStart: ws, amount: 1, byId: "x" },
      { windowStart: ws, amount: 1, at: ws },
      { windowStart: ws, amount: 0.001 },
      { windowStart: ws, amount: -1 },
      { windowStart: ws, amount: "5" },
      { windowStart: "yesterday", amount: 1 },
      { amount: 1 },
      { windowStart: ws, amount: 1, denominations: [{ kind: "bill", value: 7, count: 1 }] },
      { windowStart: ws, amount: 1, registerKey: ":bad" },
    ]) {
      await expect(run(bad, RecordOpeningFloatDto)).rejects.toBeDefined();
    }
  });

  it("the correction needs a trimmed reason of 5 to 500 characters", async () => {
    const ok = { windowStart: ws, amount: 10, reason: "  Recount at open  " };
    const out: any = await run(ok, CorrectOpeningFloatDto);
    expect(out.reason).toBe("Recount at open");
    for (const reason of [undefined, "", "    ", "abcd", "x".repeat(501)]) {
      await expect(run({ ...ok, reason }, CorrectOpeningFloatDto)).rejects.toBeDefined();
    }
  });

  it("the read query needs windowStart", async () => {
    await expect(run({ windowStart: ws }, OpeningFloatQueryDto, "query")).resolves.toBeDefined();
    await expect(run({}, OpeningFloatQueryDto, "query")).rejects.toBeDefined();
  });
});
