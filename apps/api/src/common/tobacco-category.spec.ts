import { isTobaccoCategoryName, TOBACCO_CATEGORY_NAME } from "./tobacco-category";

describe("isTobaccoCategoryName", () => {
  it("matches the canonical name exactly", () => {
    expect(isTobaccoCategoryName("Tobacco")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isTobaccoCategoryName("tobacco")).toBe(true);
  });

  // The DB-side matchers use Prisma's case-insensitive `equals`, which cannot
  // trim — so this helper must not trim either, or a " Tobacco " category would
  // read as the anchor here while every lookup missed it (two Tobacco types).
  it("does NOT trim: a whitespace-padded name is a different category", () => {
    expect(isTobaccoCategoryName(" TOBACCO ")).toBe(false);
    expect(isTobaccoCategoryName("Tobacco ")).toBe(false);
  });

  it("rejects a name that merely contains the word", () => {
    expect(isTobaccoCategoryName("Tobacco Products")).toBe(false);
  });

  it("rejects null, undefined, and empty string", () => {
    expect(isTobaccoCategoryName(null)).toBe(false);
    expect(isTobaccoCategoryName(undefined)).toBe(false);
    expect(isTobaccoCategoryName("")).toBe(false);
  });

  it("exposes the canonical name constant", () => {
    expect(TOBACCO_CATEGORY_NAME).toBe("Tobacco");
  });
});
