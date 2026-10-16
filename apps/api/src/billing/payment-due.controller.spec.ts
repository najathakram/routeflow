import "reflect-metadata";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { PaymentDueController } from "./payment-due.controller";

/**
 * Row 542: the pay route takes NOTHING from the request. The tenant id is the JWT's (via @CurrentUser) and the amount
 * is the planner's, so the handler must declare no Body / Query / Param argument. This pins the route's declared
 * arguments, which `svc.pay.length` (the service's arity) never could.
 */
const proto = PaymentDueController.prototype as unknown as Record<string, unknown>;

/** The route-argument slots a handler declares, e.g. { "3:0": {...} } (3 = Body, 4 = Query, 5 = Param). */
function routeArgs(handler: string): Record<string, { index: number; data?: unknown }> {
  return (Reflect.getMetadata(ROUTE_ARGS_METADATA, PaymentDueController, handler) ?? {}) as Record<
    string,
    { index: number; data?: unknown }
  >;
}

/** Built-in Nest param types (REQUEST 0, RESPONSE 1, NEXT 2, BODY 3, QUERY 4, PARAM 5, HEADERS 6, ...). */
const nestBuiltinParamKeys = (args: Record<string, unknown>) =>
  Object.keys(args).filter((k) => /^\d+:/.test(k));

describe("PaymentDueController: pay takes nothing from the request", () => {
  it("pay declares exactly ONE route argument, the custom @CurrentUser (no Body, Query, Param, Headers, Req)", () => {
    const args = routeArgs("pay");
    expect(Object.keys(args)).toHaveLength(1);
    expect(nestBuiltinParamKeys(args)).toEqual([]);
    expect(Object.values(args)[0].index).toBe(0);
    // @CurrentUser is the same decorator the read route uses: the very same custom-arg key
    expect(Object.keys(args)).toEqual(Object.keys(routeArgs("get")));
  });

  it("get declares only @CurrentUser too", () => {
    const args = routeArgs("get");
    expect(Object.keys(args)).toHaveLength(1);
    expect(nestBuiltinParamKeys(args)).toEqual([]);
  });

  it("the handler body reads no other parameter (the declared function arity is the one user)", () => {
    expect((proto.pay as (...a: unknown[]) => unknown).length).toBe(1);
  });
});

describe("PaymentDueController: roles", () => {
  it("the class is OPERATOR and up (the read), and pay is TENANT_ADMIN only (operators cannot pay)", () => {
    expect(Reflect.getMetadata(ROLES_KEY, PaymentDueController)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.pay as object)).toEqual([UserRole.TENANT_ADMIN]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.get as object)).toBeUndefined();
  });
});
