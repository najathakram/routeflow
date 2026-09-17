import { FeaturePreviewService } from "./feature-preview.service";
import { V11_PIN_FIXTURE, mockCollaborators } from "./feature-fixtures";

function buildPreview(fixture: typeof V11_PIN_FIXTURE, flagsOverride?: string[]) {
  const { entitlements, featureOverrides, catalog, prisma } = mockCollaborators(
    fixture,
    flagsOverride,
  );
  const preview = new FeaturePreviewService(
    entitlements as any,
    featureOverrides as any,
    catalog as any,
    prisma as any,
  );
  return { preview, featureOverrides, catalog };
}

// Oracle 6: preview == post-apply trace, 0 writes.
describe("FeaturePreviewService — oracle 6 (preview == post-apply trace, 0 writes)", () => {
  it("a hypothetical GRANT override changes only that key's `after.resolver`, and `changed` names exactly it", async () => {
    const { preview, featureOverrides } = buildPreview(V11_PIN_FIXTURE);

    const result = await preview.preview("t1", {
      overrides: [{ featureKey: "flag.estimates", effect: "GRANT", reason: "pilot" }],
    });

    const before = result.before.find((f) => f.key === "flag.estimates")!;
    const after = result.after.find((f) => f.key === "flag.estimates")!;
    expect(before.resolver).toBe(false); // dark, not held, resolver has no courtesy logic
    expect(after.resolver).toBe(true);
    expect(after.source).toBe("OVERRIDE_GRANT");
    expect(result.changed).toEqual(["flag.estimates"]);

    // Zero writes: the override store was only ever READ, never created/updated.
    expect(featureOverrides.get).not.toHaveBeenCalled();
    expect((featureOverrides as any).create).toBeUndefined();
  });

  it("matches what applying the SAME override for real would then resolve to", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE);
    const previewResult = await preview.preview("t1", {
      overrides: [{ featureKey: "flag.estimates", effect: "GRANT", reason: "pilot" }],
    });

    // Simulate "post-apply": the override is now actually active — same fixture, override applied.
    const postApplyFixture = {
      ...V11_PIN_FIXTURE,
      overrides: [{ featureKey: "flag.estimates" as const, effect: "GRANT" as const }],
    };
    const { preview: postApplyPreview } = buildPreview(postApplyFixture);
    const postApplyResult = await postApplyPreview.preview("t1", {});

    const previewAfter = previewResult.after.find((f) => f.key === "flag.estimates")!;
    const postApplyBefore = postApplyResult.before.find((f) => f.key === "flag.estimates")!;
    expect(previewAfter.resolver).toBe(postApplyBefore.resolver);
    expect(previewAfter.source).toBe(postApplyBefore.source);
  });

  it("a hypothetical plan downgrade shows losses without touching the real entitlements read", async () => {
    const { preview, featureOverrides } = buildPreview(V11_PIN_FIXTURE);
    const result = await preview.preview("t1", { planKey: "STARTER" });

    const beforeReports = result.before.find((f) => f.key === "flag.reports")!;
    const afterReports = result.after.find((f) => f.key === "flag.reports")!;
    expect(beforeReports.resolver).toBe(true); // SCALE's fixture featureFlags include flag.reports
    expect(afterReports.resolver).toBe(false); // STARTER's fixture featureFlags do not
    expect(result.changed).toContain("flag.reports");
    expect(featureOverrides.get).not.toHaveBeenCalled();
  });

  // Item 6 (Opus review of 9923b87c): preview == post-apply, covering an addon-granted flag
  // AND a plan swap together — the combination the two isolated tests above never exercise.
  it("preview == post-apply: an addon-granted flag survives a plan swap", async () => {
    // flag.messaging is bridged via an active addon SKU (in ent.flags, NOT in SCALE's own
    // featureFlags) — exactly resolveOneKey's ADDON_SKU branch.
    const scaleWithAddonFlag = { ...V11_PIN_FIXTURE, name: "scale-with-addon-flag" };
    const { preview } = buildPreview(scaleWithAddonFlag, [
      "flag.msrp",
      "flag.sales_agents",
      "flag.reports",
      "flag.returns",
      "flag.messaging",
    ]);

    const previewResult = await preview.preview("t1", { planKey: "STARTER" }); // lacks flag.messaging too
    const previewAfterMessaging = previewResult.after.find((f) => f.key === "flag.messaging")!;
    expect(previewAfterMessaging.resolver).toBe(true);
    expect(previewAfterMessaging.source).toBe("ADDON_SKU");
    // Sanity: a flag genuinely lost by the swap (SCALE-included, STARTER-excluded, never
    // addon-bridged) really is lost — proves the addon isolation isn't "everything survives".
    const previewAfterReports = previewResult.after.find((f) => f.key === "flag.reports")!;
    expect(previewAfterReports.resolver).toBe(false);

    // "Post-apply": the tenant is now ACTUALLY on STARTER, still holding the same
    // addon-bridged flag — a real plan swap never touches addon grants.
    const postApplyFixture = { ...scaleWithAddonFlag, planKey: "STARTER" };
    const { preview: postApplyPreview } = buildPreview(postApplyFixture, [
      "flag.msrp",
      "flag.messaging",
    ]);
    const postApplyResult = await postApplyPreview.preview("t1", {});
    const postApplyBeforeMessaging = postApplyResult.before.find(
      (f) => f.key === "flag.messaging",
    )!;

    expect(previewAfterMessaging.resolver).toBe(postApplyBeforeMessaging.resolver);
    expect(previewAfterMessaging.source).toBe(postApplyBeforeMessaging.source);
  });

  // Item 6(b): the target plan resolves against the CURRENT PUBLISHED catalog, never the
  // tenant's own (possibly stale) pinned version — a plan the pinned version doesn't even
  // carry must still preview correctly.
  it("resolves the swap target against the published catalog, not the tenant's pinned version", async () => {
    const { preview, catalog } = buildPreview(V11_PIN_FIXTURE);
    (catalog.getPublishedCatalog as jest.Mock).mockResolvedValue({
      id: "fixture-v12-published",
      definitions: [
        ...V11_PIN_FIXTURE.definitions,
        {
          planKey: "ENTERPRISE",
          featureFlags: ["flag.msrp", "flag.sales_agents", "flag.reports", "flag.analytics"],
        },
      ],
      addonSkus: [],
    });

    const result = await preview.preview("t1", { planKey: "ENTERPRISE" });

    const afterAnalytics = result.after.find((f) => f.key === "flag.analytics")!;
    expect(afterAnalytics.resolver).toBe(true); // only resolvable via the PUBLISHED catalog's def
    expect(afterAnalytics.detail.catalogVersionId).toBe("fixture-v12-published");
  });
});
