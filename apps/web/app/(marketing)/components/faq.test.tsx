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

  it("renders the 4 retailer questions when `retail` is set, starting with the supplier-connection question (R-MKT T8b)", () => {
    const { container } = render(<FAQ retail />);
    const items = container.querySelectorAll("details");
    expect(items).toHaveLength(4);
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

  it("keeps the word space in the heading when the <br /> is hidden (R-MKT T8b)", () => {
    const { container } = render(<FAQ />);
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe("Before you get started.");
  });

  it("styles the native disclosure in marketing.css (R-MKT T8b)", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../marketing.css"), "utf8");
    expect(css).toContain('summary[data-slot="accordion-trigger"]::-webkit-details-marker');
    expect(css).toContain('details[open] > summary[data-slot="accordion-trigger"] svg');
  });
});
