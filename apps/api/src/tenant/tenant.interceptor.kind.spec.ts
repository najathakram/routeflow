/** SA-1105 Q1: the interceptor sets the context kind from the verified JWT, and never SYSTEM. */
import { lastValueFrom, of } from "rxjs";
import { TenantContextService } from "./tenant-context.service";
import { TenantInterceptor } from "./tenant.interceptor";

class OrdersController {
  create() {
    return undefined;
  }
}

const kindFor = (user: Record<string, unknown> | undefined) => {
  const tenantContext = new TenantContextService();
  const interceptor = new TenantInterceptor(tenantContext);
  const ctx: any = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getClass: () => OrdersController,
    getHandler: () => OrdersController.prototype.create,
  };
  const handler: any = {
    handle: () =>
      of({
        kind: tenantContext.kind(),
        tenantId: tenantContext.getOrNull(),
        label: tenantContext.label(),
      }),
  };
  return lastValueFrom(interceptor.intercept(ctx, handler));
};

describe("TenantInterceptor sets the kind of the request context", () => {
  it("a tenant user is TENANT, with the Controller.handler label for the dark warn", async () => {
    expect(await kindFor({ tenantId: "t1", role: "OPERATOR" })).toEqual({
      kind: "TENANT",
      tenantId: "t1",
      label: "OrdersController.create",
    });
  });

  it("a platform admin with no business is SUPER_ADMIN", async () => {
    expect((await kindFor({ tenantId: null, role: "SUPER_ADMIN" })).kind).toBe("SUPER_ADMIN");
  });

  it("an impersonation token (a super admin's role, a tenant in the token) is TENANT", async () => {
    expect(
      (await kindFor({ tenantId: "t1", role: "SUPER_ADMIN", impersonatedBy: "sa-1" })).kind,
    ).toBe("TENANT");
  });

  it("no user, or a user with no tenant who is not a super admin, is ANONYMOUS", async () => {
    expect((await kindFor(undefined)).kind).toBe("ANONYMOUS");
    expect((await kindFor({ tenantId: null, role: "CUSTOMER" })).kind).toBe("ANONYMOUS");
  });
});
