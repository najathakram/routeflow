import "reflect-metadata";
import { ExecutionContext, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import { NoImpersonation } from "../auth/decorators/no-impersonation.decorator";
import { NoImpersonationGuard } from "../auth/guards/no-impersonation.guard";
import { OrdersController } from "../orders/orders.controller";
import { TenantRequiredInterceptor } from "../tenant/tenant-required.interceptor";
import { LockConflictFilter } from "./lock-conflict.filter";

/**
 * F03 slice 1: when Express has no matched route, three sinks fall back to the request path. That path can hold a
 * single-use link token, so the fallback goes through `redactPath`. Each row feeds a token-bearing path with NO route
 * and reads back everything the sink wrote.
 */
const TOKEN = "Zk3Pq9Lm2Xv7Rt5Wy8Nb4Hd1Cs6Fg0Ja";
const PATH = `/api/v1/buyer/invites/${TOKEN}/accept`;

class Sample {
  @NoImpersonation("billing")
  guarded() {
    return "ran";
  }
}

describe("fallback route sinks never hold a link token", () => {
  afterEach(() => jest.restoreAllMocks());

  it("no-impersonation guard: the refusal audit row", async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const guard = new NoImpersonationGuard(new Reflector(), audit as never);
    const ctx = {
      getHandler: () => Sample.prototype.guarded,
      getClass: () => Sample,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: "u1", tenantId: "t1", impersonatedBy: "sa-1" },
          method: "post",
          url: `${PATH}?t=${TOKEN}`,
          ip: "10.0.0.1",
        }),
      }),
    } as unknown as ExecutionContext;
    await guard.canActivate(ctx).catch(() => undefined);
    expect(audit.log).toHaveBeenCalledTimes(1);
    const written = JSON.stringify(audit.log.mock.calls);
    expect(written).not.toContain(TOKEN);
    expect(written).toContain("/api/v1/buyer/invites/:redacted/accept");
  });

  it("tenant-required interceptor: the would-deny warning", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const interceptor = new TenantRequiredInterceptor(new Reflector());
    interceptor.mode = "dark";
    const ctx = {
      getType: () => "http",
      getHandler: () => OrdersController.prototype.create,
      getClass: () => OrdersController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: "sa-1", role: "SUPER_ADMIN", tenantId: null },
          method: "POST",
          path: PATH,
          url: `${PATH}?t=${TOKEN}`,
        }),
      }),
    } as never;
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of("ok") }));
    const written = JSON.stringify([warn.mock.calls, log.mock.calls]);
    expect(written).not.toContain(TOKEN);
    expect(written).toContain("/api/v1/buyer/invites/:redacted/accept");
  });

  it("lock-conflict filter: the route used for the log and the Sentry tag", () => {
    const filter = new LockConflictFilter(undefined as never);
    const routeOf = (filter as unknown as { routeOf(req: unknown): string }).routeOf.bind(filter);
    const out = routeOf({ method: "POST", originalUrl: `${PATH}?t=${TOKEN}` });
    expect(out).toBe("POST /api/v1/buyer/invites/:redacted/accept");
    expect(out).not.toContain(TOKEN);
  });
});
