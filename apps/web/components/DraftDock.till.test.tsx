import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { DraftDock } from "./DraftDock";
import { DraftDockSlot } from "./DraftDockSlot";

/**
 * SA-1066 A-3: on the till nothing of the dock floats. The draft count is a "Drafts (n)" button in the till header's slot
 * (the same secondary 44 px button as Parked); Resume / Discard open in an anchored popover under it. Every other route
 * keeps the floating dock (the other DraftDock suites). jsdom has no layout, so the no-overlap proof is the Mac's table.
 */
const mockPush = jest.fn();
let mockPathname = "/orders/counter-sale";
let mockDrafts: Array<Record<string, unknown>> = [];
const mockDiscard = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => mockPathname,
}));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api/drafts", () => ({
  useDrafts: () => ({ data: mockDrafts }),
  useDeleteDraft: () => ({ mutate: mockDiscard, isPending: false }),
}));

const draft = (id: string) => ({
  id,
  kind: "ORDER",
  title: null,
  customerName: `Cust ${id}`,
  payload: { lineItems: [{ productId: "p1" }] },
  updatedAt: new Date().toISOString(),
});
const dockOnly = () => (
  <ToastProvider>
    <DraftDock />
  </ToastProvider>
);
const withSlot = () => (
  <ToastProvider>
    <div data-testid="till-header">
      <DraftDockSlot />
    </div>
    <DraftDock />
  </ToastProvider>
);
const popover = () => document.querySelector("[data-anchored-popover]") as HTMLElement | null;

beforeEach(() => {
  mockPathname = "/orders/counter-sale";
  mockDrafts = [draft("d1"), draft("d2")];
  mockPush.mockClear();
  mockDiscard.mockClear();
});
afterEach(cleanup);

describe("DraftDock on the till (SA-1066 A-3)", () => {
  it("renders no floating wrapper at all before the header's slot registers", () => {
    const { container } = render(dockOnly());
    expect(container.querySelector("div.absolute")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Drafts/ })).toBeNull();
  });

  it("puts a closed Drafts (n) button in the slot, a secondary 44px button with no floating dock", () => {
    const { container } = render(withSlot());
    const slot = screen.getByTestId("draft-dock-slot");
    const btn = within(slot).getByRole("button", { name: "Drafts (2)" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(btn.className).toMatch(/(^|\s)min-h-\[44px\](\s|$)/);
    expect(container.querySelector("div.absolute")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(popover()).toBeNull();
  });

  it("opens the Resume / Discard chips in a popover and folds on a second click", () => {
    render(withSlot());
    const btn = screen.getByRole("button", { name: "Drafts (2)" });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const pop = popover() as HTMLElement;
    expect(pop).not.toBeNull();
    expect(within(pop).getAllByRole("button", { name: "Resume" })).toHaveLength(2);
    expect(within(pop).getAllByRole("button", { name: "Discard draft" })).toHaveLength(2);
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(popover()).toBeNull();
  });

  it("Escape folds the popover and returns focus to the Drafts button", () => {
    render(withSlot());
    const btn = screen.getByRole("button", { name: "Drafts (2)" });
    fireEvent.click(btn);
    expect(document.activeElement).not.toBe(btn);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(popover()).toBeNull();
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(btn);
  });

  it("a pointerdown outside folds the popover; one inside it does not", () => {
    render(withSlot());
    fireEvent.click(screen.getByRole("button", { name: "Drafts (2)" }));
    fireEvent.pointerDown(
      within(popover() as HTMLElement).getAllByRole("button", { name: "Resume" })[0],
    );
    expect(popover()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(popover()).toBeNull();
  });

  it("Resume goes through the guarded router and folds the popover", () => {
    render(withSlot());
    fireEvent.click(screen.getByRole("button", { name: "Drafts (2)" }));
    fireEvent.click(within(popover() as HTMLElement).getAllByRole("button", { name: "Resume" })[0]);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0]).toContain("resumeDraft=d1");
    expect(popover()).toBeNull();
  });

  it("Discard folds the popover and asks first; nothing is deleted until confirmed", () => {
    render(withSlot());
    fireEvent.click(screen.getByRole("button", { name: "Drafts (2)" }));
    fireEvent.click(
      within(popover() as HTMLElement).getAllByRole("button", { name: "Discard draft" })[0],
    );
    expect(popover()).toBeNull();
    expect(screen.getByText("Discard this draft?")).toBeInTheDocument();
    expect(mockDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(mockDiscard).toHaveBeenCalledWith("d1", expect.anything());
  });

  it("the scan-to-draft prompt still opens from a wedge scan while drafts are parked", () => {
    render(withSlot());
    for (const key of "ABCDEFGH") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByText("Add scanned item to a draft?")).toBeInTheDocument();
  });

  it("no drafts: no button, and the slot stays empty so it takes no room in the header row", () => {
    mockDrafts = [];
    render(withSlot());
    expect(screen.queryByRole("button", { name: /Drafts/ })).toBeNull();
    const slot = screen.getByTestId("draft-dock-slot");
    expect(slot).toBeEmptyDOMElement();
    expect(slot.className).toMatch(/(^|\s)empty:hidden(\s|$)/);
  });

  it("guard: on another route the dock floats as before, even with a slot mounted", () => {
    mockPathname = "/orders";
    const { container } = render(withSlot());
    expect(screen.queryByRole("button", { name: /^Drafts/ })).toBeNull();
    expect(screen.getByTestId("draft-dock-slot")).toBeEmptyDOMElement();
    const wrapper = container.querySelector("div.absolute") as HTMLElement;
    expect(wrapper.className).toMatch(/(^|\s)left-4(\s|$)/);
    expect(wrapper.className).not.toMatch(/md:left-auto|md:right-4/);
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(2);
  });
});
