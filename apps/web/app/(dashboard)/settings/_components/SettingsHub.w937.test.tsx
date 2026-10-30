import * as React from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsHub } from "./SettingsHub";

/** W-937: the search survives Back, a dead-end query points somewhere, and the Counter header links to the Counter. */

let mockCounter = true;
jest.mock("@/lib/api/counter-sale", () => ({
  ...jest.requireActual("@/lib/api/counter-sale"),
  useCounterSaleGate: () => ({ showButton: mockCounter, capability: {} }),
}));
jest.mock("@/lib/api/restrictions-settings", () => ({
  useRestrictionsSettings: () => ({ data: { enabled: true }, isLoading: false, isError: false }),
}));
jest.mock("./RouteDefaultsCard", () => ({
  RouteDefaultsCard: () => <div>route-defaults-card</div>,
}));
jest.mock("./BuyerOversellCard", () => ({ BuyerOversellCard: () => <div>oversell-card</div> }));

beforeEach(() => {
  mockCounter = true;
  window.history.replaceState(null, "", "/settings");
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
});

const search = () => screen.getByLabelText("Search settings") as HTMLInputElement;

describe("search memory on Back", () => {
  it("Back restores the query even when the router has rewritten the entry's state", () => {
    const first = renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(search(), { target: { value: "smtp" } });
    first.unmount();
    // the router replaces the entry's state on restore, dropping our key; then Back fires popstate
    window.history.replaceState(null, "", "/settings");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    renderWithProviders(<SettingsHub isAdmin />);
    expect(search().value).toBe("smtp");
  });

  it("a Back on ANOTHER page does not make the next fresh visit to settings restore the query", () => {
    const first = renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(search(), { target: { value: "smtp" } });
    first.unmount();
    // Back lands on an unrelated page (the hub is not mounted there); the listener must not stay armed
    window.history.replaceState(null, "", "/orders/42");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    // later /settings is opened fresh from a link: a new entry, no popstate
    window.history.replaceState(null, "", "/settings");
    renderWithProviders(<SettingsHub isAdmin />);
    expect(search().value).toBe("");
  });

  it("Back to a settings sub-page is not a return to the hub either", () => {
    const first = renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(search(), { target: { value: "smtp" } });
    first.unmount();
    window.history.replaceState(null, "", "/settings/restrictions");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    window.history.replaceState(null, "", "/settings");
    renderWithProviders(<SettingsHub isAdmin />);
    expect(search().value).toBe("");
  });

  it("a fresh visit (no Back) starts empty", () => {
    const first = renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(search(), { target: { value: "smtp" } });
    first.unmount();
    window.history.replaceState(null, "", "/settings");
    renderWithProviders(<SettingsHub isAdmin />);
    expect(search().value).toBe("");
  });
});

describe("dead-end query", () => {
  it("'collection' says where to look", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(search(), { target: { value: "collection" } });
    expect(screen.getByText("No settings match “collection”.")).toBeInTheDocument();
    expect(screen.getByText("Try pickup, delivery or counter.")).toBeInTheDocument();
  });
});

describe("Counter group header link", () => {
  it("links to the Counter when counter sales are on", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    const group = screen.getByTestId("settings-group-counter");
    expect(within(group).getByRole("link", { name: "Open the Counter" })).toHaveAttribute(
      "href",
      "/orders/counter-sale",
    );
  });

  it("is absent when the counter is off (the group is not shown)", () => {
    mockCounter = false;
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.queryByRole("link", { name: "Open the Counter" })).toBeNull();
  });
});
