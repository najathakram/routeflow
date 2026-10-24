import { getFamilyCascadePrompt } from "../lib/product-family-cascade";

const err = (status: number, data: unknown) => ({ response: { status, data } });

describe("getFamilyCascadePrompt (409 FAMILY_HAS_ACTIVE_VARIANTS)", () => {
  it("turns the coded 409 into a confirm prompt that names the variant count", () => {
    const p = getFamilyCascadePrompt(
      err(409, { code: "FAMILY_HAS_ACTIVE_VARIANTS", message: "RAW SERVER TEXT", variantCount: 3 }),
    );
    expect(p).toMatchObject({ variantCount: 3, confirmText: "Deactivate all" });
    expect(p?.body).toContain("3 active variants");
    expect(p?.body).not.toContain("RAW SERVER TEXT");
  });

  it("uses the singular for one variant and a generic line when the count is missing", () => {
    expect(
      getFamilyCascadePrompt(err(409, { code: "FAMILY_HAS_ACTIVE_VARIANTS", variantCount: 1 }))
        ?.body,
    ).toContain("1 active variant.");
    expect(
      getFamilyCascadePrompt(err(409, { code: "FAMILY_HAS_ACTIVE_VARIANTS" }))?.body,
    ).toContain("active variants");
  });

  it("is null for any other error, so the generic line shows", () => {
    expect(getFamilyCascadePrompt(err(409, { code: "CODE_TAKEN" }))).toBeNull();
    expect(getFamilyCascadePrompt(err(400, { code: "FAMILY_HAS_ACTIVE_VARIANTS" }))).toBeNull();
    expect(getFamilyCascadePrompt(new Error("boom"))).toBeNull();
    expect(getFamilyCascadePrompt(null)).toBeNull();
  });
});
