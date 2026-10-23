import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { DraftDock } from "./DraftDock";

/**
 * B668: on a narrow viewport (768 / 390) the collapsed dock floated two full draft chips over page
 * content (it covered the New-unit fields). Collapsed on a narrow screen it is now one small
 * "N parked drafts" pill; one tap expands to the chips with Resume / Discard (nothing is lost).
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
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

const setNarrow = (narrow: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};
const ui = () => (
  <ToastProvider>
    <DraftDock />
  </ToastProvider>
);
afterEach(cleanup);

describe("DraftDock: narrow-viewport tray (B668)", () => {
  it("collapsed on a narrow screen shows only the pill, not the draft chips", () => {
    setNarrow(true);
    render(ui());
    expect(screen.getByRole("button", { name: /2 parked drafts/ })).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: "Resume" })).toHaveLength(0);
  });

  it("tapping the pill reveals every draft with Resume and Discard", () => {
    setNarrow(true);
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: /2 parked drafts/ }));
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Discard draft" })).toHaveLength(2);
  });

  it("on a wide screen the chips stay visible as before", () => {
    setNarrow(false);
    render(ui());
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(2);
  });
});
