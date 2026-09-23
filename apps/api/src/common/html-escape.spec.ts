import { Logger } from "@nestjs/common";
import {
  escapeHtml,
  refusedEmailLinkCount,
  safeLinkHref,
  schemelessLinkBaseVars,
} from "./html-escape";

/** B809 (REG-B809) — the one shared escaper, the link helpers' scheme guard, the boot check. */
describe("B809 — escapeHtml (the one shared copy)", () => {
  it("escapes all five HTML-significant characters, including the ' one copy used to skip", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("accepts a number (it renders as digits)", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("B809 — safeLinkHref (a link can only ever be http(s), and it never throws)", () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it.each(["https://app.example.com/reset-password?token=ab12", "http://localhost:3001/x"])(
    "passes %s through unchanged, with nothing logged",
    (url) => {
      expect(safeLinkHref(url, "test")).toBe(url);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "mailto:someone@example.com",
    "/relative/path",
    "www.example.com/no-scheme",
    "",
  ])("refuses %j: returns null, logs an error and counts it", (url) => {
    const before = refusedEmailLinkCount();
    expect(safeLinkHref(url, "renderBrandButton")).toBeNull();
    expect(refusedEmailLinkCount()).toBe(before + 1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/^renderBrandButton: refused an email link/);
  });

  it("never logs the URL itself (a reset or verify link carries a token)", () => {
    safeLinkHref("javascript:steal('secret-token-123')", "renderBrandButton");
    expect(String(errorSpy.mock.calls[0][0])).not.toContain("secret-token-123");
  });
});

describe("B809 — schemelessLinkBaseVars (the boot-time check)", () => {
  it("names each link-base env var that is set without http(s)://", () => {
    expect(
      schemelessLinkBaseVars({
        WEB_URL: "www.example.com",
        WEB_APP_URL: "https://app.example.com",
        NEXTAUTH_URL: "http://localhost:3001",
        FRONTEND_URL: "example.com",
      }),
    ).toEqual(["WEB_URL", "FRONTEND_URL"]);
  });

  it("ignores unset and empty vars", () => {
    expect(schemelessLinkBaseVars({ WEB_URL: "" })).toEqual([]);
    expect(schemelessLinkBaseVars({})).toEqual([]);
  });
});
