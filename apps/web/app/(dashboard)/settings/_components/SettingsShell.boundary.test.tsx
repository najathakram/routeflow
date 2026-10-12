import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsShell } from "./SettingsShell";

// A throw inside the rail must never take down the settings route (billing is where people pay).
jest.mock("next/navigation", () => ({
  usePathname: () => "/settings/billing",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "dana", role: "TENANT_ADMIN" } }),
}));
jest.mock("./SettingsRail", () => ({
  SettingsRail: () => {
    throw new Error("rail exploded");
  },
}));

beforeEach(() => {
  window.matchMedia = ((q: string) => ({
    matches: q.includes("1280"),
    media: q,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
});

it("a throwing rail still renders the pane", () => {
  const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
  renderWithProviders(
    <SettingsShell>
      <div>billing-pane</div>
    </SettingsShell>,
  );
  expect(screen.getByText("billing-pane")).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Settings" })).not.toBeInTheDocument();
  err.mockRestore();
});
