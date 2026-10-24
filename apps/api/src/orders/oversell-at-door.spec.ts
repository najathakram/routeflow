import * as fs from "node:fs";
import * as path from "node:path";
import { UserRole } from "@prisma/client";
import { resolveOversellAllowed, type OversellSource } from "./oversell-policy";

/**
 * C7a regression pin (GREEN today, must stay green after the call-site PR): the driver at-door path
 * (`OrdersService.approveChangeRequestAtStop`) makes ZERO `resolveOversellAllowed` calls and never
 * oversells. A DRIVER resolver hard-blocks through settleStockForEdit's role rule; the policy never
 * applies to it (a driver must not be able to backorder a buyer's order at the door).
 *
 * Seams: (1) the helper: a DRIVER is false for every source with zero reads; (2) a static scan of the
 * method body in orders.service.ts. LIMIT of (2): text only. Driving the whole at-door method needs
 * the stop/run/change-request graph; the behavioural no-read guarantee for any transaction callback
 * is pinned in order-stock-lock-order-callsites.spec.ts.
 */
describe("driver at-door: no policy, never oversells", () => {
  const SOURCES: OversellSource[] = ["staff_entry", "buyer", "promotion", "edit", "template_cron"];

  it.each(SOURCES.filter((s) => s !== "template_cron"))(
    "helper: a DRIVER is false for source %s and never reads the policy",
    async (source) => {
      const read = jest.fn(async () => "backorder");
      await expect(
        resolveOversellAllowed({ read }, { tenantId: "t", role: UserRole.DRIVER, source }),
      ).resolves.toBe(false);
      expect(read).not.toHaveBeenCalled();
    },
  );

  const src = fs.readFileSync(path.join(__dirname, "orders.service.ts"), "utf8");
  const start = src.indexOf("async approveChangeRequestAtStop(");
  // approveChangeRequestAtStop is followed by updateShipment in orders.service.ts
  const end = src.indexOf("  async updateShipment(", start);
  const body = start < 0 || end < 0 ? "" : src.slice(start, end);

  it("finds the at-door method body (the scan is not vacuous)", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("settleStockForEdit");
  });

  it("the at-door body makes no resolveOversellAllowed call, reads no policy and passes no allowOversell", () => {
    expect(body).not.toMatch(/resolveOversellAllowed|oversellReader|policyValue|\.policies\b/);
    expect(body).not.toMatch(/allowOversell/);
  });
});
