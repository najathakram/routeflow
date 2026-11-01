import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import userEvent from "@testing-library/user-event";
import { render, waitFor } from "@testing-library/react";
import { FAQ } from "./faq";

// R-MKT T8b — five general-set Q&As, single-open accordion behaviour on
// native <details>/<summary>, first question verbatim from M1 §1.9.
// One `it` per plan oracle so each produces its own red row rather than all
// three hiding behind the first failed query.
describe("FAQ — R-MKT T8b", () => {
  it("renders exactly 5 general questions as <details> items (R-MKT T8b)", () => {
    const { container } = render(<FAQ />);
    expect(container.querySelectorAll("details")).toHaveLength(5);
  });

  it("opens with M1's first general question verbatim (R-MKT T8b)", () => {
    const { container } = render(<FAQ />);
    const firstSummary = container.querySelector("details summary");
    expect(firstSummary).not.toBeNull();
    expect(firstSummary).toHaveTextContent("Who is RouteFlow for?");
  });

  it("keeps only the most recently opened item expanded (R-MKT T8b)", async () => {
    const user = userEvent.setup();
    const { container } = render(<FAQ />);

    const items = container.querySelectorAll("details");
    const secondSummary = items[1]?.querySelector("summary");
    const thirdSummary = items[2]?.querySelector("summary");
    expect(secondSummary).toBeTruthy();
    expect(thirdSummary).toBeTruthy();

    await user.click(secondSummary as HTMLElement);
    await user.click(thirdSummary as HTMLElement);

    await waitFor(() => expect(container.querySelectorAll("details[open]")).toHaveLength(1));
    const openItems = Array.from(container.querySelectorAll("details[open]"));
    expect(openItems[0]).toBe(items[2]);
  });

  it("renders the 5 retailer questions when `retail` is set, starting with the supplier-connection question (R-MKT T8b)", () => {
    const { container } = render(<FAQ retail />);
    const items = container.querySelectorAll("details");
    expect(items).toHaveLength(5);
    const firstSummary = items[0]?.querySelector("summary");
    expect(firstSummary).toHaveTextContent("Do I need a supplier connection?");
  });
  it('marks every item with data-slot="accordion-item" so the ported CSS matches (R-MKT T8b)', () => {
    const { container } = render(<FAQ />);
    const items = Array.from(container.querySelectorAll("details"));
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item.getAttribute("data-slot")).toBe("accordion-item");
    }
  });

  it("names the section's heading in plain words and drops the eyebrow (W6, COPY.md 2i)", () => {
    const { container } = render(<FAQ />);
    expect(container.querySelector("h2")?.textContent).toBe("Questions before you start.");
    expect(container.querySelector(".eyebrow")).toBeNull();
    expect(container.textContent).not.toContain("A few useful answers");
  });

  it("styles the native disclosure in marketing.css (R-MKT T8b)", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../marketing.css"), "utf8");
    expect(css).toContain('summary[data-slot="accordion-trigger"]::-webkit-details-marker');
    expect(css).toContain('details[open] > summary[data-slot="accordion-trigger"] svg');
  });
});

// W6 / C3 and C7 — the FAQ answers straight, and `/#faq` has somewhere to land.
describe("FAQ — W6 (COPY.md 2i)", () => {
  it('carries id="faq" so /faq, /integrations and /quickbooks (to /#faq) open it (C7)', () => {
    const { container } = render(<FAQ />);
    expect(container.querySelector("section")?.getAttribute("id")).toBe("faq");
  });

  it("C3: asks about QuickBooks and answers not directly, with CSV import and export", () => {
    const { container } = render(<FAQ />);
    const item = Array.from(container.querySelectorAll("details")).find((d) =>
      /quickbooks/i.test(d.querySelector("summary")?.textContent ?? ""),
    );
    expect(item?.querySelector("summary")).toHaveTextContent(
      "Does RouteFlow work with QuickBooks?",
    );
    expect(item?.querySelector("[data-slot=accordion-content]")?.textContent).toBe(
      "Not directly: RouteFlow doesn’t connect to QuickBooks, Xero, or Zoho. You can import customers, products, invoices, payments, expenses, and stock from CSV files. You can export invoices as CSV files.",
    );
  });

  it("keeps five questions: the fifth holds for W4, with the call called a video call", () => {
    const { container } = render(<FAQ />);
    const questions = Array.from(container.querySelectorAll("details summary")).map(
      (s) => s.textContent,
    );
    expect(questions).toEqual([
      "Who is RouteFlow for?",
      "Can retailers order through RouteFlow?",
      "What does my team use it on?",
      "Does RouteFlow work with QuickBooks?",
      "What will we cover on a video call?",
    ]);
    const fifth = container.querySelectorAll("details")[4]!;
    expect(fifth.querySelector("[data-slot=accordion-content]")?.textContent).toBe(
      "Start with your ordering and delivery process. Ask to see order intake, route planning, delivery confirmation, and customer records, then discuss the plan and setup that fit your team.",
    );
  });

  it("says nothing about a free trial or how it ends (that is W4's row)", () => {
    const { container } = render(<FAQ />);
    expect(container.textContent).not.toMatch(/trial|14 days|free for 14/i);
  });

  it("answers in the site's names: no 'wholesaler', 'workspace' or 'demo'", () => {
    const { container } = render(<FAQ />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/wholesaler|workspace|\bdemo\b/i);
  });

  it("closes with Contact us, not Talk to the team", () => {
    const { container } = render(<FAQ />);
    expect(container.textContent).toContain("Have another question?");
    const link = container.querySelector('a[href="/contact"]');
    expect(link?.textContent).toBe("Contact us");
  });

  it("shortens the five retailer answers", () => {
    const { container } = render(<FAQ retail />);
    const answers = Array.from(container.querySelectorAll("[data-slot=accordion-content]")).map(
      (n) => n.textContent,
    );
    expect(answers).toEqual([
      "Yes. Your supplier decides the catalogs, prices, and ordering options you see. Ask your supplier how to connect.",
      "Pay by card in the portal if your supplier turns it on. If not, ask your supplier how to pay.",
      "Yes. The retailer portal works in the web browser on your phone, with nothing to install.",
      "Ask the supplier sending your order about products, delivery, returns, or payment.",
      "No. Use the retailer sign-up link to create a retailer account. Distributors sign up on a different page.",
    ]);
  });
});
