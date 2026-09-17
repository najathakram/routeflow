import { FeaturePreviewService } from "./feature-preview.service";
import { V11_PIN_FIXTURE, mockCollaborators } from "./feature-fixtures";

function buildPreview(fixture: typeof V11_PIN_FIXTURE) {
  const { entitlements, featureOverrides, catalog, prisma } = mockCollaborators(fixture);
  const preview = new FeaturePreviewService(
    entitlements as any,
    featureOverrides as any,
    catalog as any,
    prisma as any,
  );
  return { preview, featureOverrides };
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
});
