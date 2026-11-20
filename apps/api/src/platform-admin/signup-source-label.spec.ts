import { bySignupsThenLabel, signupSourceLabel } from "./signup-source-label";

describe("signupSourceLabel", () => {
  it("says Not recorded when there is no row", () => {
    expect(signupSourceLabel(null)).toBe("Not recorded");
    expect(signupSourceLabel(undefined)).toBe("Not recorded");
  });

  it("uses the utm source lower-cased, plus the medium when present", () => {
    expect(signupSourceLabel({ utmSource: "Google" })).toBe("google");
    expect(signupSourceLabel({ utmSource: "Newsletter", utmMedium: "email" })).toBe(
      "newsletter / email",
    );
    expect(signupSourceLabel({ utmSource: "x", utmMedium: "" })).toBe("x");
  });

  it("lower-cases the medium too, so one source never splits into two rows by case", () => {
    expect(signupSourceLabel({ utmSource: "Google", utmMedium: "CPC" })).toBe("google / cpc");
  });

  it("names a click id when there is no utm source", () => {
    expect(signupSourceLabel({ gclid: "g" })).toBe("google / paid (click id)");
    expect(signupSourceLabel({ msclkid: "m" })).toBe("bing / paid (click id)");
    expect(signupSourceLabel({ fbclid: "f" })).toBe("facebook (click id)");
  });

  it("prefers utm over a click id, and a click id over the referrer", () => {
    expect(signupSourceLabel({ utmSource: "Bing", gclid: "g", referrerHost: "a.com" })).toBe(
      "bing",
    );
    expect(signupSourceLabel({ gclid: "g", fbclid: "f", referrerHost: "duckduckgo.com" })).toBe(
      "google / paid (click id)",
    );
    expect(signupSourceLabel({ msclkid: "m", fbclid: "f" })).toBe("bing / paid (click id)");
  });

  it("labels search engine referrers as organic", () => {
    expect(signupSourceLabel({ referrerHost: "www.google.com" })).toBe("google / organic");
    expect(signupSourceLabel({ referrerHost: "www.bing.com" })).toBe("bing / organic");
    expect(signupSourceLabel({ referrerHost: "duckduckgo.com" })).toBe("duckduckgo / organic");
    expect(signupSourceLabel({ referrerHost: "search.yahoo.com" })).toBe("yahoo / organic");
    expect(signupSourceLabel({ referrerHost: "www.google.co.uk" })).toBe("google / organic");
  });

  it("labels AI answer hosts", () => {
    for (const host of [
      "chatgpt.com",
      "chat.openai.com",
      "perplexity.ai",
      "gemini.google.com",
      "copilot.microsoft.com",
    ]) {
      expect(signupSourceLabel({ referrerHost: host })).toBe(`ai answer: ${host}`);
    }
    expect(signupSourceLabel({ referrerHost: "www.perplexity.ai" })).toBe(
      "ai answer: perplexity.ai",
    );
  });

  it("labels any other referrer as a referral and falls back to Direct or unknown", () => {
    expect(signupSourceLabel({ referrerHost: "blog.example.com" })).toBe(
      "referral: blog.example.com",
    );
    expect(signupSourceLabel({ landingPath: "/pricing" })).toBe("Direct or unknown");
    expect(signupSourceLabel({})).toBe("Direct or unknown");
  });
});

// SA-1179 K1: an engine counts only as its registrable name; its mail host is email, not search.
describe("signupSourceLabel: search engines are matched by their registrable name (SA-1179 K1)", () => {
  it.each([
    ["google.evil.com", "referral: google.evil.com"],
    ["google.com.evil.net", "referral: google.com.evil.net"],
    ["mygoogle.com", "referral: mygoogle.com"],
    ["bing.example.org", "referral: bing.example.org"],
    ["duckduckgo.co", "referral: duckduckgo.co"],
    ["yahoo.evil.com", "referral: yahoo.evil.com"],
  ])("%s is a referral, not organic search", (host, label) => {
    expect(signupSourceLabel({ referrerHost: host })).toBe(label);
  });

  it.each([
    ["mail.google.com", "email: mail.google.com"],
    ["mail.yahoo.com", "email: mail.yahoo.com"],
    ["mail.yahoo.co.jp", "email: mail.yahoo.co.jp"],
  ])("%s is email, not organic search", (host, label) => {
    expect(signupSourceLabel({ referrerHost: host })).toBe(label);
  });

  it.each([
    ["www.google.co.uk", "google / organic"],
    ["google.com.au", "google / organic"],
    ["google.de", "google / organic"],
    ["www.yahoo.com", "yahoo / organic"],
    ["search.yahoo.com", "yahoo / organic"],
    ["www.duckduckgo.com", "duckduckgo / organic"],
  ])("%s is still organic search", (host, label) => {
    expect(signupSourceLabel({ referrerHost: host })).toBe(label);
  });

  it("gemini.google.com stays an AI answer", () => {
    expect(signupSourceLabel({ referrerHost: "gemini.google.com" })).toBe(
      "ai answer: gemini.google.com",
    );
  });
});

// SA-1179 K4: the biggest source first, and a tie always in the same (label) order.
describe("bySignupsThenLabel (SA-1179 K4)", () => {
  it("sorts by sign-ups, biggest first, then by label", () => {
    const rows = [
      { source: "referral: b.example", signups: 2 },
      { source: "google / cpc", signups: 5 },
      { source: "Direct or unknown", signups: 2 },
      { source: "bing / organic", signups: 2 },
    ];
    expect([...rows].sort(bySignupsThenLabel).map((r) => r.source)).toEqual([
      "google / cpc",
      "bing / organic",
      "Direct or unknown",
      "referral: b.example",
    ]);
    expect([...rows].reverse().sort(bySignupsThenLabel)).toEqual(
      [...rows].sort(bySignupsThenLabel),
    );
  });
});
