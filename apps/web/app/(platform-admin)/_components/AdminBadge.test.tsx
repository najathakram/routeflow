import * as React from "react";
import { render, screen } from "@testing-library/react";
import { AdminBadge, statusLabel } from "./AdminBadge";

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

describe("AdminBadge — status variant (W-785)", () => {
  it("renders PENDING_SELLER_APPROVAL as 'Pending seller approval'", () => {
    render(<AdminBadge>PENDING_SELLER_APPROVAL</AdminBadge>);
    expect(screen.getByText("Pending seller approval")).toBeInTheDocument();
  });

  it("labels READ_ONLY, INACTIVE, INVITED and DISCONNECTED", () => {
    expect(statusLabel("READ_ONLY")).toBe("Read-only");
    expect(statusLabel("INACTIVE")).toBe("Inactive");
    expect(statusLabel("INVITED")).toBe("Invited");
    expect(statusLabel("DISCONNECTED")).toBe("Disconnected");
  });

  it("falls back to sentence case for an unknown status", () => {
    expect(statusLabel("SOME_NEW_STATE")).toBe("Some new state");
  });
});
