import * as React from "react";
import { render, screen } from "@testing-library/react";
import { FindInsightsLink } from "./FindInsightsLink";

// SA-1087 PR-2: Analytics' link to the finder follows the one access rule (use-insights-access).
let mockAccess = true;
jest.mock("./use-insights-access", () => ({ useInsightsAccess: () => mockAccess }));

describe("FindInsightsLink", () => {
  it("links to the finder when the viewer may use insights", () => {
    mockAccess = true;
    render(<FindInsightsLink className="ml-auto" />);
    const link = screen.getByRole("link", { name: "Look up a product" });
    expect(link).toHaveAttribute("href", "/insights");
    expect(link).toHaveClass("ml-auto");
  });

  it("IN-2 / IN-3: shows nothing without REPORTS or flag.analytics", () => {
    mockAccess = false;
    render(<FindInsightsLink />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
