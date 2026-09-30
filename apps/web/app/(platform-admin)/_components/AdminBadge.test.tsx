import * as React from "react";
import { render, screen } from "@testing-library/react";
import { AdminBadge } from "./AdminBadge";

// T14-1 / R23: AdminBadge gains GROWTH -> "Growth" (teal ring) and SCALE -> "Scale" (indigo
// ring) plan entries; the existing PROFESSIONAL -> "Business" mapping stays unchanged.
describe("AdminBadge — plan variant (T14-1, R23)", () => {
  it("renders GROWTH as 'Growth' with a teal ring color", () => {
    const { container } = render(<AdminBadge variant="plan">GROWTH</AdminBadge>);
    expect(screen.getByText("Growth")).toBeInTheDocument();
    const span = container.querySelector("span");
    expect(span?.className).toEqual(expect.stringContaining("teal"));
  });

  it("renders SCALE as 'Scale' with an indigo ring color", () => {
    const { container } = render(<AdminBadge variant="plan">SCALE</AdminBadge>);
    expect(screen.getByText("Scale")).toBeInTheDocument();
    const span = container.querySelector("span");
    expect(span?.className).toEqual(expect.stringContaining("indigo"));
  });

  // R23 regression guard only — this mapping already exists today and is not new T14-1 coverage;
  // do not count it toward T14-1's red evidence.
  it("keeps the existing PROFESSIONAL -> 'Business' mapping unchanged", () => {
    render(<AdminBadge variant="plan">PROFESSIONAL</AdminBadge>);
    expect(screen.getByText("Business")).toBeInTheDocument();
  });
});
