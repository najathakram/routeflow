import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsShell } from "./SettingsShell";

/**
 * Row 468: at xl the screen shifted right once the rail mounted, because the rail column only existed
 * after the client knew it was xl (the server and the first paint read "not xl"). The track is now laid
 * out by CSS from the first paint (hidden below xl), and only the rail's CONTENTS wait for the client.
 */
let mockXl = false;
let mockRole = "TENANT_ADMIN";
jest.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "dana", role: mockRole } }),
}));
jest.mock("./SettingsRail", () => ({
  SettingsRail: () => <nav aria-label="Settings">rail</nav>,
}));

beforeEach(() => {
  mockRole = "TENANT_ADMIN";
  window.matchMedia = ((q: string) => ({
    matches: mockXl && q.includes("1280"),
    media: q,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
});

const tree = () => (
  <SettingsShell>
    <div>pane</div>
  </SettingsShell>
);
const track = (c: HTMLElement) => c.querySelector('[data-testid="settings-rail-track"]');

describe("settings rail track (row 468)", () => {
  it("the xl track is laid out before the client knows it is xl (first paint), contents not yet mounted", () => {
    mockXl = false;
    const { container } = renderWithProviders(tree());
    const t = track(container);
    expect(t).not.toBeNull();
    expect(t!.className).toMatch(/\bhidden\b/);
    expect(t!.className).toMatch(/\bxl:block\b/);
    expect(t!.className).toMatch(/w-\[300px\]/);
    expect(t!.className).toMatch(/flex-none/);
    // the wrapper's two-column layout is CSS (xl:), not a client decision
    expect(screen.getByText("pane").closest("#settings-content")!.parentElement!.className).toMatch(
      /\bxl:flex\b/,
    );
    expect(screen.queryByRole("navigation", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("at xl the same track holds the rail", () => {
    mockXl = true;
    const { container } = renderWithProviders(tree());
    expect(track(container)).toContainElement(screen.getByRole("navigation", { name: "Settings" }));
  });

  it("a customer gets no track at all", () => {
    mockXl = true;
    mockRole = "CUSTOMER";
    const { container } = renderWithProviders(tree());
    expect(track(container)).toBeNull();
  });
});
