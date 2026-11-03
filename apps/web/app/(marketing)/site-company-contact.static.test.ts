/**
 * @jest-environment node
 */
// Owner order: "no old look left anywhere", and "/about and the header must tell one company
// story". Company and Contact are ready-made pages in the new look. These pin what the order
// asked for: one story (the founder's note, word for word, as on the home page), no stock photo or
// its credit, Contact by email only (no video call), and the old About page gone.
import * as fs from "fs";
import * as path from "path";

const SITE = path.resolve(__dirname, "../../public/site");
const read = (file: string) => fs.readFileSync(path.join(SITE, file), "utf8");
const company = read("company.html");
const contact = read("contact.html");
const home = read("home.html");

const paragraphs = (html: string, from: string, to: string) => {
  const start = html.indexOf(from);
  const block = html.slice(start, html.indexOf(to, start));
  return [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
};

describe("Company page", () => {
  it("tells the founder's story in the same four paragraphs as the home page", () => {
    const onHome = paragraphs(home, 'id="fd-note"', "</div>");
    const onCompany = paragraphs(company, 'class="co-body"', 'class="co-sig"');
    expect(onHome).toHaveLength(4);
    expect(onCompany).toEqual(onHome);
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
    expect(company).toContain('href="mailto:hello@routeflow.info"');
    expect(company).toContain('href="/contact"');
  });
});

describe("Contact page", () => {
  const main = contact.slice(contact.indexOf("<main"), contact.indexOf("</main>"));

  it("is by email only: no video call, booking, calendar, phone or form", () => {
    expect(main).toContain('href="mailto:hello@routeflow.info"');
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
