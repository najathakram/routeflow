import "reflect-metadata";
import { INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { AppModule } from "../app.module";
import { BuyerJwtStrategy } from "../buyer/strategies/buyer-jwt.strategy";
import { BuyerTenantInterceptor } from "../buyer/buyer-tenant.interceptor";
import { collectControllers, routesOf, type RouteRecord } from "../common/testing/route-table";

/**
 * W-767 (SA-917) — the CUSTOMER sibling of the tenantless-write rule. Excluding CUSTOMER from the SUPER_ADMIN refusal is safe
 * only if every CUSTOMER that reaches a write carries its business. This pins the two facts that rest on:
 *
 *  1. Every write route that admits the CUSTOMER role is listed, by verb, path and `Controller#handler`, and classified:
 *     - "token-tenant": a staff-JWT route (RolesGuard). Its tenant is the token's, so a CUSTOMER with a null tenantId would
 *       write unscoped. TenantRequiredInterceptor warns on that (dark, never refuses) for the census.
 *     - "buyer-scoped": under BuyerTenantInterceptor, which sets the tenant per route.
 *     A new CUSTOMER write fails this list until it is classified.
 *  2. A buyer-app token never looks like a CUSTOMER here: BuyerJwtStrategy puts no `role` (and no tenant) on `req.user`.
 */
type Kind = "token-tenant" | "buyer-scoped";
const EXPECTED: Record<string, Kind> = {
  "DELETE /api/v1/order-templates/:id OrderTemplatesController#remove": "token-tenant",
  "DELETE /api/v1/order-templates/:id/items/:itemId OrderTemplatesController#removeItem":
    "token-tenant",
  "PATCH /api/v1/customers/me CustomersController#updateMyProfile": "token-tenant",
  "PATCH /api/v1/order-templates/:id OrderTemplatesController#update": "token-tenant",
  "PATCH /api/v1/orders/:id/items OrdersController#updateOrderItems": "token-tenant",
  "PATCH /api/v1/orders/:id/status OrdersController#changeStatus": "token-tenant",
  "PATCH /api/v1/orders/:id/urgent OrdersController#toggleUrgent": "token-tenant",
  "POST /api/v1/order-templates OrderTemplatesController#create": "token-tenant",
  "POST /api/v1/order-templates/:id/generate OrderTemplatesController#generateOrder":
    "token-tenant",
  "POST /api/v1/orders OrdersController#create": "token-tenant",
  "POST /api/v1/orders/:id/change-requests OrdersController#createChangeRequest": "token-tenant",
  "POST /api/v1/returns ReturnsController#create": "token-tenant",
  "POST /api/v1/returns/:id/cancel ReturnsController#cancel": "token-tenant",
};

const rows: Array<{ route: RouteRecord; kind: Kind }> = collectControllers(AppModule).flatMap(
  (ctrl) =>
    routesOf(ctrl)
      .filter((r) => r.mutating && (r.roles ?? []).includes("CUSTOMER"))
      .map((route) => {
        const fn = (ctrl as any).prototype[route.handler];
        const interceptors: unknown[] = [
          ...(Reflect.getMetadata(INTERCEPTORS_METADATA, ctrl) ?? []),
          ...(Reflect.getMetadata(INTERCEPTORS_METADATA, fn) ?? []),
        ];
        const kind: Kind = interceptors.includes(BuyerTenantInterceptor)
          ? "buyer-scoped"
          : "token-tenant";
        return { route, kind };
      }),
);

describe("W-767 (SA-917): every write that admits CUSTOMER is classified", () => {
  it("is exactly this list (count, names, class): a new CUSTOMER write is reviewed before it ships", () => {
    const found = Object.fromEntries(
      rows.map((x) => [
        `${x.route.method} ${x.route.path} ${x.route.controller}#${x.route.handler}`,
        x.kind,
      ]),
    );
    expect(found).toEqual(EXPECTED);
  });

  it("a buyer-app token carries no role and no tenant on req.user, so it never reaches the CUSTOMER branch", async () => {
    const strategy = Object.create(BuyerJwtStrategy.prototype) as BuyerJwtStrategy;
    const user = await strategy.validate({
      sub: "b-1",
      email: "b@acme.test",
      type: "BUYER",
    } as any);
    expect(user).not.toHaveProperty("role");
    expect(user).not.toHaveProperty("tenantId");
  });
});
