/** Row 556 / SA-970 §2.3 - the interceptor puts the impersonating admin in the request context. */
import { lastValueFrom, of } from "rxjs";
import { currentImpersonatedBy } from "./impersonation-context";
import { TenantContextService } from "./tenant-context.service";
import { TenantInterceptor } from "./tenant.interceptor";

const run = (user: Record<string, unknown> | undefined) => {
  const interceptor = new TenantInterceptor(new TenantContextService());
  const ctx: any = { switchToHttp: () => ({ getRequest: () => ({ user }) }) };
  const handler: any = { handle: () => of(currentImpersonatedBy()) };
  return lastValueFrom(interceptor.intercept(ctx, handler));
};

describe("TenantInterceptor impersonation context", () => {
  it("exposes impersonatedBy for an impersonation token", async () => {
    expect(await run({ tenantId: "t1", impersonatedBy: "sa-1" })).toBe("sa-1");
  });
  it("is null for a normal user and outside a request", async () => {
    expect(await run({ tenantId: "t1" })).toBeNull();
    expect(currentImpersonatedBy()).toBeNull();
  });
});
