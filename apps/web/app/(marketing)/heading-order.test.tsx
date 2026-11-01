// W8 / S5 (A-3) — heading order on the marketing pages: the first heading is the h1 and no
// level is skipped on the way down (h1 to h3 is a skip). A heading's level is its aria-level
// when it has one, else its tag, which is how a screen reader and axe's heading-order read it.
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "./page";
import ProductPage from "./product/page";
import WholesalersPage from "./wholesalers/page";
import RetailersPage from "./retailers/page";
import PricingPage from "./pricing/page";
import CompanyPage from "./company/page";
import ContactPage from "./contact/page";
import PrivacyPage from "./privacy/page";
import TermsPage from "./terms/page";
import BookADemoPage from "./book-a-demo/page";

const PAGES: Array<[string, ComponentType]> = [
  ["/", Home],
  ["/product", ProductPage],
  ["/wholesalers", WholesalersPage],
  ["/retailers", RetailersPage],
  ["/pricing", PricingPage],
  ["/company", CompanyPage],
  ["/contact", ContactPage],
  ["/privacy", PrivacyPage],
  ["/terms", TermsPage],
  ["/book-a-demo", BookADemoPage],
];

function headingLevels(html: string): Array<{ level: number; text: string }> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']")].map((el) => {
    const aria = parseInt(el.getAttribute("aria-level") ?? "", 10);
    const tag = /^H([1-6])$/.exec(el.tagName);
    return {
      level: Number.isInteger(aria) ? aria : tag ? Number(tag[1]) : 2,
      text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
    };
  });
}

function skips(list: Array<{ level: number; text: string }>): string[] {
  const found: string[] = [];
  list.forEach((heading, i) => {
    const previous = list[i - 1];
    if (!previous && heading.level !== 1) found.push(`first heading is h${heading.level}`);
    if (previous && heading.level > previous.level + 1) {
      found.push(`h${previous.level} "${previous.text}" to h${heading.level} "${heading.text}"`);
    }
  });
  return found;
}

describe("marketing heading order — W8 S5", () => {
  it.each(PAGES)("%s skips no heading level", (_route, Page) => {
    const list = headingLevels(renderToStaticMarkup(createElement(Page)));
    expect(list.filter((h) => h.level === 1)).toHaveLength(1);
    expect(skips(list)).toEqual([]);
  });
});
