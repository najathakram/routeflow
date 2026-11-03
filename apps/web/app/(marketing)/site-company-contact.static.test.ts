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
  it("tells the founder's story in the same eight paragraphs as the home page", () => {
    const onHome = paragraphs(home, 'id="fd-note"', "</div>");
    const onCompany = paragraphs(company, 'class="co-body"', 'class="co-sig"');
    expect(onHome).toHaveLength(8);
    expect(onCompany).toEqual(onHome);
  });

  it("has the same heading on both pages, a plain sentence and not a quote", () => {
    const h = "We built this with a wholesaler, for wholesalers.";
    expect(home).toContain(`<h2 id="fd-h" class="fd-q">${h}</h2>`);
    expect(company).toContain(`<h2 id="story-h" class="co-q">${h}</h2>`);
    expect(home).not.toContain("fd-qm");
    expect(home).not.toContain("None of them fit");
    expect(home).not.toContain("It started when");
    expect(company).not.toContain("None of them fit");
  });

  it("every claim in the note is one the site and the code back (the links go to real pages)", () => {
    const note = paragraphs(home, 'id="fd-note"', "</div>").join(" ");
    for (const href of ["/does-and-doesnt", "/pricing", "mailto:hello@routeflow.info"]) {
      expect(note).toContain(`href="${href}"`);
    }
    expect(fs.existsSync(path.join(SITE, "does-and-doesnt.html"))).toBe(true);
    expect(note).toContain("14 days, with no card");
    expect(note).toContain("We reply within one business day.");
    // the review's wording: "honest", and the plan names (Starter, Growth, Scale) the pricing page shows
    expect(note).toContain("I want to be honest with you.");
    expect(note).not.toContain("I’ll be straight with you.");
    // the owner's brief: no degrees, what RouteFlow does, and the owner's own offer to customize
    for (const gone of ["PhD", "University of Texas", "graduated"])
      expect(note).not.toContain(gone);
    expect(note).toContain("RouteFlow runs your selling, from order to payment.");
    expect(note).toContain("Stores can order for themselves, each at its own price.");
    expect(note).toContain("It also covers buying, simple stock, and delivery routes.");
    expect(note).toContain("When a line has 2 boxes and 3 pieces, the bill adds up right.");
    expect(note).toContain(
      "We can customize it for your business, and we’ll tell you what that takes and what it costs.",
    );
    // that line is the boxed-line proration the pricing package pins (2 boxes + 3 pieces of an 11-pack at 220 = 500)
    expect(
      fs.readFileSync(
        path.resolve(__dirname, "../../../../packages/pricing/src/pricing.spec.ts"),
        "utf8",
      ),
    ).toContain("prorates loose pieces below a full box");
    expect(note).toContain(
      'so we show the <a href="/pricing">prices</a> for Starter, Growth, and Scale before you start.',
    );
    for (const plan of ["Starter", "Growth", "Scale"])
      expect(read("pricing.html")).toContain(`<h2>${plan}</h2>`);
    // the short version on a phone opens on the same first sentence and the same ask for help
    const short = paragraphs(home, 'class="fd-short"', "</div>");
    expect(short).toHaveLength(3);
    expect(short[0]).toBe(paragraphs(home, 'id="fd-note"', "</div>")[0]);
    expect(short[1]).toBe(
      "My co-founder’s father is a wholesaler. He tried several apps and services, and none of them fit the way he works. So he asked us for help, and we built RouteFlow with him.",
    );
    expect(short[2]).toBe(
      "It takes you from order to payment. If you need something it doesn’t do, tell us. We can customize it for your business.",
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
