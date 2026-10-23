import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { DraftDock } from "./DraftDock";

/**
 * B668: on a narrow viewport (768 / 390) the collapsed dock floated two full draft chips over page
 * content (it covered the New-unit fields). Collapsed on a narrow screen it is now one small
 * "N parked drafts" pill; one tap expands to the chips with Resume / Discard (nothing is lost).
 */
const mockPush = jest.fn();
let mockPathname = "/orders";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => mockPathname,
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
beforeEach(() => {
  mockPathname = "/orders";
  mockPush.mockClear();
});
afterEach(cleanup);
const pill = () => screen.getByRole("button", { name: /2 parked drafts/ });
const resumes = () => screen.queryAllByRole("button", { name: "Resume" });

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

  it("the pill announces its state and controls the chips container", () => {
    setNarrow(true);
    render(ui());
    expect(pill()).toHaveAttribute("aria-expanded", "false");
    const controls = pill().getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    fireEvent.click(pill());
    expect(pill()).toHaveAttribute("aria-expanded", "true");
    const region = document.getElementById(controls as string);
    expect(region).not.toBeNull();
    expect(within(region as HTMLElement).getAllByRole("button", { name: "Resume" })).toHaveLength(
      2,
    );
  });

  it("pill -> chips -> pill: a second tap collapses the tray again", () => {
    setNarrow(true);
    render(ui());
    expect(pill()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(pill());
    expect(pill()).toHaveAttribute("aria-expanded", "true");
    expect(resumes()).toHaveLength(2);
    fireEvent.click(pill());
    expect(pill()).toHaveAttribute("aria-expanded", "false");
    expect(resumes()).toHaveLength(0);
  });

  it("Escape collapses the expanded tray and returns focus to the pill", () => {
    setNarrow(true);
    render(ui());
    fireEvent.click(pill());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(pill()).toHaveAttribute("aria-expanded", "false");
    expect(resumes()).toHaveLength(0);
    expect(pill()).toHaveFocus();
  });

  it("tapping Resume collapses the tray", () => {
    setNarrow(true);
    render(ui());
    fireEvent.click(pill());
    fireEvent.click(resumes()[0]);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(pill()).toHaveAttribute("aria-expanded", "false");
    expect(resumes()).toHaveLength(0);
  });

  it("a route change collapses the expanded tray", () => {
    setNarrow(true);
    const { rerender } = render(ui());
    fireEvent.click(pill());
    expect(resumes()).toHaveLength(2);
    mockPathname = "/customers";
    rerender(ui());
    expect(pill()).toHaveAttribute("aria-expanded", "false");
    expect(resumes()).toHaveLength(0);
  });

  it("stacks below modals (z-40 vs the Modal overlay z-50), so an open modal owns the screen", () => {
    setNarrow(true);
    const { container } = render(ui());
    const wrapper = pill().parentElement as HTMLElement;
    expect(container.contains(wrapper)).toBe(true);
    expect(wrapper.className).toMatch(/(^|\s)z-40(\s|$)/);
  });
});
