import { normalizeSignupAttribution } from "./signup-attribution";

const NOW = new Date("2026-11-18T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("normalizeSignupAttribution", () => {
  it("keeps every allowed field", () => {
    const firstSeenAt = new Date(NOW.getTime() - 2 * DAY).toISOString();
    expect(
      normalizeSignupAttribution(
        {
          utmSource: "google",
          utmMedium: "cpc",
          utmCampaign: "spring",
          utmTerm: "delivery software",
          utmContent: "ad-a",
          gclid: "g123",
          fbclid: "f123",
          msclkid: "m123",
          landingPath: "/pricing",
          referrerHost: "www.google.com",
          firstSeenAt,
        },
        NOW,
      ),
    ).toEqual({
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "spring",
      utmTerm: "delivery software",
      utmContent: "ad-a",
      gclid: "g123",
      fbclid: "f123",
      msclkid: "m123",
      landingPath: "/pricing",
      referrerHost: "www.google.com",
      firstSeenAt: new Date(firstSeenAt),
    });
  });

  it("removes C1 controls and invisible zero-width characters too", () => {
    expect(
      normalizeSignupAttribution(
        { utmSource: "go\u0085og\u200ble\u00a0\ufeff", utmTerm: "\u200b\u2060" },
        NOW,
      ),
    ).toEqual({ utmSource: "google" });
  });

  it("drops a numeric (IP address) referrer host and a path that starts with two slashes", () => {
    expect(
      normalizeSignupAttribution(
        { referrerHost: "10.0.0.1", landingPath: "//evil.example/x", utmSource: "a" },
        NOW,
      ),
    ).toEqual({ utmSource: "a" });
    expect(normalizeSignupAttribution({ referrerHost: "1password.com" }, NOW)).toEqual({
      referrerHost: "1password.com",
    });
  });

  it("trims strings and removes control characters", () => {
    expect(normalizeSignupAttribution({ utmSource: "  go\u0000og\nle\u007f  " }, NOW)).toEqual({
      utmSource: "google",
    });
  });

  it("caps lengths: utm 200, click ids 255, path 200, host 253", () => {
    const out = normalizeSignupAttribution(
      {
        utmSource: "a".repeat(300),
        gclid: "b".repeat(400),
        landingPath: "/" + "c".repeat(300),
      },
      NOW,
    )!;
    expect(out.utmSource).toHaveLength(200);
    expect(out.gclid).toHaveLength(255);
    expect(out.landingPath).toHaveLength(200);
    const host = Array.from({ length: 6 }, () => "a".repeat(50)).join(".");
    expect(host.length).toBeGreaterThan(253);
    expect(normalizeSignupAttribution({ referrerHost: host }, NOW)).toEqual({
      referrerHost: host.slice(0, 253),
    });
  });

  it("lower-cases a referrer host and drops one that does not look like a host", () => {
    expect(normalizeSignupAttribution({ referrerHost: "WWW.Bing.COM" }, NOW)).toEqual({
      referrerHost: "www.bing.com",
    });
    for (const bad of ["https://bing.com/x", "bing com", "a/b", "-x.com", "bing.com:80", ""]) {
      expect(normalizeSignupAttribution({ referrerHost: bad, utmSource: "x" }, NOW)).toEqual({
        utmSource: "x",
      });
    }
  });

  it("keeps a landing path that starts with a slash and cuts the query and hash", () => {
    expect(normalizeSignupAttribution({ landingPath: "/pricing?a=1#x" }, NOW)).toEqual({
      landingPath: "/pricing",
    });
    expect(normalizeSignupAttribution({ landingPath: "/p#frag" }, NOW)).toEqual({
      landingPath: "/p",
    });
    expect(normalizeSignupAttribution({ landingPath: "pricing", utmSource: "x" }, NOW)).toEqual({
      utmSource: "x",
    });
  });

  it("keeps firstSeenAt only from 90 days ago to one day ahead", () => {
    const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(normalizeSignupAttribution({ firstSeenAt: iso(-89 * DAY) }, NOW)).toEqual({
      firstSeenAt: new Date(iso(-89 * DAY)),
    });
    expect(normalizeSignupAttribution({ firstSeenAt: iso(0.5 * DAY) }, NOW)).toEqual({
      firstSeenAt: new Date(iso(0.5 * DAY)),
    });
    for (const bad of [iso(-91 * DAY), iso(2 * DAY), "not a date", 12345, null]) {
      expect(normalizeSignupAttribution({ firstSeenAt: bad, utmSource: "x" }, NOW)).toEqual({
        utmSource: "x",
      });
    }
  });

  it("ignores unknown keys and non-string values", () => {
    expect(
      normalizeSignupAttribution(
        { utmSource: "x", ip: "1.2.3.4", userAgent: "Mozilla", url: "https://a.b/c", utmMedium: 5 },
        NOW,
      ),
    ).toEqual({ utmSource: "x" });
  });

  it("returns null for non-objects and when nothing usable is left", () => {
    for (const raw of [null, undefined, "utm", 7, true, ["utmSource"]]) {
      expect(normalizeSignupAttribution(raw, NOW)).toBeNull();
    }
    expect(normalizeSignupAttribution({}, NOW)).toBeNull();
    expect(
      normalizeSignupAttribution({ utmSource: "   ", gclid: "\u0000", ip: "1" }, NOW),
    ).toBeNull();
  });
});
