import { buildSignupAttribution } from "./signup-attribution";

const ORIGIN = "https://app.routeflow.test";
const base = { search: "", firstTouch: null, referrer: "", origin: ORIGIN };

describe("buildSignupAttribution", () => {
  it("reads the tracked keys from the sign-up page's own URL", () => {
    expect(
      buildSignupAttribution({
        ...base,
        search:
          "?utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_term=route+software&utm_content=a" +
          "&gclid=g1&fbclid=f1&msclkid=m1&other=ignored",
      }),
    ).toEqual({
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "spring",
      utmTerm: "route software",
      utmContent: "a",
      gclid: "g1",
      fbclid: "f1",
      msclkid: "m1",
    });
  });

  it("returns undefined when there is nothing to send", () => {
    expect(buildSignupAttribution(base)).toBeUndefined();
    expect(buildSignupAttribution({ ...base, search: "?foo=bar" })).toBeUndefined();
  });

  it("prefers the URL over the first-touch record, field by field, and fills the rest from it", () => {
    const firstTouch = JSON.stringify({
      utm_source: "newsletter",
      utm_medium: "email",
      gclid: "old",
      landingPath: "/pricing",
      firstSeenAt: "2026-11-10T10:00:00.000Z",
      referrerHost: "www.google.com",
    });
    expect(buildSignupAttribution({ ...base, search: "?utm_source=google", firstTouch })).toEqual({
      utmSource: "google",
      utmMedium: "email",
      gclid: "old",
      landingPath: "/pricing",
      firstSeenAt: "2026-11-10T10:00:00.000Z",
      referrerHost: "www.google.com",
    });
  });

  it("uses a same-origin referrer's tracked params and path, never its host", () => {
    expect(
      buildSignupAttribution({
        ...base,
        referrer: `${ORIGIN}/pricing?utm_source=ads&utm_medium=cpc&secret=1#frag`,
      }),
    ).toEqual({ utmSource: "ads", utmMedium: "cpc", landingPath: "/pricing" });
  });

  it("keeps only the hostname of a cross-origin referrer", () => {
    const out = buildSignupAttribution({
      ...base,
      referrer: "https://www.google.com:8443/search?q=route+software&utm_source=x#top",
    });
    expect(out).toEqual({ referrerHost: "www.google.com" });
  });

  it("lets the first-touch record and the URL win over the referrer", () => {
    expect(
      buildSignupAttribution({
        ...base,
        search: "?utm_source=a",
        firstTouch: JSON.stringify({ landingPath: "/first", referrerHost: "first.example" }),
        referrer: `${ORIGIN}/other?utm_source=b&utm_medium=m`,
      }),
    ).toEqual({
      utmSource: "a",
      utmMedium: "m",
      landingPath: "/first",
      referrerHost: "first.example",
    });
  });

  it("tolerates a missing or malformed first-touch record", () => {
    for (const firstTouch of ["{not json", "null", "42", '"text"', "[1,2]", ""]) {
      expect(buildSignupAttribution({ ...base, search: "?gclid=g", firstTouch })).toEqual({
        gclid: "g",
      });
    }
    expect(
      buildSignupAttribution({
        ...base,
        firstTouch: JSON.stringify({ utm_source: 5, landingPath: { a: 1 } }),
      }),
    ).toBeUndefined();
  });

  it("ignores an unparseable referrer", () => {
    expect(buildSignupAttribution({ ...base, referrer: "not a url" })).toBeUndefined();
  });

  it("never returns a full URL or a query string", () => {
    const out = buildSignupAttribution({
      ...base,
      search: "?utm_source=google",
      referrer: "https://blog.example.com/post?id=7&email=a@b.c#x",
      firstTouch: JSON.stringify({ landingPath: "/pricing?x=1#y" }),
    });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toContain("email=");
    expect(text).not.toContain("?");
    expect(out?.landingPath).toBe("/pricing");
    expect(out?.referrerHost).toBe("blog.example.com");
  });
});
