/**
 * SA-963 A-1 F-9 (guard): the resolver now carries an override's kind, reason and end date. The tenant's own `GET me/features`
 * reads only `.strict` off it, so a reason an operator wrote about a tenant must never reach the tenant's response.
 */
import { TenantsController } from "./tenants.controller";
import type { JwtPayload } from "../auth/jwt-payload.interface";

describe("TenantsController.getMyFeatures: never leaks the override detail (SA-963 F-9)", () => {
  it("a tenant holding an override with a reason, kind and end date gets none of them back", async () => {
    const authority = {
      resolveAll: jest.fn().mockResolvedValue({
        tenantId: "t1",
        planKey: "TEAM",
        catalogVersionId: "cv1",
        byKey: new Map([
          [
            "flag.estimates",
            {
              key: "flag.estimates",
              effective: true,
              strict: true,
              source: "OVERRIDE_GRANT",
              kind: "SUPPORT",
              reason: "internal-note-do-not-show",
              expiresAt: "2026-11-30T00:00:00.000Z",
              charged: false,
            },
          ],
        ]),
        computedAt: "2026-11-02T00:00:00.000Z",
      }),
      servedFlags: jest.fn().mockResolvedValue([]),
    } as any;
    const controller = new TenantsController(
      {} as any,
      {} as any,
      { getActiveAddons: jest.fn().mockResolvedValue([]) } as any,
      { allActive: jest.fn().mockResolvedValue(new Map()) } as any,
      authority,
      { effectiveForClient: jest.fn().mockResolvedValue({}) } as any,
      { getEffectiveMode: jest.fn().mockResolvedValue("unset") } as any,
    );
    const result = await controller.getMyFeatures({ tenantId: "t1" } as unknown as JwtPayload);
    expect(result.resolver["flag.estimates"]).toBe(true);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("internal-note-do-not-show");
    expect(wire).not.toContain("SUPPORT");
    expect(wire).not.toContain("2026-11-30");
    expect(wire).not.toMatch(/"(reason|kind|expiresAt)"/);
  });
});
