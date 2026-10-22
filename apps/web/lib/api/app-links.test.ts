import { hasAnyAppLink, isValidAppLinkUrl } from "@routeflow/types";
import { hasAnyAppLink as hookHasAny } from "./app-links";

describe("app links shared rule", () => {
  it("isValidAppLinkUrl accepts https with a host only", () => {
    expect(isValidAppLinkUrl("https://example.test/app.apk")).toBe(true);
    expect(isValidAppLinkUrl("http://example.test/app.apk")).toBe(false);
    expect(isValidAppLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isValidAppLinkUrl("https://")).toBe(false);
    expect(isValidAppLinkUrl("not a url")).toBe(false);
    expect(isValidAppLinkUrl("")).toBe(false);
    expect(isValidAppLinkUrl(null)).toBe(false);
    expect(isValidAppLinkUrl(`https://example.test/${"a".repeat(2048)}`)).toBe(false);
  });

  it("hasAnyAppLink is false when all three are null", () => {
    const none = { androidApkUrl: null, playStoreUrl: null, iosUrl: null };
    expect(hasAnyAppLink(none)).toBe(false);
    expect(hookHasAny(none)).toBe(false);
    expect(hasAnyAppLink(undefined)).toBe(false);
    expect(hasAnyAppLink({ ...none, iosUrl: "https://example.test/ios" })).toBe(true);
  });
});
