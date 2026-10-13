import "reflect-metadata";
import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { NoImpersonation } from "../decorators/no-impersonation.decorator";
import { NoImpersonationGuard } from "./no-impersonation.guard";

/**
 * SA-778: the guard behind @NoImpersonation. A request whose VERIFIED user carries `impersonatedBy` is
 * refused 403 (coded) before the handler, with one audit row; everything else passes untouched.
 */

class Sample {
  @NoImpersonation("billing")
  guarded() {
    return "ran";
  }

  open() {
    return "ran";
  }
}

@NoImpersonation("billing")
class WholeClass {
  anything() {
    return "ran";
  }
}

const MESSAGE = "This action isn't available in a support session. Ask the account admin to do it.";

function make() {
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const guard = new NoImpersonationGuard(new Reflector(), audit as never);
  return { guard, audit };
}

function ctx(
  handler: (...args: never[]) => unknown,
  klass: new () => unknown,
  req: Record<string, unknown>,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => klass,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const supportUser = { sub: "u-tenant-admin", tenantId: "t-1", impersonatedBy: "sa-1" };
const realAdmin = { sub: "u-tenant-admin", tenantId: "t-1" };
const postReq = (user: unknown, over: Record<string, unknown> = {}) => ({
  user,
  method: "post",
  url: "/api/v1/billing/portal?x=1",
  route: { path: "/api/v1/billing/portal" },
  ip: "10.0.0.1",
  ...over,
});

describe("NoImpersonationGuard (SA-778)", () => {
  it("a support session on a decorated handler is refused 403 with the fixed coded body", async () => {
    const { guard } = make();
    const err = await guard
      .canActivate(ctx(Sample.prototype.guarded, Sample, postReq(supportUser)))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getStatus()).toBe(403);
    expect((err as ForbiddenException).getResponse()).toEqual({
      code: API_ERROR_CODES.IMPERSONATION_NOT_ALLOWED,
      message: MESSAGE,
    });
  });

  it("writes exactly one audit row, with the agreed shape, before it refuses", async () => {
    const { guard, audit } = make();
    const order: string[] = [];
    audit.log.mockImplementation(async () => {
      order.push("audit");
    });

    await guard
      .canActivate(ctx(Sample.prototype.guarded, Sample, postReq(supportUser)))
      .catch(() => order.push("refused"));

    expect(order).toEqual(["audit", "refused"]);
    expect(audit.log).toHaveBeenCalledTimes(1);
    const row = audit.log.mock.calls[0][0];
    expect(row).toMatchObject({
      tenantId: "t-1",
      userId: "u-tenant-admin",
      impersonatedBy: "sa-1",
      action: "impersonation.action-refused",
    });
    expect(row.meta).toEqual({
      superAdminId: "sa-1",
      tenantId: "t-1",
      method: "POST",
      route: "/api/v1/billing/portal",
    });
  });

  it("falls back to the URL path (no query string) when the request carries no route template", async () => {
    const { guard, audit } = make();
    await guard
      .canActivate(
        ctx(Sample.prototype.guarded, Sample, postReq(supportUser, { route: undefined })),
      )
      .catch(() => undefined);
    expect(audit.log.mock.calls[0][0].meta.route).toBe("/api/v1/billing/portal");
  });

  it("a user who is not in a support session passes, with no audit row", async () => {
    const { guard, audit } = make();
    await expect(
      guard.canActivate(ctx(Sample.prototype.guarded, Sample, postReq(realAdmin))),
    ).resolves.toBe(true);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("a handler without the decorator passes untouched for a support session, with no audit row", async () => {
    const { guard, audit } = make();
    await expect(
      guard.canActivate(ctx(Sample.prototype.open, Sample, postReq(supportUser))),
    ).resolves.toBe(true);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("positive control: the same support-session request IS refused on the decorated handler", async () => {
    const { guard } = make();
    await expect(
      guard.canActivate(ctx(Sample.prototype.guarded, Sample, postReq(supportUser))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a decorated class covers every handler on it", async () => {
    const { guard, audit } = make();
    await expect(
      guard.canActivate(ctx(WholeClass.prototype.anything, WholeClass, postReq(supportUser))),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it("reads the claim from the verified user only: a bearer header carrying it does not refuse", async () => {
    const { guard, audit } = make();
    const forged = `h.${Buffer.from(JSON.stringify({ impersonatedBy: "sa-9" })).toString("base64url")}.s`;
    const req = postReq(realAdmin, { headers: { authorization: `Bearer ${forged}` } });
    await expect(guard.canActivate(ctx(Sample.prototype.guarded, Sample, req))).resolves.toBe(true);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("fails closed with 401 when no user has been populated yet (guard ordered before authentication)", async () => {
    const { guard, audit } = make();
    await expect(
      guard.canActivate(ctx(Sample.prototype.guarded, Sample, postReq(undefined))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("a failing audit write still refuses (never turns into a pass)", async () => {
    const { guard, audit } = make();
    audit.log.mockRejectedValue(new Error("db down"));
    await expect(
      guard.canActivate(ctx(Sample.prototype.guarded, Sample, postReq(supportUser))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the decorator attaches the guard itself (a marked route cannot be left without it)", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, Sample.prototype.guarded) as unknown[];
    expect(guards).toContain(NoImpersonationGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, Sample.prototype.open)).toBeUndefined();
  });
});
