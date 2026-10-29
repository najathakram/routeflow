import "reflect-metadata";
import { ForbiddenException, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { CustomersController } from "../customers/customers.controller";
import { InvoicesController } from "../invoices/invoices.controller";
import { OrdersController } from "../orders/orders.controller";
import { PlatformAdminController } from "../platform-admin/platform-admin.controller";
import { ProductsController } from "../products/products.controller";
import { PlatformScoped } from "./platform-scoped.decorator";
import { TENANT_REQUIRED_MODE, TenantRequiredInterceptor } from "./tenant-required.interceptor";

/**
 * W-767 (SA-908): a SUPER_ADMIN write with no business in the session.
 *
 * The rows run the interceptor against the REAL controllers' metadata: one representative tenant write per area (orders,
 * invoices, payments, products, customers), and a real `@PlatformScoped()` back-office route. Master has no such rule, so
 * a tenantless SUPER_ADMIN write there reaches the handler with no refusal and no warning.
 */
type Ctor = { prototype: any; name: string };
const TENANT_WRITES: Array<[string, Ctor, string, string]> = [
  ["orders", OrdersController, "create", "/orders"],
  ["invoices", InvoicesController, "create", "/invoices"],
  ["payments", InvoicesController, "recordPayment", "/invoices/:id/payments"],
  ["products", ProductsController, "create", "/products"],
  ["customers", CustomersController, "create", "/customers"],
];
const SUPER = { sub: "sa-1", role: "SUPER_ADMIN", tenantId: null } as const;

function ctx(cls: Ctor, handler: string, req: Record<string, unknown>) {
  return {
    getType: () => "http",
    getHandler: () => cls.prototype[handler],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}
const nextOk = () => ({ handle: jest.fn(() => of("handled")) });

describe("TenantRequiredInterceptor (W-767, SA-908)", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());
  const build = (mode: "dark" | "enforced") => {
    const i = new TenantRequiredInterceptor(new Reflector());
    i.mode = mode;
    return i;
  };

  it("ships DARK (the flip to enforced is its own diff, after the census)", () => {
    expect(TENANT_REQUIRED_MODE).toBe("dark");
    expect(new TenantRequiredInterceptor(new Reflector()).mode).toBe("dark");
  });

  describe.each(TENANT_WRITES)(
    "a tenantless SUPER_ADMIN %s write (%p#%s)",
    (_area, cls, handler, path) => {
      const req = () => ({ method: "POST", route: { path: `/api/v1${path}` }, user: SUPER });

      it("enforced: 403 TENANT_CONTEXT_REQUIRED before the handler (nothing is read or written)", () => {
        const next = nextOk();
        let err: unknown;
        try {
          build("enforced").intercept(ctx(cls, handler, req()), next);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          code: API_ERROR_CODES.TENANT_CONTEXT_REQUIRED,
        });
        expect(next.handle).not.toHaveBeenCalled();
      });

      it("dark: the write goes through, with ONE would-deny warning per route per process", async () => {
        const i = build("dark");
        const next = nextOk();
        await expect(lastValueFrom(i.intercept(ctx(cls, handler, req()), next))).resolves.toBe(
          "handled",
        );
        await lastValueFrom(i.intercept(ctx(cls, handler, req()), next));
        expect(next.handle).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(`would-deny POST /api/v1${path}`);
      });
    },
  );

  it.each([
    [
      "an impersonated SUPER_ADMIN (the token carries the business)",
      { ...SUPER, tenantId: "t-1", impersonatedBy: "sa-1" },
      "POST",
    ],
    ["a tenantless SUPER_ADMIN read", SUPER, "GET"],
    ["a tenantless SUPER_ADMIN HEAD", SUPER, "HEAD"],
    [
      "a buyer-app token (the buyer strategy sets no role and no tenant)",
      { sub: "b-1", email: "b@acme.test", type: "BUYER" },
      "POST",
    ],
    [
      "a portal CUSTOMER with its business",
      { sub: "c-1", role: "CUSTOMER", tenantId: "t-1" },
      "POST",
    ],
    ["an OPERATOR", { sub: "o-1", role: "OPERATOR", tenantId: "t-1" }, "POST"],
    ["no user (a public or webhook route)", undefined, "POST"],
  ])("passes %s, even when enforced", async (_label, user, method) => {
    const next = nextOk();
    const req = { method, route: { path: "/api/v1/orders" }, user };
    await expect(
      lastValueFrom(build("enforced").intercept(ctx(OrdersController, "create", req), next)),
    ).resolves.toBe("handled");
    expect(warn).not.toHaveBeenCalled();
  });

  it("SA-917: a staff-token CUSTOMER with NO business is only measured: the write passes (even enforced) with one warning per route", async () => {
    const i = build("enforced");
    const user = { sub: "c-1", role: "CUSTOMER", tenantId: null };
    const req = { method: "PATCH", route: { path: "/api/v1/orders/:id/items" }, user };
    for (let n = 0; n < 2; n++) {
      await expect(
        lastValueFrom(i.intercept(ctx(OrdersController, "create", req), nextOk())),
      ).resolves.toBe("handled");
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      "tenantless-customer-write PATCH /api/v1/orders/:id/items",
    );
    // ...and its reads are not this rule's business.
    await lastValueFrom(
      i.intercept(ctx(OrdersController, "create", { ...req, method: "GET" }), nextOk()),
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("lists a tenantless SUPER_ADMIN read for the census: ONE log line per route, never a warning or a refusal", async () => {
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const i = build("enforced");
      const req = { method: "GET", route: { path: "/api/v1/orders" }, user: SUPER };
      for (let n = 0; n < 2; n++) {
        await expect(
          lastValueFrom(i.intercept(ctx(OrdersController, "create", req), nextOk())),
        ).resolves.toBe("handled");
      }
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain("tenantless-read GET /api/v1/orders");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("passes a real @PlatformScoped() back-office write (class level), even when enforced", async () => {
    const next = nextOk();
    const req = { method: "POST", route: { path: "/api/v1/platform-admin/tenants" }, user: SUPER };
    await expect(
      lastValueFrom(
        build("enforced").intercept(ctx(PlatformAdminController, "createTenant", req), next),
      ),
    ).resolves.toBe("handled");
  });

  it("passes a handler-level @PlatformScoped() write, even when enforced", async () => {
    class Probe {
      @PlatformScoped()
      write() {}
    }
    const next = nextOk();
    const req = { method: "POST", route: { path: "/api/v1/probe" }, user: SUPER };
    await expect(
      lastValueFrom(build("enforced").intercept(ctx(Probe, "write", req), next)),
    ).resolves.toBe("handled");
  });

  it("ignores a non-HTTP context (a queue or cron handler)", async () => {
    const next = nextOk();
    const rpc = { ...ctx(OrdersController, "create", {}), getType: () => "rpc" };
    await expect(lastValueFrom(build("enforced").intercept(rpc, next))).resolves.toBe("handled");
  });
});
