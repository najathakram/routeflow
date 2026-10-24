import "reflect-metadata";
import { CatchupAdminController } from "./catchup-admin.controller";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CatchupCheckoutDto } from "./dto/catchup-checkout.dto";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";

const ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

describe("CatchupAdminController", () => {
  it("both routes sit behind JwtAuthGuard + SuperAdminGuard (class-level)", () => {
    const guards: unknown[] = Reflect.getMetadata("__guards__", CatchupAdminController);
    expect(guards).toEqual([JwtAuthGuard, SuperAdminGuard]);
  });

  it("GET catchup-plan is the dry-run and POST catchup-checkout opens it (paths pinned)", () => {
    const proto = CatchupAdminController.prototype;
    expect(Reflect.getMetadata("path", proto.plan)).toBe("tenants/:id/billing/catchup-plan");
    expect(Reflect.getMetadata("path", proto.open)).toBe("tenants/:id/billing/catchup-checkout");
    expect(Reflect.getMetadata("method", proto.plan)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata("method", proto.open)).toBe(1); // RequestMethod.POST
  });

  it("delegates: plan -> the JSON view; open -> the pinned amount", async () => {
    const report = {
      tenantId: ID,
      slug: "qa-x",
      eligible: true,
      ineligible: [],
      claimState: null,
      hasStripeSubscription: false,
      externalPayment: true,
      planKey: "GROWTH",
      priceSource: "catalog" as const,
      monthlyCents: 100,
      rfInvoices: { open: 0, paid: 0 },
      plan: { ok: false as const, reason: "no_monthly_price" as const },
    };
    const svc = {
      plan: jest.fn().mockResolvedValue(report),
      open: jest.fn().mockResolvedValue({ sessionId: "cs_1" }),
    };
    const admin = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
    const c = new CatchupAdminController(svc as any, admin as any);
    expect(await c.plan(ID)).toMatchObject({ tenantId: ID, plan: { ok: false } });
    await c.open(ID, { expectedStubCents: 1234 }, { sub: "sa-1" } as any);
    expect(svc.open).toHaveBeenCalledWith(ID, { expectedStubCents: 1234 });
  });

  it("nit: a successful POST writes an admin audit row naming the admin, the session and the amount; a refusal writes none", async () => {
    const admin = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
    const svc = {
      open: jest
        .fn()
        .mockResolvedValueOnce({
          checkoutUrl: "https://pay.test/cs_1",
          sessionId: "cs_1",
          stubCents: 31000,
          shape: "trial_one_time",
        })
        .mockRejectedValueOnce(new Error("refused")),
    };
    const c = new CatchupAdminController(svc as any, admin as any);
    const out = await c.open(ID, { expectedStubCents: 31000 }, { sub: "sa-1" } as any);
    expect(out).toMatchObject({ sessionId: "cs_1" });
    expect(admin.recordAdminAction).toHaveBeenCalledTimes(1);
    expect(admin.recordAdminAction).toHaveBeenCalledWith(ID, "sa-1", "TENANT_CONFIG_UPDATED", {
      kind: "billing_catchup_checkout_opened",
      sessionId: "cs_1",
      shape: "trial_one_time",
      stubCents: 31000,
    });
    // the checkout URL (a payment link) is never written to the audit trail
    expect(JSON.stringify(admin.recordAdminAction.mock.calls)).not.toContain("pay.test");

    await expect(c.open(ID, { expectedStubCents: 31000 }, { sub: "sa-1" } as any)).rejects.toThrow(
      "refused",
    );
    expect(admin.recordAdminAction).toHaveBeenCalledTimes(1);
  });

  it("the DTO accepts whole non-negative cents only", async () => {
    const ok = plainToInstance(CatchupCheckoutDto, { expectedStubCents: 31000 });
    expect(await validate(ok)).toHaveLength(0);
    for (const bad of [-1, 1.5, "x"]) {
      const dto = plainToInstance(CatchupCheckoutDto, { expectedStubCents: bad });
      expect((await validate(dto)).length).toBeGreaterThan(0);
    }
    // the dry-run amount is REQUIRED: a request without it is invalid
    expect((await validate(plainToInstance(CatchupCheckoutDto, {}))).length).toBeGreaterThan(0);
  });
});
