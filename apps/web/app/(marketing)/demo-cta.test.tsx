// W6 first commit / O2 — the one label for the call button. COPY.md sections 0 and 4: "video call",
// never "demo". Every link to /book-a-demo on every marketing page, the header, its sheet and the
// footer reads DEMO_CTA, from the one constant. The home hero button is W0's and still carries the
// old label until W0 lands; it is the only allowed exception, and it is counted so it can't grow.
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEMO_CTA } from "./lib/site";
import { SiteHeader } from "./components/site-header";
import { SiteFooter } from "./components/site-footer";
import Home from "./page";
import ProductPage from "./product/page";
import WholesalersPage from "./wholesalers/page";
import RetailersPage from "./retailers/page";
import PricingPage from "./pricing/page";
import CompanyPage from "./company/page";
import ContactPage from "./contact/page";
import PrivacyPage from "./privacy/page";
import TermsPage from "./terms/page";

const PAGES: Array<[string, ComponentType, number]> = [
  // [route, page, links still on the old label until W0]
  ["/", Home, 1],
  ["/product", ProductPage, 0],
  ["/wholesalers", WholesalersPage, 0],
  ["/retailers", RetailersPage, 0],
  ["/pricing", PricingPage, 0],
  ["/company", CompanyPage, 0],
  ["/contact", ContactPage, 0],
  ["/privacy", PrivacyPage, 0],
  ["/terms", TermsPage, 0],
];

// Two other labels also link to /book-a-demo and belong to later pieces, not to this label:
// the plan buttons ("Discuss {plan}", W5b) and one W7 section link.
const NOT_THE_CALL_BUTTON = [
  /^Discuss (Starter|Growth|Scale)$/,
  /^Show us the features that matter/,
];

function callLabels(root: ParentNode): string[] {
  return [...root.querySelectorAll('a[href="/book-a-demo"]')]
    .map((a) => (a.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((label) => !NOT_THE_CALL_BUTTON.some((re) => re.test(label)));
}

describe("the call button has one label (W6 / O2)", () => {
  it("DEMO_CTA is a three-word sentence-case label that starts with a verb", () => {
    expect(DEMO_CTA).toBe("Book a video call");
  });

  it.each(PAGES)(
    "%s: every link to /book-a-demo reads DEMO_CTA",
    (_route, Page, oldLabelAllowed) => {
      const doc = new DOMParser().parseFromString(
        renderToStaticMarkup(createElement(Page)),
        "text/html",
      );
      const labels = callLabels(doc);
      const wrong = labels.filter((label) => label !== DEMO_CTA);
      expect(wrong).toHaveLength(oldLabelAllowed);
    },
  );

  it("the header button, the open sheet and the footer read DEMO_CTA", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <SiteHeader />
        <SiteFooter />
      </>,
    );
    expect(callLabels(container).filter((l) => l !== DEMO_CTA)).toEqual([]);
    expect(callLabels(container).length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByRole("button", { name: /open menu/i }));
    const sheet = screen.getByRole("dialog");
    expect(callLabels(sheet)).toEqual([DEMO_CTA]);
  });
});
