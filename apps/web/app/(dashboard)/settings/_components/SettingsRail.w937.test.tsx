import * as React from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsRail } from "./SettingsRail";

/**
 * W-937 at xl and up: the rail (not the hub) holds the finder, and it lives in the settings layout, so it outlives
 * every navigation. Leaving /settings for a result and pressing Back must bring the typed query back in the RAIL too;
 * a fresh visit, or a Back that lands elsewhere, must not. (The hub's own finder is covered in SettingsHub.w937.test.)
 */
let mockPath = "/settings";
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: undefined }),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(""),
}));

beforeEach(() => {
  mockPath = "/settings";
  window.history.replaceState(null, "", "/settings");
});

const search = () => screen.getByLabelText("Search settings") as HTMLInputElement;
/** The router navigates: the entry's URL changes and the layout (rail included) re-renders on the new location. */
const go = (ui: React.ReactElement, rerender: (u: React.ReactElement) => void, path: string) => {
  mockPath = path;
  rerender(ui);
};

describe("rail search memory on Back (xl and up)", () => {
  it("opening a result clears the rail's search; Back to /settings brings the query back", () => {
    const ui = <SettingsRail isAdmin />;
    const { rerender } = renderWithProviders(ui);
    fireEvent.change(search(), { target: { value: "billing" } });
    window.history.pushState(null, "", "/settings/billing");
    go(ui, rerender, "/settings/billing");
    expect(search().value).toBe(""); // SA PR1b M1: the result you opened is the current row, not a stuck list
    window.history.replaceState(null, "", "/settings"); // Back
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    go(ui, rerender, "/settings");
    expect(search().value).toBe("billing");
  });

  it("a fresh visit to /settings (a new entry, no Back) starts empty", () => {
    const ui = <SettingsRail isAdmin />;
    const { rerender } = renderWithProviders(ui);
    fireEvent.change(search(), { target: { value: "billing" } });
    window.history.pushState(null, "", "/settings/billing");
    go(ui, rerender, "/settings/billing");
    window.history.pushState(null, "", "/settings"); // a link, not Back: no popstate
    go(ui, rerender, "/settings");
    expect(search().value).toBe("");
  });

  it("a Back that lands on another settings page does not arm a later fresh visit", () => {
    const ui = <SettingsRail isAdmin />;
    const { rerender } = renderWithProviders(ui);
    fireEvent.change(search(), { target: { value: "billing" } });
    window.history.pushState(null, "", "/settings/billing");
    go(ui, rerender, "/settings/billing");
    window.history.replaceState(null, "", "/settings/restrictions"); // Back lands on a sub-page
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    go(ui, rerender, "/settings/restrictions");
    window.history.pushState(null, "", "/settings"); // later, a fresh visit
    go(ui, rerender, "/settings");
    expect(search().value).toBe("");
  });
});
