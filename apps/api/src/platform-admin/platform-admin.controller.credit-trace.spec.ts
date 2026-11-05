/**
 * SA-1099 A-1, row SV-7: the explain trace for the credit check tells the same truth as the preview
 * drawer. The trace reads `serving` from `EntitlementAuthority.computeOldPathAll` -> `servedAnswer`,
 * and `effective` / `term` from the resolver; both go through the REAL services here (only their
 * database collaborators are faked), so a drift between the two shows up as `serving` != `effective`.
 *
 * Facts: a plan that lacks `flag.credit_limits`, no override, `PLAN_FLAG_ENFORCEMENT` unset. The
 * guard runs the check for this tenant, so the trace must say it is served, by courtesy.
 */
import "reflect-metadata";
import { PlatformAdminController } from "./platform-admin.controller";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureResolverService } from "../billing/feature-resolver.service";
import { V10_PIN_FIXTURE, mockCollaborators } from "../billing/feature-fixtures";

const SWITCH = "PLAN_FLAG_ENFORCEMENT";
const CREDIT = "flag.credit_limits";
const saved = process.env[SWITCH];
afterEach(() => {
  if (saved === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = saved;
});

function controller() {
  const { entitlements, featureOverrides, catalog, prisma } = mockCollaborators(V10_PIN_FIXTURE);
  const resolver = new FeatureResolverService(
    entitlements as never,
    featureOverrides as never,
    catalog as never,
    prisma as never,
  );
  const authority = new EntitlementAuthority(
    entitlements as never,
    featureOverrides as never,
    resolver,
    { getMode: jest.fn(async () => "shadow") } as never,
    {} as never,
    prisma as never,
  );
  const stub = () => ({}) as never;
  return new PlatformAdminController(
    stub(), // svc
    stub(), // platformConfig
    stub(), // billingService
    stub(), // addonService
    featureOverrides as never,
    { getMode: jest.fn(async () => "shadow") } as never, // entitlementsMode
    stub(), // configSnapshotFlag
    stub(), // featureDiffs
    authority as never,
    stub(), // featurePreview
    stub(), // snapshotAdmin
    stub(), // businessProfiles
    { getState: jest.fn() } as never, // featureConfig
    stub(), // businessProfileApply
  );
}

describe("SV-7: GET tenants/:id/features/effective/flag.credit_limits", () => {
  it("switch unset, plan lacks the flag: serving true, effective true, term courtesy", async () => {
    delete process.env[SWITCH];
    const row = await controller().getTenantFeatureEffective("t1", CREDIT);
    expect(row).toMatchObject({ key: CREDIT, serving: true });
    expect((row as { detail: { term?: string } }).detail.term).toBe("courtesy");
    // the owner's rule (resolver = strict) is still "not in the plan"
    expect((row as { resolver: boolean }).resolver).toBe(false);
  });

  it("the list form agrees with the single-key form for this row", async () => {
    delete process.env[SWITCH];
    const c = controller();
    const list = (await c.getTenantFeaturesEffective("t1")) as {
      effective: Array<{ key: string; serving: boolean; detail: { term?: string } }>;
    };
    const one = list.effective.find((f) => f.key === CREDIT)!;
    expect(one.serving).toBe(true);
    expect(one.detail.term).toBe("courtesy");
  });

  it("switch 'on', plan lacks the flag: serving false (the guard skips the check)", async () => {
    process.env[SWITCH] = "on";
    const row = await controller().getTenantFeatureEffective("t1", CREDIT);
    expect((row as { serving: boolean }).serving).toBe(false);
  });
});
