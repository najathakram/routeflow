import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { DraftDock } from "./DraftDock";

/**
 * UX guide improvement 2: collapsed, the dock is the "N parked drafts" pill on every width. On a
 * desktop it used to leave two full draft cards floating over the page, covering sticky Save bars.
 * Every draft is still one click away (the pill opens the list); nothing is removed.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
}));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api/drafts", () => ({
  useDrafts: () => ({
    data: ["d1", "d2"].map((id) => ({
      id,
      kind: "ORDER",
      title: null,
      customerName: `Cust ${id}`,
      payload: { lineItems: [{ productId: "p1" }] },
      updatedAt: new Date().toISOString(),
    })),
  }),
  useDeleteDraft: () => ({ mutate: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  // A wide (desktop) viewport: no max-width query matches.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const ui = () => (
  <ToastProvider>
    <DraftDock />
  </ToastProvider>
);

describe("DraftDock: collapsed pill on desktop", () => {
  it("collapsed on a wide screen renders no draft card, only the pill reading 2", () => {
    render(ui());
    expect(screen.queryAllByRole("button", { name: "Resume" })).toHaveLength(0);
    expect(screen.getByRole("button", { name: /2 parked drafts/ })).toBeInTheDocument();
  });

  it("clicking the pill opens both cards, each with Resume and Discard", () => {
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: /2 parked drafts/ }));
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Discard draft" })).toHaveLength(2);
  });
});
