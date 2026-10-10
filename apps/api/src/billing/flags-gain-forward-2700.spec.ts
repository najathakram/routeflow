/**
 * #2700 (lead verdict on c2f91354, F2/F3 + pins): "flags gain forward" must hold on EVERY surface
 * that reads plan flags, not only EntitlementsService.compute —
 *  - FeatureResolverService: a gained-forward flag is PRESET (included, not charged), never
 *    ADDON_SKU/charged (Backoffice would show Returns as BILLED on a v12-pinned Lite tenant);
 *  - FeaturePreviewService: the after-state keeps what apply keeps (no false "lost");
 *  - a DENY override still wins over a union-granted flag.
 */
import { FeatureResolverService } from "./feature-resolver.service";
import { FeaturePreviewService } from "./feature-preview.service";
import { LITE_FIXTURE, mockCollaborators } from "./feature-fixtures";

/** A LITE tenant pinned to a v12-shaped version (LITE has no flags); v13 is published. */
const PINNED_V12 = {
  id: "fixture-v12",
  status: "SUPERSEDED",
  definitions: [{ planKey: "LITE", featureFlags: [] as string[] }],
  addonSkus: [],
};
const PUBLISHED_V13 = {
  id: "fixture-v13",
  status: "PUBLISHED",
  definitions: [{ planKey: "LITE", featureFlags: ["flag.returns"] }],
  addonSkus: [],
};

function collaborators(overrides: Array<{ featureKey: string; effect: "GRANT" | "DENY" }> = []) {
  // ent.flags is what compute() now resolves: the pinned [] ∪ the published LITE's flag.returns.
  const c = mockCollaborators({ ...LITE_FIXTURE, planVersionId: PINNED_V12.id, overrides }, [
    "flag.returns",
  ]);
  c.catalog.getVersionForTenant.mockResolvedValue(PINNED_V12);
  c.catalog.getPublishedVersion.mockResolvedValue(PUBLISHED_V13);
  c.catalog.getPublishedCatalog.mockResolvedValue(PUBLISHED_V13);
  return c;
}

const resolverOf = (c: ReturnType<typeof collaborators>) =>
  new FeatureResolverService(
    c.entitlements as any,
    c.featureOverrides as any,
    c.catalog as any,
    c.prisma as any,
  );

describe("#2700 flags gain forward — FeatureResolverService (F2)", () => {
  it("a gained-forward plan flag resolves PRESET, included and NOT charged (never ADDON_SKU/billed)", async () => {
    const resolved = await resolverOf(collaborators()).resolve("t1");
    expect(resolved!.byKey.get("flag.returns")).toEqual({
      key: "flag.returns",
      effective: true,
      source: "PRESET",
      term: "flag",
      charged: false,
    });
  });

  it("a DENY override still wins over a union-granted flag", async () => {
    const resolved = await resolverOf(
      collaborators([{ featureKey: "flag.returns", effect: "DENY" }]),
    ).resolve("t1");
    expect(resolved!.byKey.get("flag.returns")).toMatchObject({ effective: false });
  });

  it("reads the published version only when the pinned one is not itself PUBLISHED", async () => {
    const c = collaborators();
    c.catalog.getVersionForTenant.mockResolvedValue({ ...PUBLISHED_V13 });
    await resolverOf(c).resolve("t1");
    expect(c.catalog.getPublishedVersion).not.toHaveBeenCalled();
  });
});

describe("#2700 flags gain forward — FeaturePreviewService (F3)", () => {
  const previewOf = (c: ReturnType<typeof collaborators>) =>
    new FeaturePreviewService(
      c.entitlements as any,
      c.featureOverrides as any,
      c.catalog as any,
      c.prisma as any,
    );

  it("a no-op preview shows the gained-forward flag held BEFORE and AFTER (apply keeps it; never a false 'lost')", async () => {
    const result = await previewOf(collaborators()).preview("t1", {});
    const before = result.before.find((f) => f.key === "flag.returns")!;
    const after = result.after.find((f) => f.key === "flag.returns")!;
    expect(before.resolver).toBe(true);
    expect(after.resolver).toBe(true);
    expect(result.changed).not.toContain("flag.returns");
  });

  it("the default-granted orders_inline_returns (requires flag.returns) is not shown as lost either", async () => {
    const result = await previewOf(collaborators()).preview("t1", {});
    const after = result.after.find((f) => f.key === "orders_inline_returns")!;
    expect(after.resolver).toBe(true);
    expect(result.changed).not.toContain("orders_inline_returns");
  });
});
