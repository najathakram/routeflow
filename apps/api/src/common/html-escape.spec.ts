import { assertHttpUrl, escapeHtml } from "./html-escape";

/** B809 (REG-B809) — the one shared escaper, and the link helpers' scheme guard. */
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

describe("B809 — assertHttpUrl (a link can only ever be http(s))", () => {
  it.each(["https://app.example.com/reset-password?token=ab12", "http://localhost:3001/x"])(
    "passes %s through unchanged",
    (url) => {
      expect(assertHttpUrl(url)).toBe(url);
    },
  );

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "mailto:someone@example.com",
  ])("refuses %s", (url) => {
    expect(() => assertHttpUrl(url)).toThrow(/only http\(s\) is allowed/);
  });

  it.each(["/relative/path", "www.example.com/no-scheme", ""])(
    "refuses a non-absolute URL %j",
    (url) => {
      expect(() => assertHttpUrl(url)).toThrow(/non-URL link target/);
    },
  );
});
