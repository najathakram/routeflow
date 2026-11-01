// W6 / C2 and 2j — /contact says the two ways in: email us, or book a video call. Email stays the
// way in (Q4), so the page carries no phone number, hours or street address. The reply time is the
// owner's (SA-1075 A-5): one sentence, said once, and no other time promise.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContactPage from "./contact/page";
import { DEMO_CTA, site } from "./lib/site";

function page() {
  const html = renderToStaticMarkup(createElement(ContactPage));
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { doc, text: doc.body.textContent?.replace(/\s+/g, " ") ?? "" };
}

describe("/contact words (W6, COPY.md 2j)", () => {
  it("has the eyebrow, the one h1 and the lead", () => {
    const { doc } = page();
    expect(doc.querySelector(".eyebrow, .g-eyebrow")?.textContent?.trim()).toBe(
      "Contact RouteFlow",
    );
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Email us or book a video call.",
    );
    expect(doc.querySelector("p.lead")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Email a question and include your company name. We reply within one business day.",
    );
  });

  it("names the call agenda and the two cards in the plain words", () => {
    const { doc } = page();
    const headings = [...doc.querySelectorAll("h2")].map((h) => h.textContent?.trim());
    expect(headings).toEqual(["What we do on the call.", "Book a video call", "Other questions"]);
    const agenda = [...doc.querySelectorAll(".demo-agenda strong")].map((n) => n.textContent);
    expect(agenda).toEqual(["Show us your orders", "See RouteFlow", "Talk about next steps"]);
    const body = [...doc.querySelectorAll(".demo-agenda p, .contact-card p")].map((n) =>
      n.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(body).toEqual([
      "How orders, deliveries, and customer questions work today.",
      "From the order to the delivery.",
      "Ask about price and setup.",
      "Look at your orders, deliveries, and customers. Ask about features and setup.",
      "Email us about your account or anything else. Include your company name.",
    ]);
  });

  it("C2: the call button is DEMO_CTA and the email link still opens a mail draft", () => {
    const { doc } = page();
    expect(doc.querySelector('a[href="/book-a-demo"]')?.textContent?.trim()).toBe(DEMO_CTA);
    const mail = doc.querySelector(`a[href="mailto:${site.email}"]`);
    expect(mail?.textContent?.trim()).toBe(site.email);
  });

  it("A-5: the page says the reply time once, in the owner's words", () => {
    const { text } = page();
    expect(text.split("We reply within one business day.")).toHaveLength(2);
  });

  it("C2: no phone number, hours or street address, and no other time promise", () => {
    // The one sentence the owner set is taken out first, so everything else is held to the old rules.
    const text = page().text.replace("We reply within one business day.", "");
    expect(text).not.toMatch(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/);
    expect(text).not.toMatch(/tel:|\bphone\b|\bcall us\b/i);
    expect(text).not.toMatch(/\b(hours|open|monday|business days|mon\b|fri\b)/i);
    expect(text).not.toMatch(/\b(street|suite|avenue|\bst\.|road)\b/i);
    expect(text).not.toMatch(
      /within \d+|reply (in|within)|we.?ll (reply|respond|get back)|same day/i,
    );
    expect(text).not.toMatch(/\bdemo\b|workspace|walkthrough/i);
  });
});
