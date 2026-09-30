import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  useResponsiveSidebar,
  SidebarCollapseToggle,
  MobileNavTrigger,
  MobileSidebarDrawer,
  MobileDrawerCloseButton,
} from "./ResponsiveSidebar";

/**
 * Owner build (2026-09-17): collapsible sidebar shared across shells. Covers the pieces that
 * are actually risky to get subtly wrong — the toggle/persistence, the drawer's open/close and
 * focus handling, and that two shells' storage keys never collide — not the bespoke content
 * each shell renders inside it (that's covered per-shell, e.g. NavLink's own collapsed
 * rendering in the buyer portal layout).
 */

let mockPathname = "/orders";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

function Harness({ storageKey }: { storageKey: string }) {
  const sidebar = useResponsiveSidebar(storageKey);
  return (
    <div>
      <MobileNavTrigger onOpen={sidebar.openMobileNav} />
      <SidebarCollapseToggle collapsed={sidebar.collapsed} onToggle={sidebar.toggleCollapsed} />
      <span data-testid="collapsed-state">{String(sidebar.collapsed)}</span>
      <MobileSidebarDrawer open={sidebar.mobileNavOpen} onClose={sidebar.closeMobileNav}>
        <aside>
          <MobileDrawerCloseButton onClose={sidebar.closeMobileNav} />
          <button data-testid="drawer-nav-link">Dashboard</button>
        </aside>
      </MobileSidebarDrawer>
    </div>
  );
}

beforeEach(() => {
  mockPathname = "/orders";
  localStorage.clear();
  document.body.style.overflow = "";
});

afterEach(() => {
  cleanup();
});

describe("useResponsiveSidebar — desktop collapse toggle + persistence", () => {
  it("starts expanded by default and toggles to collapsed on click", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    expect(screen.getByTestId("collapsed-state")).toHaveTextContent("false");
    expect(screen.getByLabelText("Collapse sidebar")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Collapse sidebar"));

    expect(screen.getByTestId("collapsed-state")).toHaveTextContent("true");
    expect(screen.getByLabelText("Expand sidebar")).toBeInTheDocument();
  });

  it("persists the collapsed state to localStorage under the given key", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    fireEvent.click(screen.getByLabelText("Collapse sidebar"));
    expect(localStorage.getItem("rf-test-sidebar-collapsed")).toBe("true");

    fireEvent.click(screen.getByLabelText("Expand sidebar"));
    expect(localStorage.getItem("rf-test-sidebar-collapsed")).toBe("false");
  });

  it("respects a previously-persisted collapsed=true on mount", () => {
    localStorage.setItem("rf-test-sidebar-collapsed", "true");
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    expect(screen.getByTestId("collapsed-state")).toHaveTextContent("true");
  });

  it("two shells' storage keys never collide — B479/B480/dashboard each get their own preference", () => {
    localStorage.setItem("rf-sidebar-collapsed", "true"); // dashboard's key, pre-collapsed
    render(<Harness storageKey="rf-buyer-sidebar-collapsed" />); // buyer portal's own key
    // The buyer harness must NOT pick up the dashboard's collapsed=true.
    expect(screen.getByTestId("collapsed-state")).toHaveTextContent("false");
  });
});

describe("MobileSidebarDrawer — open/close, Esc, backdrop, route change, body scroll lock", () => {
  it("opens on trigger click and closes on the close button", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Close navigation menu"));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });

  it("closes on backdrop click", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    const backdrop = dialog.firstElementChild as HTMLElement; // aria-hidden overlay div
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });

  it("locks body scroll while open and restores it on close", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    expect(document.body.style.overflow).toBe("");

    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByLabelText("Close navigation menu"));
    expect(document.body.style.overflow).toBe("");
  });

  it("closes when the route changes (rerender with a new pathname)", () => {
    const { rerender } = render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    fireEvent.click(screen.getByLabelText("Open navigation menu"));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();

    mockPathname = "/invoices";
    rerender(<Harness storageKey="rf-test-sidebar-collapsed" />);
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });
});

describe("MobileSidebarDrawer — focus handling", () => {
  it("moves focus into the drawer panel on open", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    const trigger = screen.getByLabelText("Open navigation menu");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);

    // Focus lands on the drawer's own focus container (tabIndex=-1 wrapper) — not left on the
    // trigger underneath the now-open overlay, and not lost to <body>.
    expect(document.activeElement).not.toBe(trigger);
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("returns focus to the trigger that opened it once closed", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    const trigger = screen.getByLabelText("Open navigation menu");
    trigger.focus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByLabelText("Close navigation menu"));

    expect(document.activeElement).toBe(trigger);
  });
});

describe("MobileSidebarDrawer — focus trap (Tab/Shift+Tab stay inside while open)", () => {
  it("Tab from the last focusable element wraps to the first", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    fireEvent.click(screen.getByLabelText("Open navigation menu"));

    const closeButton = screen.getByLabelText("Close navigation menu");
    const navLink = screen.getByTestId("drawer-nav-link");
    navLink.focus();
    expect(document.activeElement).toBe(navLink);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
  });

  it("Shift+Tab from the first focusable element wraps to the last", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    fireEvent.click(screen.getByLabelText("Open navigation menu"));

    const closeButton = screen.getByLabelText("Close navigation menu");
    const navLink = screen.getByTestId("drawer-nav-link");
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(navLink);
  });

  it("does nothing to Tab presses once the drawer is closed (trap only applies while open)", () => {
    render(<Harness storageKey="rf-test-sidebar-collapsed" />);
    const trigger = screen.getByLabelText("Open navigation menu");
    // jsdom's fireEvent.click does not also focus the element the way a real browser click
    // does — focus it explicitly so "focus returns to the trigger" has something real to
    // return to (same pattern as the "focus handling" describe block above).
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByLabelText("Close navigation menu"));
    expect(document.activeElement).toBe(trigger);

    // No drawer content in the document to trap focus into — Tab is a no-op for this component.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(trigger);
  });
});
