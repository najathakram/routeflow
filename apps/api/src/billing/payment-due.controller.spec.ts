import "reflect-metadata";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { PaymentDuePayDto } from "./dto/payment-due-pay.dto";
import { PaymentDueController } from "./payment-due.controller";

/**
 * Row 542 / 542c: the pay route takes NOTHING from the request but the terms the banner showed. The tenant id is the
 * JWT's (via @CurrentUser) and the amount is the planner's, so the handler declares exactly @CurrentUser plus ONE @Body
 * (the quote, compared and never charged) and no Query / Param / Headers / Req. This pins the route's declared
 * arguments, which `svc.pay.length` (the service's arity) never could.
 */
const proto = PaymentDueController.prototype as unknown as Record<string, unknown>;

/** The route-argument slots a handler declares, e.g. { "3:1": {...} } (3 = Body, 4 = Query, 5 = Param). */
function routeArgs(handler: string): Record<string, { index: number; data?: unknown }> {
  return (Reflect.getMetadata(ROUTE_ARGS_METADATA, PaymentDueController, handler) ?? {}) as Record<
    string,
    { index: number; data?: unknown }
  >;
}

/** Built-in Nest param types (REQUEST 0, RESPONSE 1, NEXT 2, BODY 3, QUERY 4, PARAM 5, HEADERS 6, ...). */
const nestBuiltinParamKeys = (args: Record<string, unknown>) =>
  Object.keys(args).filter((k) => /^\d+:/.test(k));
const BODY = 3;

describe("PaymentDueController: pay takes only the banner's quote from the request", () => {
  it("pay declares exactly TWO route arguments: the custom @CurrentUser (0) and ONE @Body (1); no Query, Param, Headers, Req", () => {
    const args = routeArgs("pay");
    expect(Object.keys(args)).toHaveLength(2);
    // the built-in slots are exactly one Body, whole (no `data` key picking), at index 1
    expect(nestBuiltinParamKeys(args)).toEqual([`${BODY}:1`]);
    expect(args[`${BODY}:1`].index).toBe(1);
    expect(args[`${BODY}:1`].data).toBeUndefined();
    // @CurrentUser is the same decorator the read route uses: the very same custom-arg key, at index 0
    const user = Object.keys(args).find((k) => !/^\d+:/.test(k))!;
    expect(user).toBe(Object.keys(routeArgs("get"))[0]);
    expect(args[user].index).toBe(0);
  });

  it("the Body is typed by the validated DTO", () => {
    const types = Reflect.getMetadata("design:paramtypes", PaymentDueController.prototype, "pay");
    expect(types[1]).toBe(PaymentDuePayDto);
  });

  it("get declares only @CurrentUser", () => {
    const args = routeArgs("get");
    expect(Object.keys(args)).toHaveLength(1);
    expect(nestBuiltinParamKeys(args)).toEqual([]);
  });

  it("the handler declares user + body (arity 2), and get declares the user alone", () => {
    expect((proto.pay as (...a: unknown[]) => unknown).length).toBe(2);
    expect((proto.get as (...a: unknown[]) => unknown).length).toBe(1);
  });
});

describe("PaymentDueController: roles", () => {
  it("the class is OPERATOR and up (the read), and pay is TENANT_ADMIN only (operators cannot pay)", () => {
    expect(Reflect.getMetadata(ROLES_KEY, PaymentDueController)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.pay as object)).toEqual([UserRole.TENANT_ADMIN]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.get as object)).toBeUndefined();
  });
});
