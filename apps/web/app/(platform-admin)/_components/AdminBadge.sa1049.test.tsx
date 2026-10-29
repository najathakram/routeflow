import * as React from "react";
import { render, screen } from "@testing-library/react";
import { AdminBadge, planLabel, statusLabel } from "./AdminBadge";

// SA-1049 R5 (L-072): the badge's colour and label maps were hand-typed `Record<string, string>`, so
// TenantPlan TEAM / BUSINESS / LITE and the user, buyer-account and customer-link statuses
// (READ_ONLY, INACTIVE, DELETED, INVITED, PENDING_SELLER_APPROVAL, DISCONNECTED) fell to the slate
// fallback and TEAM / BUSINESS showed their raw key. Each map is now keyed by the whole enum.
const cls = (node: HTMLElement) => (node.querySelector("span") as HTMLElement).className;

describe("AdminBadge — every plan and status has its own label and colour (SA-1049 R5)", () => {
  it("R-3: BUSINESS reads 'Business' in the blue of PROFESSIONAL; TEAM reads 'Team' in the teal of GROWTH", () => {
    const business = render(<AdminBadge variant="plan">BUSINESS</AdminBadge>);
    expect(screen.getByText("Business")).toBeInTheDocument();
    expect(cls(business.container)).toContain("blue");
    business.unmount();
    const team = render(<AdminBadge variant="plan">TEAM</AdminBadge>);
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(cls(team.container)).toContain("teal");
  });

  it("LITE keeps its label and shares STARTER's slate (the label tells them apart)", () => {
    const lite = render(<AdminBadge variant="plan">LITE</AdminBadge>);
    expect(screen.getByText("Lite")).toBeInTheDocument();
    expect(cls(lite.container)).toContain("slate");
    expect(planLabel("STARTER")).toBe("Starter");
  });

  it("R-3: READ_ONLY is amber (restricted), not the slate fallback", () => {
    const { container } = render(<AdminBadge>READ_ONLY</AdminBadge>);
    expect(cls(container)).toContain("amber");
    expect(cls(container)).not.toContain("slate");
  });

  it.each([
    ["ACTIVE", "green"],
    ["TRIAL", "yellow"],
    ["PENDING_SELLER_APPROVAL", "yellow"],
    ["READ_ONLY", "amber"],
    ["SUSPENDED", "red"],
    ["INVITED", "blue"],
    ["CANCELLED", "slate"],
    ["INACTIVE", "slate"],
    ["DELETED", "slate"],
    ["DISCONNECTED", "slate"],
  ])("%s is coloured by its meaning (%s)", (status, colour) => {
    const { container } = render(<AdminBadge>{status}</AdminBadge>);
    expect(cls(container)).toContain(colour);
    expect(screen.getByText(statusLabel(status))).toBeInTheDocument();
  });

  it("a status the badge does not know still falls back to a sentence-case label and slate", () => {
    const { container } = render(<AdminBadge>SOME_NEW_STATE</AdminBadge>);
    expect(screen.getByText("Some new state")).toBeInTheDocument();
    expect(cls(container)).toContain("slate");
  });
});
