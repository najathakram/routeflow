import * as React from "react";
import { act } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { renderWithProviders, screen } from "@/test-utils/render";
import { markReadOnlyRefused, resetReadOnlyRefusedForTests } from "@/lib/read-only-gate";
import { DriverReadOnlyBanner } from "./DriverReadOnlyBanner";

/**
 * The driver shell has no subscription read (the billing endpoint is staff-only), so its read-only banner is driven
 * by the one thing a driver can observe: a 403 READ_ONLY refusal of a write, which carries the tenant's reason.
 */
afterEach(() => act(() => resetReadOnlyRefusedForTests()));

describe("DriverReadOnlyBanner", () => {
  it("shows nothing until a write was refused as read-only", () => {
    renderWithProviders(<DriverReadOnlyBanner />);
    expect(screen.queryByText(/read-only mode/)).toBeNull();
  });

  it("after a 403 READ_ONLY it shows the same banner: the owner's sentence + the reason, no admin action", () => {
    renderWithProviders(<DriverReadOnlyBanner />);
    act(() => markReadOnlyRefused("payment_overdue"));
    const banner = screen.getByText(/This workspace is currently in read-only mode\./);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/Your subscription payment is overdue\./)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Billing|Choose a plan/ })).toBeNull();
  });

  it("is wired into the dashboard shell for the DRIVER role (static pin)", () => {
    const layout = readFileSync(join(__dirname, "../app/(dashboard)/layout.tsx"), "utf8");
    expect(layout).toMatch(/<DriverReadOnlyBanner\s*\/>/);
    expect(layout).toMatch(/role === "DRIVER"/);
  });
});
