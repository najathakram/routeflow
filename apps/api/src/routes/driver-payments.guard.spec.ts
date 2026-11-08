import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { DriverPaymentsGuard } from "./driver-payments.guard";

// SA-1106 WP8 (OP-17 sweep): the guard reads the override itself and then asks hasAddon. Both answers stay.
describe("DriverPaymentsGuard (kept caller of hasAddon, WP8)", () => {
  const run = async (opts: {
    amount?: number;
    override?: "GRANT" | "DENY";
    held?: boolean;
    tenantId?: string | null;
  }) => {
    const hasAddon = jest.fn().mockResolvedValue(opts.held ?? false);
    const guard = new DriverPaymentsGuard(
      { hasAddon } as never,
      { get: jest.fn().mockResolvedValue(opts.override) } as never,
    );
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { tenantId: opts.tenantId === undefined ? "t1" : opts.tenantId },
          body: { payment: { amount: opts.amount ?? 20 } },
        }),
      }),
    } as unknown as ExecutionContext;
    return { result: guard.canActivate(ctx), hasAddon };
  };

  it("no payment, or no tenant, passes without reading anything", async () => {
    expect(await (await run({ amount: 0 })).result).toBe(true);
    expect(await (await run({ tenantId: null })).result).toBe(true);
  });
  it("a GRANT passes and a DENY refuses, before hasAddon is asked", async () => {
    const g = await run({ override: "GRANT" });
    expect(await g.result).toBe(true);
    expect(g.hasAddon).not.toHaveBeenCalled();
    const d = await run({ override: "DENY", held: true });
    await expect(d.result).rejects.toBeInstanceOf(ForbiddenException);
    expect(d.hasAddon).not.toHaveBeenCalled();
  });
  it("with no override the held add-on decides", async () => {
    expect(await (await run({ held: true })).result).toBe(true);
    await expect((await run({ held: false })).result).rejects.toBeInstanceOf(ForbiddenException);
  });
});
