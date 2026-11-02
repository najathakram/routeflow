// Privacy and Terms: the data retention, account closing and driver location wording, and the dates and notice
// boxes that go with it. Reads the rendered text, the way a visitor does.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "./privacy/page";
import TermsPage from "./terms/page";
import { addLegalDays, formatLegalDate, isBeforeLegalDay } from "./lib/legal-dates";

function render(page: () => React.JSX.Element) {
  const html = renderToStaticMarkup(createElement(page));
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = doc.body.textContent?.replace(/\s+/g, " ") ?? "";
  return { html, doc, text };
}

// The publish day, read back from the page's own "Last updated" line, so setting the dates at merge does not touch
// these tests.
function publishDay(page: () => React.JSX.Element): string {
  const m = render(page).text.match(/Last updated: ([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (!m) throw new Error("no Last updated line");
  return new Date(`${m[1]} 00:00:00 UTC`).toISOString().slice(0, 10);
}
const at = (iso: string) => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(`${iso}T12:00:00Z`));
};
afterEach(() => jest.useRealTimers());

describe("legal dates", () => {
  it("D1: formats a day in UTC, adds days across a month end, and flips at the start of the day", () => {
    expect(formatLegalDate("2026-11-02")).toBe("November 2, 2026");
    expect(addLegalDays("2026-11-02", 30)).toBe("2026-12-02");
    expect(addLegalDays("2026-12-20", 90)).toBe("2027-03-20");
    expect(isBeforeLegalDay("2026-12-02", new Date("2026-12-01T23:59:59Z"))).toBe(true);
    expect(isBeforeLegalDay("2026-12-02", new Date("2026-12-02T00:00:00Z"))).toBe(false);
  });
  it("D2: a malformed day throws, so a typo cannot ship a blank date", () => {
    expect(() => formatLegalDate("soon")).toThrow();
  });
});

describe("Privacy: data retention", () => {
  const section = () => {
    const { doc } = render(PrivacyPage);
    const h = doc.getElementById("data-retention")!;
    const parts: string[] = [];
    for (let el = h.nextElementSibling; el && el.tagName !== "H2"; el = el.nextElementSibling) {
      parts.push(el.textContent?.replace(/\s+/g, " ") ?? "");
    }
    return parts.join(" ");
  };

  it("P1: says what happens today, with no end date and no automatic deletion", () => {
    const t = section();
    expect(t).toContain("This section describes what we do today.");
    expect(t).toContain("We have not set end dates for most of the data we hold");
    expect(t).toContain("No automatic process deletes them.");
    expect(t).toContain("A Tenant cannot delete its own account in the Service.");
    expect(t).toContain("the data stays in our database");
  });

  it("P2: the earlier period promises are gone", () => {
    const t = section();
    expect(t).not.toContain("plus 30 days");
    expect(t).not.toContain("retained for 90 days");
    expect(t).not.toContain("up to 24 months");
    expect(t).not.toContain("12 months");
  });

  it("P3: makes no promise about jobs that do not exist yet", () => {
    const { text } = render(PrivacyPage);
    expect(text).not.toContain("We plan");
    expect(text).not.toContain("we plan");
  });

  it("P4: a Tenant can ask for a copy by email, done by hand, answered within 30 days", () => {
    const t = section();
    expect(t).toContain(
      "to ask for a copy of Tenant Data, including data the Service cannot download",
    );
    expect(t).toContain("We do this by hand. We will reply within 30 days");
  });

  it("P5: buyer accounts, backups and legal duties are each stated", () => {
    const t = section();
    expect(t).toContain("We do not yet offer a screen to delete a buyer account.");
    expect(t).toContain("hashed password stay in our database");
    expect(t).toContain("can stay in a backup until that backup ages out or is removed");
    expect(t).toContain("even after a request to delete them");
  });

  it("P6: the retention section links its email to the contact address", () => {
    const { doc } = render(PrivacyPage);
    const h = doc.getElementById("data-retention")!;
    const links = [...(h.parentElement?.querySelectorAll("a[href^='mailto:']") ?? [])];
    expect(links.length).toBeGreaterThan(0);
  });
});

describe("Privacy: driver location and the smaller lines", () => {
  it("L1: the location line covers staff who start a route and says buyers are not tracked", () => {
    const { text } = render(PrivacyPage);
    expect(text).toContain("Location data (mobile): when a delivery route starts");
    expect(text).toContain("staff accounts that start a route in the mobile app");
    expect(text).toContain("We do not collect location from buyer accounts.");
    expect(text).toContain("The app is built to stop when the route ends.");
    expect(text).not.toContain("drivers only");
    expect(text).not.toContain("Location is not collected outside of an active route");
  });

  it("L2: the driver data line names stored location points, not route history", () => {
    const { text } = render(PrivacyPage);
    expect(text).toContain("real-time location data and stored location points");
    expect(text).not.toContain("route-history");
  });

  it("L3: the demo booking line points at Data retention", () => {
    const { text } = render(PrivacyPage);
    expect(text).toContain(
      "We keep demo booking records as described in “Data retention” below. If you become a RouteFlow Tenant, the same section applies to your account data.",
    );
    expect(text).not.toContain("Demo booking records are retained for 12 months");
  });

  it("L4: the first rights bullet points to Data retention for deleting a buyer account", () => {
    const { text } = render(PrivacyPage);
    expect(text).toContain(
      "To ask us to delete your buyer account itself, see “Data retention” above.",
    );
  });
});

describe("Privacy: dates and notice box", () => {
  it("N1: effective and last updated are the publish day, and the box names it", () => {
    const day = publishDay(PrivacyPage);
    at(day);
    const { text } = render(PrivacyPage);
    expect(text).toContain(`Effective date: ${formatLegalDate(day)}`);
    expect(text).toContain(`Updated ${formatLegalDate(day)}.`);
    expect(text).toContain("so it matches how RouteFlow works today");
  });
  it("N2: the box is still up on day 89 and gone on day 90", () => {
    const day = publishDay(PrivacyPage);
    at(addLegalDays(day, 89));
    expect(render(PrivacyPage).html).toContain("legal-notice");
    at(addLegalDays(day, 90));
    expect(render(PrivacyPage).html).not.toContain("legal-notice");
  });
  it("N3: the page was published after the dates it replaces", () => {
    expect(publishDay(PrivacyPage) > "2026-10-31").toBe(true);
  });
});

describe("Terms: closing an account and the lines that point at it", () => {
  const section9 = () => {
    const { doc } = render(TermsPage);
    const h = doc.getElementById("term-termination")!;
    return h.nextElementSibling?.textContent?.replace(/\s+/g, " ") ?? "";
  };

  it("T1: Section 9 says what a cancelled account can still do and offers a copy by hand", () => {
    const t = section9();
    expect(t).toContain("you can still sign in, read your Tenant Data, and use the download tools");
    expect(t).toContain("Those tools do not cover every kind of Tenant Data");
    expect(t).toContain("you can email");
    expect(t).toContain("We prepare it by hand");
    expect(t).toContain("unless the law or a security risk prevents it");
  });

  it("T2: the 30-day export promise is gone", () => {
    const { text } = render(TermsPage);
    expect(text).not.toContain("available for export for 30 days");
    expect(text).not.toContain("before it is deleted");
  });

  it("T3: Section 9 links Privacy at its retention section", () => {
    const { doc } = render(TermsPage);
    const h = doc.getElementById("term-termination")!;
    const hrefs = [...h.nextElementSibling!.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/privacy#data-retention");
  });

  it("T4: Sections 5, 6 and 8 carry their lines", () => {
    const { text } = render(TermsPage);
    expect(text).toContain(
      "which includes keeping it after a subscription ends as described in our Privacy Policy",
    );
    expect(text).toContain("or a staff member running a route");
    expect(text).toContain("The app is built to stop collecting location when the route ends.");
    expect(text).not.toContain("Location is not collected outside of an active route");
    expect(text).toContain("solely to provide the Service to you, as described in Section 5.");
  });
});

describe("Terms: effective date and notice box", () => {
  it("E1: last updated is the publish day and the terms take effect 30 days later", () => {
    const day = publishDay(TermsPage);
    at(day);
    const { text } = render(TermsPage);
    expect(text).toContain(`Effective date: ${formatLegalDate(addLegalDays(day, 30))}`);
  });

  it("E2: until the effective date a box says when the terms change and offers a copy by hand", () => {
    const day = publishDay(TermsPage);
    at(addLegalDays(day, 10));
    const { text, html } = render(TermsPage);
    expect(html).toContain("legal-notice");
    expect(text).toContain(`These Terms change on ${formatLegalDate(addLegalDays(day, 30))}.`);
    expect(text).toContain("Until then, the earlier Section 9 applies");
    expect(text).toContain("we will make it available by hand");
  });

  it("E3: the box is gone on the effective date", () => {
    const day = publishDay(TermsPage);
    at(addLegalDays(day, 29));
    expect(render(TermsPage).html).toContain("legal-notice");
    at(addLegalDays(day, 30));
    expect(render(TermsPage).html).not.toContain("legal-notice");
  });
});
