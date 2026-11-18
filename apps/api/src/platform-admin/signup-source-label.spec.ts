import { signupSourceLabel } from "./signup-source-label";

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
