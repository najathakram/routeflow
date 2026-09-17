"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, Menu, X } from "lucide-react";
import { cn } from "@routeflow/ui/web";

/**
 * Owner build (2026-09-17): every shell gets the same collapsible-sidebar pattern —
 * phone/tablet hides the sidebar behind a menu button that slides one over; desktop
 * collapses to a narrow icon rail; the choice is remembered per device. Extracted from
 * `(dashboard)/layout.tsx`'s `DashboardShell` (the one shell that already had this,
 * B449/B471 lineage) so buyer portal and platform-admin (B478/B479) get the identical
 * mechanics instead of a second, drifting reimplementation.
 *
 * This module shares the STATEFUL/behavioral pieces — the ones actually risky to get
 * subtly wrong (Esc-to-close, body-scroll-lock while the drawer is open, closing on
 * route change, the mobile-vs-saved-preference initial collapsed value, localStorage
 * persistence) — plus the small presentational pieces whose markup/aria-labels are
 * meant to be byte-identical everywhere (the toggle button, the hamburger trigger, the
 * drawer overlay). Each shell keeps its OWN `<aside>` inner content (nav items, brand,
 * footer) — that varies too much shell to shell to force through one rigid prop API,
 * and forcing it would risk the actual content, not just its chrome.
 */

export interface UseResponsiveSidebarResult {
  /** Desktop rail collapsed to the icon-only width. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Mobile/tablet off-canvas drawer open. */
  mobileNavOpen: boolean;
  openMobileNav: () => void;
  closeMobileNav: () => void;
}

/**
 * `storageKey` must be distinct per shell (e.g. `"rf-sidebar-collapsed"` for the tenant
 * dashboard, `"rf-buyer-sidebar-collapsed"` for the buyer portal, `"rf-admin-sidebar-collapsed"`
 * for platform-admin) — a shared key would let one shell's collapse preference leak into
 * another's on the same device.
 */
export function useResponsiveSidebar(storageKey: string): UseResponsiveSidebarResult {
  const [collapsed, setCollapsed] = React.useState(() => {
    if (typeof window === "undefined") return false;
    // Auto-collapse on small screens, otherwise respect the saved preference.
    if (window.innerWidth < 768) return true;
    return localStorage.getItem(storageKey) === "true";
  });
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const pathname = usePathname();

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem(storageKey, String(next));
      return next;
    });
  }, [storageKey]);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Esc closes the mobile drawer; lock body scroll while it is open.
  React.useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileNavOpen]);

  return {
    collapsed,
    toggleCollapsed,
    mobileNavOpen,
    openMobileNav: () => setMobileNavOpen(true),
    closeMobileNav: () => setMobileNavOpen(false),
  };
}

export interface SidebarCollapseToggleProps {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}

/** The desktop rail's collapse/expand control — markup/aria-labels match the dashboard's. */
export function SidebarCollapseToggle({
  collapsed,
  onToggle,
  className,
}: SidebarCollapseToggleProps) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        "flex w-full items-center rounded-lg px-3 py-2.5 transition-colors",
        collapsed ? "justify-center" : "gap-3",
        className,
      )}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {collapsed ? (
        <ChevronRight className="h-5 w-5 shrink-0" />
      ) : (
        <>
          <ChevronLeft className="h-5 w-5 shrink-0" />
          <span className="text-sm font-medium">Collapse</span>
        </>
      )}
    </button>
  );
}

export interface MobileNavTriggerProps {
  onOpen: () => void;
  className?: string;
}

/** The hamburger that opens the mobile drawer — markup/aria-label match the dashboard's. */
export function MobileNavTrigger({ onOpen, className }: MobileNavTriggerProps) {
  return (
    <button
      onClick={onOpen}
      className={cn("lg:hidden", className)}
      aria-label="Open navigation menu"
    >
      <Menu className="h-5 w-5" />
    </button>
  );
}

export interface MobileSidebarDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The drawer's own `<aside>` (or equivalent) — full inner content supplied by the caller. */
  children: React.ReactNode;
}

/**
 * The off-canvas drawer overlay — markup/aria match the dashboard's (`role="dialog"`,
 * `aria-modal`, click-outside-to-close backdrop). Caller supplies the drawer panel itself
 * (its own `<aside>` with brand/nav/footer content and its own close button), since that
 * content differs shell to shell.
 *
 * Focus handling: the dashboard's original implementation never moved focus at all (a
 * `role="dialog" aria-modal="true"` that doesn't manage focus fails the ARIA authoring
 * practice for dialogs) — added here since every shell now shares this component: on open,
 * focus moves into the panel; on close, it returns to whatever triggered the open (typically
 * the hamburger button), so a keyboard/screen-reader user isn't stranded on a dismissed drawer
 * or dropped back at the top of the page.
 */
export function MobileSidebarDrawer({ open, onClose, children }: MobileSidebarDrawerProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const previouslyFocused = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 lg:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
    >
      <div
        className="absolute inset-0 bg-black/40 animate-in fade-in-0"
        aria-hidden="true"
        onClick={onClose}
      />
      {/* Plain (non-positioned) wrapper: doesn't establish a containing block, so the
          absolutely-positioned drawer panel inside `children` still resolves against this
          div's own fixed-positioned parent above — display:contents would be invisible to
          layout too, but it also makes an element UNFOCUSABLE in most browsers, which would
          silently break the .focus() call below. */}
      <div ref={panelRef} tabIndex={-1} className="outline-none">
        {children}
      </div>
    </div>
  );
}

export interface MobileDrawerCloseButtonProps {
  onClose: () => void;
  className?: string;
}

/** The drawer panel's own close (X) button — markup/aria-label match the dashboard's. */
export function MobileDrawerCloseButton({ onClose, className }: MobileDrawerCloseButtonProps) {
  return (
    <button onClick={onClose} className={className} aria-label="Close navigation menu">
      <X className="h-5 w-5" />
    </button>
  );
}
