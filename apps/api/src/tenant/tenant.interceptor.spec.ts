import { of } from "rxjs";
import { TenantInterceptor } from "./tenant.interceptor";
import { TenantContextService } from "./tenant-context.service";

/** SA-619 PR-1: the only HTTP setter tags the context with its kind. */
describe("TenantInterceptor kinds (SA-619)", () => {
  const seen = (user: unknown) => {
    const ctx = new TenantContextService();
    const interceptor = new TenantInterceptor(ctx);
    let out: [string | null, string] | null = null;
    const exec: any = { switchToHttp: () => ({ getRequest: () => ({ user }) }) };
    const next: any = {
      handle: () => {
        out = [ctx.getOrNull(), ctx.getKind()];
        return of(1);
      },
    };
    interceptor.intercept(exec, next);
    return out;
  };

  it("a JWT with a tenant => TENANT", () => {
    expect(seen({ sub: "u", tenantId: "t-1", role: "OPERATOR" })).toEqual(["t-1", "TENANT"]);
  });
  it("a JWT with a role but NO tenant => SUPER_ADMIN", () => {
    expect(seen({ sub: "u", tenantId: null, role: "SUPER_ADMIN" })).toEqual([null, "SUPER_ADMIN"]);
    expect(seen({ sub: "u", role: "SUPER_ADMIN" })).toEqual([null, "SUPER_ADMIN"]);
  });
  it("a BUYER principal (no tenant, no role) is NOT a super admin: ANONYMOUS, so the dark telemetry sees it", () => {
    expect(seen({ sub: "b", email: "b@x.test", type: "BUYER" })).toEqual([null, "ANONYMOUS"]);
    // a buyer token must never be promoted even if it somehow carried a role
    expect(seen({ sub: "b", type: "BUYER", role: "SUPER_ADMIN" })).toEqual([null, "ANONYMOUS"]);
  });
  it("a staff principal with a role other than SUPER_ADMIN and no tenant is ANONYMOUS (an orphan, reported)", () => {
    expect(seen({ sub: "u", tenantId: null, role: "OPERATOR" })).toEqual([null, "ANONYMOUS"]);
    expect(seen({ sub: "u", role: "DRIVER" })).toEqual([null, "ANONYMOUS"]);
  });
  it("no user at all (an unauthenticated route) => ANONYMOUS", () => {
    expect(seen(undefined)).toEqual([null, "ANONYMOUS"]);
  });
});
