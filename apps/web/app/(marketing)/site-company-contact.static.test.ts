/**
 * @jest-environment node
 */
// Owner order: "no old look left anywhere", and "/about and the header must tell one company
// story". Company and Contact are ready-made pages in the new look. These pin what the order
// asked for: one story (the founder's note, word for word, as on the home page), no stock photo or
// its credit, Contact by email only (no video call), and the old About page gone.
import * as fs from "fs";
import * as path from "path";
import { BRAND } from "@routeflow/types/brand";
import { readServedSitePage } from "@/lib/read-site-page";
import type { StaticSitePage } from "@/lib/static-site-page";

const SITE = path.resolve(__dirname, "../../public/site");
// Pages are read as the route serves them (brand tokens filled): the seam's one reader.
const read = (file: string) =>
  file.endsWith(".html")
    ? readServedSitePage(file.slice(0, -".html".length) as StaticSitePage, { websiteId: undefined })
    : fs.readFileSync(path.join(SITE, file), "utf8");
const company = read("company.html");
const contact = read("contact.html");
const home = read("home.html");

const paragraphs = (html: string, from: string, to: string) => {
  const start = html.indexOf(from);
  const block = html.slice(start, html.indexOf(to, start));
  return [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
};

describe("Company page", () => {
  it("tells the founder's story in the same nine paragraphs as the home page", () => {
    const onHome = paragraphs(home, 'id="fd-note"', "</div>");
    const onCompany = paragraphs(company, 'class="co-body"', 'class="co-sig"');
    expect(onHome).toHaveLength(9);
    expect(onCompany).toEqual(onHome);
  });

  it("has the same heading on both pages, a plain sentence and not a quote", () => {
    const h = "We built this with the people who use it every day.";
    expect(home).toContain(`<h2 id="fd-h" class="fd-q">${h}</h2>`);
    expect(company).toContain(`<h2 id="story-h" class="co-q">${h}</h2>`);
    expect(home).not.toContain("fd-qm");
    expect(home).not.toContain("None of them fit");
    expect(home).not.toContain("for wholesalers.</h2>");
    expect(company).not.toContain("None of them fit");
  });

  it("every claim in the note is one the site and the code back (the links go to real pages)", () => {
    const note = paragraphs(home, 'id="fd-note"', "</div>").join(" ");
    for (const href of ["/does-and-doesnt", "/pricing", `mailto:${BRAND.email}`]) {
      expect(note).toContain(`href="${href}"`);
    }
    expect(fs.existsSync(path.join(SITE, "does-and-doesnt.html"))).toBe(true);
    expect(note).toContain("14 days, with no card");
    expect(note).toContain("We reply within one business day.");
    expect(note).toContain("I want to be honest with you.");
    expect(note).toContain(
      'We show the <a href="/pricing">prices</a> for Starter, Growth, and Scale before you start.',
    );
    for (const plan of ["Starter", "Growth", "Scale"])
      expect(read("pricing.html")).toContain(`<h2>${plan}</h2>`);
    // what the product does: each is on the product page or in the pricing package
    expect(note).toContain(`${BRAND.name} runs your selling, from order to payment.`);
    expect(note).toContain("Stores can order for themselves, each at its own price.");
    expect(note).toContain("It also covers buying, simple stock, and delivery routes.");
    expect(note).toContain("When a line has 2 boxes and 3 pieces, the bill adds up right.");
    // that line is the boxed-line proration the pricing package pins (2 boxes + 3 pieces of an 11-pack at 220 = 500)
    expect(
      fs.readFileSync(
        path.resolve(__dirname, "../../../../packages/pricing/src/pricing.spec.ts"),
        "utf8",
      ),
    ).toContain("prorates loose pieces below a full box");
    // the owner's own words and offer (no code backs these; the PR body names them as the owner's): no degrees, customizing at no cost,
    // working every feature with the people who use it, the market review, living the day with them
    for (const gone of ["PhD", "University of Texas", "graduated", "straight with you"])
      expect(note).not.toContain(gone);
    for (const owner of [
      "We’ll customize it for your business at no cost, and we’ll tell you up front what we can do and when.",
      "We worked on every feature with the people who use it every day, until it was the quickest way we could find to do the job.",
      `We also looked at most of the products on the market: what they do, why they’re hard to use, and what they leave out. ${BRAND.name} is built to fill that gap.`,
      `Many software teams have to imagine a wholesaler’s day. We live it with the people who use ${BRAND.name}, so we know what you need.`,
    ])
      expect(note).toContain(owner);
    // the short version on a phone opens on the same first sentence and the same ask for help
    const short = paragraphs(home, 'class="fd-short"', "</div>");
    expect(short).toHaveLength(3);
    // "co-founder’s" is one unbreakable word in the short version and in the full note, with a rule that holds at every width
    expect(short[1]).toContain('my <span class="nb">co-founder’s</span> father');
    expect(note).toContain('with my <span class="nb">co-founder’s</span> father, a wholesaler.');
    expect(read("css/site.css")).toContain(
      ".fd-short .nb,.fd-note .nb,.co-body .nb{white-space:nowrap}",
    );
    expect(short[0]).toBe(paragraphs(home, 'id="fd-note"', "</div>")[0]);
    expect(short[1]).toBe(
      `We built ${BRAND.name} with wholesalers who use it every day, starting with my <span class="nb">co-founder’s</span> father. Many software teams have to imagine a wholesaler’s day. We live it with them.`,
    );
    expect(short[2]).toBe(
      "It takes you from order to payment. If we don’t have something you need, tell us. We’ll customize it for your business at no cost.",
    );
  });

  it("the founder grid gives its spare height to the last row, so the heading sits under the kicker", () => {
    expect(read("css/home-up.css")).toMatch(
      /#founder .fd-in{[^}]*grid-template-rows:auto auto 1fr[;}]/,
    );
  });

  it("signs it as the co-founder, as the home page does", () => {
    expect(company).toContain("<b>Dr. Najath Akram</b><span>Co-founder</span>");
  });

  it("has one h1, and the line the header and footer use for the company", () => {
    expect(company.match(/<h1\b/g)).toHaveLength(1);
    expect(company).toContain("We make wholesalers’ lives easier.");
  });

  it("has no stock photo, photo credit, or image at all in the page body", () => {
    const main = company.slice(company.indexOf("<main"), company.indexOf("</main>"));
    expect(main).not.toMatch(/<img\b/i);
    expect(main).not.toMatch(/photo by|unsplash|pexels|shutterstock|istock|credit/i);
    expect(company).not.toMatch(/unsplash|pexels|shutterstock|istock/i);
  });

  it("makes no claim the code does not prove (the old page's list of strengths is gone)", () => {
    for (const gone of ["Ships fast", "Small by design", "Built with", "award", "trusted by"]) {
      expect(company.toLowerCase()).not.toContain(gone.toLowerCase());
    }
  });

  it("points a question to the email address and the contact page", () => {
    expect(company).toContain(`href="mailto:${BRAND.email}"`);
    expect(company).toContain('href="/contact"');
  });
});

describe("Contact page", () => {
  const main = contact.slice(contact.indexOf("<main"), contact.indexOf("</main>"));

  it("is by email only: no video call, booking, calendar, phone or form", () => {
    expect(main).toContain(`href="mailto:${BRAND.email}"`);
    expect(contact).not.toMatch(/video call|book a|schedule|calendar|demo/i);
    expect(main).not.toMatch(/<form\b|<input\b|<textarea\b|tel:/i);
  });

  it("promises only the reply time the owner approved", () => {
    expect(main).toContain("We reply within one business day.");
    expect(contact).not.toMatch(/within (an|1) hour|same day|24\/7|instant/i);
  });

  it("sends a new visitor to the trial, a store to its own sign-in", () => {
    expect(main).toContain('href="/signup"');
    expect(main).toContain('href="/buyer/login"');
  });

  it("has one h1", () => {
    expect(contact.match(/<h1\b/g)).toHaveLength(1);
  });
});

describe("one company story across the site", () => {
  it.each(["home.html", "product.html", "pricing.html", "company.html", "contact.html"])(
    "%s: the header and the footer both lead to /company and /contact",
    (file) => {
      const html = read(file);
      const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
      const footer = html.slice(html.indexOf("<footer"));
      expect(header).toMatch(/<a href="\/company"[^>]*>Company<\/a>/);
      expect(footer).toContain('<a href="/company"');
      expect(footer).toContain('<a href="/contact"');
    },
  );

  it("no page still links to an old address", () => {
    for (const file of fs.readdirSync(SITE).filter((f) => f.endsWith(".html"))) {
      const html = read(file);
      for (const old of ["/about", "/wholesalers", "/retailers", "/book-a-demo", "/sign-in"]) {
        expect({ file, old, found: html.includes(`href="${old}"`) }).toEqual({
          file,
          old,
          found: false,
        });
      }
    }
  });
});
