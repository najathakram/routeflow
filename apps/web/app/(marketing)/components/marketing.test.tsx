import * as React from "react";
import { render } from "@testing-library/react";
import { CTA } from "./marketing";
import { AISpotlight } from "./ai-spotlight";

// R-MKT T8b — the shared CTA heading keeps its word space across the <br />,
// which `.rf-marketing .cta-block br { display: none }` hides below 760px.
describe("CTA heading spacing — R-MKT T8b", () => {
  it("keeps the space in the distributor heading (R-MKT T8b)", () => {
    const { container } = render(<CTA />);
    expect(container.querySelector("h2")?.textContent).toBe("Put your workflow to the test.");
  });

  it("keeps the space in the retailer heading (R-MKT T8b)", () => {
    const { container } = render(<CTA retailer />);
    expect(container.querySelector("h2")?.textContent).toBe(
      "Place your next order with a clearer view.",
    );
  });
});

// R-MKT T8b — the AI-spotlight heading keeps its word space across the em's
// <br />, which `.rf-marketing .ai-copy h2 br:last-child { display: none }` hides below 660px.
describe("AISpotlight h2 spacing — R-MKT T8b", () => {
  it("keeps the space in the AI-spotlight heading (R-MKT T8b)", () => {
    const { container } = render(<AISpotlight />);
    const text = container.querySelector("#ai-heading")?.textContent;
    expect(text).toContain("More clarity on stock and cost.");
    expect(text).not.toContain("onstock");
  });
});
