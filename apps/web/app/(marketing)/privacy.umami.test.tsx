// W3 / M2 — the Privacy Policy names Umami in the same deploy that adds the script. Words are
// COPY.md 2t. Today's cookies line stays true; the sentence is added after it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "./privacy/page";

function policyText(): string {
  const html = renderToStaticMarkup(createElement(PrivacyPage));
  return (
    new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s+/g, " ") ?? ""
  );
}

describe("Privacy Policy and visit counts (W3 M2)", () => {
  it("keeps the no third-party analytics cookies line and adds the Umami sentence after it", () => {
    const text = policyText();
    const keep = "We do not currently use third-party advertising or analytics cookies.";
    const add = "We count visits to our public website with Umami, which sets no cookies.";
    expect(text).toContain(keep);
    expect(text).toContain(add);
    expect(text.indexOf(add)).toBe(text.indexOf(keep) + keep.length + 1);
  });

  it("lists Umami in the sub-processor table, right after Sentry", () => {
    const html = renderToStaticMarkup(createElement(PrivacyPage));
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = [...doc.querySelectorAll("#sub-processors ~ .legal-table-wrap tbody tr")].map(
      (tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent?.replace(/\s+/g, " ").trim()),
    );
    const sentry = rows.findIndex((r) => r[0] === "Sentry");
    expect(sentry).toBeGreaterThan(-1);
    expect(rows[sentry + 1]).toEqual([
      "Umami",
      "Visit counts on our public website",
      "Pages viewed, referring site, browser, device type and country",
    ]);
  });

  it("moves the Last updated date past the day before this change", () => {
    const text = policyText();
    expect(text).not.toContain("Last updated: September 17, 2026");
    expect(text).not.toContain("Last updated: October 30, 2026");
    expect(text).toMatch(/Last updated: [A-Z][a-z]+ \d{1,2}, 2026/);
  });
});
