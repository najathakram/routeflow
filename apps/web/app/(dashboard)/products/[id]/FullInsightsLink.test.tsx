import * as React from "react";
import { render, screen } from "@testing-library/react";
import { FullInsightsLink } from "./FullInsightsLink";

// SA-1087 IN-2: the link is offered only to what the endpoint serves. Its parent,
// ProductInsightsExport, already hides everything for a role the endpoint refuses and for a plan
// without flag.analytics (pinned in ProductInsightsExport.test.tsx), so the link reads only the
// REPORTS group.
const mockDenied = jest.fn();
jest.mock("@/lib/api/my-permissions", () => ({ useDeniedGroups: () => mockDenied() }));

beforeEach(() => {
  mockDenied.mockReturnValue([]);
});

describe("FullInsightsLink", () => {
  it("links staff with REPORTS to the product's insights page", () => {
    render(<FullInsightsLink productId="p1" />);
    expect(screen.getByRole("link", { name: "Full insights" })).toHaveAttribute(
      "href",
      "/insights/products/p1",
    );
  });

  it("IN-2: staff without REPORTS see no link", () => {
    mockDenied.mockReturnValue(["REPORTS"]);
    render(<FullInsightsLink productId="p1" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("a group other than REPORTS switched off does not hide it", () => {
    mockDenied.mockReturnValue(["FINANCE"]);
    render(<FullInsightsLink productId="p1" />);
    expect(screen.getByRole("link", { name: "Full insights" })).toBeInTheDocument();
  });
});
