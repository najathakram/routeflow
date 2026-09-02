import { ExecutionContext, Logger } from "@nestjs/common";
import { ImpersonationGuard } from "./impersonation.guard";

const tokenWith = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

function ctx(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe("ImpersonationGuard (B165) — logs impersonated writes from the bearer claim", () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });
  afterEach(() => logSpy.mockRestore());

  it("REG-B165 a POST with impersonatedBy in the bearer token logs admin/acting-as/tenant while req.user is undefined (APP_GUARD ordering)", () => {
    const token = tokenWith({ sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
      url: "/api/v1/orders?x=1",
    };

    expect(new ImpersonationGuard().canActivate(ctx(req))).toBe(true);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0]![0]);
    expect(line).toContain("POST /api/v1/orders");
    expect(line).not.toContain("?x=1");
    expect(line).toContain("admin=sa1");
    expect(line).toContain("acting-as=ta1");
    expect(line).toContain("tenant=t1");
  });

  it("pin (B165): GET with the claim → true, no log", () => {
    const token = tokenWith({ sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" });
    const guard = new ImpersonationGuard();

    // Positive control, in THIS test: B165 is precisely "the guard never fired", so a
    // bare `not.toHaveBeenCalled()` is green against a dead guard and proves nothing.
    // Fire the known-good write first, prove the spy sees it, then clear.
    expect(
      guard.canActivate(
        ctx({
          headers: { authorization: `Bearer ${token}` },
          method: "POST",
          url: "/api/v1/orders",
        }),
      ),
    ).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockClear();

    expect(
      guard.canActivate(
        ctx({
          headers: { authorization: `Bearer ${token}` },
          method: "GET",
          url: "/api/v1/orders",
        }),
      ),
    ).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("pin (B165): no header / malformed token / no claim → true, no log, no throw", () => {
    const g = new ImpersonationGuard();

    // Positive control on the SAME guard instance (see the GET pin above): without
    // it, every assertion below is satisfied by a guard that logs nothing at all.
    expect(
      g.canActivate(
        ctx({
          headers: {
            authorization: `Bearer ${tokenWith({
              sub: "ta1",
              tenantId: "t1",
              impersonatedBy: "sa1",
            })}`,
          },
          method: "POST",
          url: "/api/v1/orders",
        }),
      ),
    ).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockClear();

    expect(g.canActivate(ctx({ headers: {}, method: "POST", url: "/api/v1/orders" }))).toBe(true);
    expect(
      g.canActivate(
        ctx({ headers: { authorization: "Bearer not.a.jwt" }, method: "POST", url: "/x" }),
      ),
    ).toBe(true);
    expect(
      g.canActivate(
        ctx({
          headers: { authorization: `Bearer ${tokenWith({ sub: "u1", tenantId: "t1" })}` },
          method: "DELETE",
          url: "/api/v1/orders/o1",
        }),
      ),
    ).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("pin (B165): a populated req.user with the claim still logs when no header is present", () => {
    const req = {
      headers: {},
      method: "PATCH",
      url: "/api/v1/orders/o1",
      user: { sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" },
    };
    expect(new ImpersonationGuard().canActivate(ctx(req))).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]![0])).toContain("admin=sa1");
  });

  it("REG-B165 sanitises the unverified header claims — CR/LF stripped, oversized values capped — and marks the line unverified", () => {
    const forged =
      "sa1\n[Nest] LOG [ImpersonationGuard] Impersonation write: DELETE /api/v1/tenants";
    const token = tokenWith({
      sub: "u".repeat(500),
      tenantId: "t1\r\nforged",
      impersonatedBy: forged,
    });

    expect(
      new ImpersonationGuard().canActivate(
        ctx({
          headers: { authorization: `Bearer ${token}` },
          method: "POST",
          url: "/api/v1/orders",
        }),
      ),
    ).toBe(true);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0]![0]);
    // An anonymous caller reaches this APP_GUARD, so nothing it supplies may forge a
    // second log line or flood the log with an 8 KB header value.
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).not.toContain("u".repeat(65));
    expect(line.length).toBeLessThan(400);
    expect(line).toContain("claims=unverified-bearer");
  });

  it("REG-B165 a verified req.user claim is logged as claims=verified (distinguishable from a pre-auth probe)", () => {
    const req = {
      headers: {},
      method: "POST",
      url: "/api/v1/orders",
      user: { sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" },
    };
    expect(new ImpersonationGuard().canActivate(ctx(req))).toBe(true);
    expect(String(logSpy.mock.calls[0]![0])).toContain("claims=verified");
  });
});
