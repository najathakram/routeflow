import { routeHitKey } from "./route-hit-key";

describe("routeHitKey (W3)", () => {
  it("is METHOD + the route TEMPLATE, never the concrete URL", () => {
    expect(routeHitKey({ method: "get", route: { path: "/api/v1/customers/:id" } })).toBe(
      "GET /api/v1/customers/:id",
    );
    expect(routeHitKey({ method: "POST", route: { path: "/api/v1/orders" } })).toBe(
      "POST /api/v1/orders",
    );
  });

  it("a request that matched no route (or a non-string route path) is UNMATCHED", () => {
    expect(routeHitKey({ method: "GET" })).toBe("UNMATCHED");
    expect(routeHitKey({ method: "GET", route: {} })).toBe("UNMATCHED");
    expect(routeHitKey({ method: "GET", route: { path: /regex/ } })).toBe("UNMATCHED");
    expect(routeHitKey({ method: "GET", route: { path: "" } })).toBe("UNMATCHED");
    expect(routeHitKey(undefined)).toBe("UNMATCHED");
  });

  it("carries no tenant, user, IP, query or header: only the two parts", () => {
    const req = {
      method: "GET",
      route: { path: "/api/v1/customers/:id" },
      url: "/api/v1/customers/cust-123?token=secret",
      ip: "203.0.113.9",
      user: { tenantId: "t-1", sub: "u-1" },
      headers: { authorization: "Bearer x" },
    };
    const key = routeHitKey(req as never);
    expect(key).toBe("GET /api/v1/customers/:id");
    expect(key).not.toMatch(/cust-123|secret|203\.0|t-1|u-1|Bearer/);
  });
});
