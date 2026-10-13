import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsShell } from "./SettingsShell";

// A throw inside the rail must never take down the settings route (billing is where people pay), must not
// leave an empty 300px column behind, and must retry when the user navigates.
let mockPath = "/settings/billing";
let railThrows = true;
jest.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "dana", role: "TENANT_ADMIN" } }),
}));
jest.mock("./SettingsRail", () => ({
  SettingsRail: () => {
    if (railThrows) throw new Error("rail exploded");
    return <nav aria-label="Settings">rail</nav>;
  },
}));

beforeEach(() => {
  mockPath = "/settings/billing";
  railThrows = true;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("1280"),
    media: q,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
});

// A fresh element per render: re-passing the same element object would let React bail out of the update.
const tree = () => (
  <SettingsShell>
    <div>billing-pane</div>
  </SettingsShell>
);

it("a throwing rail still renders the pane and leaves no empty column", () => {
  const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const { container } = renderWithProviders(tree());
  expect(screen.getByText("billing-pane")).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Settings" })).not.toBeInTheDocument();
  expect(container.querySelector("aside")).toBeNull();
  err.mockRestore();
});

it("navigating retries the rail", () => {
  const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const { rerender, container } = renderWithProviders(tree());
  expect(container.querySelector("aside")).toBeNull();
  railThrows = false;
  mockPath = "/settings?tab=invoicing";
  rerender(tree());
  expect(screen.getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByText("billing-pane")).toBeInTheDocument();
  err.mockRestore();
});

it("without a navigation the failed rail stays hidden (no render loop)", () => {
  const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const { rerender, container } = renderWithProviders(tree());
  rerender(tree());
  expect(container.querySelector("aside")).toBeNull();
  err.mockRestore();
});
