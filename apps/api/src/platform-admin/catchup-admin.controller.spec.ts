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
    const c = new CatchupAdminController(svc as any);
    expect(await c.plan(ID)).toMatchObject({ tenantId: ID, plan: { ok: false } });
    await c.open(ID, { expectedStubCents: 1234 });
    expect(svc.open).toHaveBeenCalledWith(ID, { expectedStubCents: 1234 });
  });

  it("the DTO accepts whole non-negative cents only", async () => {
    const ok = plainToInstance(CatchupCheckoutDto, { expectedStubCents: 31000 });
    expect(await validate(ok)).toHaveLength(0);
    for (const bad of [-1, 1.5, "x"]) {
      const dto = plainToInstance(CatchupCheckoutDto, { expectedStubCents: bad });
      expect((await validate(dto)).length).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(CatchupCheckoutDto, {}))).toHaveLength(0);
  });
});
