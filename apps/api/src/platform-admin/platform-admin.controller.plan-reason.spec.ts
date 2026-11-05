/**
 * R49 / T49 - moving a business to another plan needs a reason. `PATCH platform-admin/tenants/:id/plan`
 * answers 400 without one (the global ValidationPipe runs this DTO), the controller hands the reason to
 * the service untouched, and the service writes it into the plan-change audit row (pinned in
 * platform-admin.service.spec.ts, "R49").
 */
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PlatformAdminController } from "./platform-admin.controller";
import { UpdateTenantPlanDto } from "./dto/update-tenant-plan.dto";

const run = async (body: Record<string, unknown>) =>
  validate(plainToInstance(UpdateTenantPlanDto, body));

describe("R49 UpdateTenantPlanDto - a reason is required", () => {
  it("rejects a move with no reason", async () => {
    const errors = await run({ plan: "GROWTH" });
    expect(errors.map((e) => e.property)).toContain("reason");
  });

  it("rejects a 2-character reason", async () => {
    const errors = await run({ plan: "GROWTH", reason: "ab" });
    expect(errors.map((e) => e.property)).toContain("reason");
  });

  it("rejects a reason that is only spaces", async () => {
    const errors = await run({ plan: "GROWTH", reason: "      " });
    expect(errors.map((e) => e.property)).toContain("reason");
  });

  it("rejects a 501-character reason", async () => {
    const errors = await run({ plan: "GROWTH", reason: "x".repeat(501) });
    expect(errors.map((e) => e.property)).toContain("reason");
  });

  it("rejects a reason that is not a string", async () => {
    const errors = await run({ plan: "GROWTH", reason: 12345 });
    expect(errors.map((e) => e.property)).toContain("reason");
  });

  it("accepts 3 and 500 characters", async () => {
    expect(await run({ plan: "GROWTH", reason: "abc" })).toHaveLength(0);
    expect(await run({ plan: "GROWTH", reason: "x".repeat(500) })).toHaveLength(0);
  });

  it("trims the reason before it is stored", () => {
    const dto = plainToInstance(UpdateTenantPlanDto, {
      plan: "GROWTH",
      reason: "  asked by owner  ",
    });
    expect(dto.reason).toBe("asked by owner");
  });

  it("a bad plan is still rejected", async () => {
    const errors = await run({ plan: "NOT_A_PLAN", reason: "fine reason" });
    expect(errors.map((e) => e.property)).toContain("plan");
  });
});

describe("R49 PlatformAdminController#updatePlan", () => {
  it("passes the reason to the service with the admin id", async () => {
    const svc = { updatePlan: jest.fn().mockResolvedValue({ id: "t-1" }) };
    const stub = () => new Proxy({}, { get: () => jest.fn() });
    const controller = new PlatformAdminController(
      svc as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
      stub() as any,
    );
    const dto = plainToInstance(UpdateTenantPlanDto, { plan: "GROWTH", reason: "owner asked" });
    await controller.updatePlan("t-1", dto, { sub: "admin-1" } as any);
    expect(svc.updatePlan).toHaveBeenCalledWith(
      "t-1",
      expect.objectContaining({ plan: "GROWTH", reason: "owner asked" }),
      "admin-1",
    );
  });
});
