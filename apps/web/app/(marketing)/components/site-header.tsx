"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Menu, X, ChevronDown, Store, Warehouse, ArrowUpRight } from "lucide-react";
import { Brand } from "@/components/brand";
import { routes, NAV_SLUGS } from "../lib/site";
import { authLinks } from "./auth-links";

// The five primary-nav items, sourced from the single `routes` table (L-072
// — never hand-mirror labels/hrefs). Contact is deliberately absent from the
// desktop nav (spec.md R2) but appears in the mobile sheet below.
const NAV_LINKS = NAV_SLUGS.map((slug) => {
  const route = routes.find((r) => r.slug === slug);
  if (!route) throw new Error(`SiteHeader: no routes[] entry for "${slug}"`);
  return { href: `/${slug}`, label: route.label };
});

const DROPDOWN_ANIMATION =
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 " +
  "data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 " +
  "data-[side=bottom]:slide-in-from-top-2";

const SHEET_OVERLAY_ANIMATION =
  "fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out " +
  "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0";

// Both Radix portals mount into `document.body`, i.e. outside the
// `.rf-marketing` div stamped by app/(marketing)/layout.tsx. marketing.css
// declares its token table AND every rule for these two surfaces
// (`.rf-marketing .signin-menu`, `.rf-marketing .mobile-panel`, …) as
// descendants of that class, so the portalled subtree carries its own scope
// carrier. `display: contents` keeps the carrier boxless — no stray
// background/min-height from the page-wrapper rules — while descendant
// selectors and inherited custom properties still resolve.
const PORTAL_SCOPE = "rf-marketing";
const PORTAL_SCOPE_STYLE: React.CSSProperties = { display: "contents" };

const SHEET_CONTENT_ANIMATION =
  "fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col outline-none duration-300 " +
  "data-[state=open]:animate-in data-[state=closed]:animate-out " +
  "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right";

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  return (
    <header className="site-header">
      <div className="header-inner wrap">
        <Brand className="brand" />

        <nav className="desktop-nav" aria-label="Primary">
          {NAV_LINKS.map(({ href, label }) => (
            <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </nav>

        <div className="header-actions">
          <div className="nav-login">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="login-trigger">
                Sign in <ChevronDown size={14} aria-hidden="true" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                {/* Radix portals into document.body, outside the layout's
                    `.rf-marketing` div, so re-stamp the scope here — every
                    marketing rule and token is a `.rf-marketing` descendant.
                    `display: contents` gives this carrier no box of its own. */}
                <div className={PORTAL_SCOPE} style={PORTAL_SCOPE_STYLE}>
                  <DropdownMenu.Content
                    className={`signin-menu ${DROPDOWN_ANIMATION}`}
                    align="end"
                    sideOffset={18}
                  >
                    <DropdownMenu.Item asChild>
                      <a href={authLinks.distributorSignIn} aria-label="Distributor sign in">
                        <Warehouse size={18} aria-hidden="true" /> Distributor sign in{" "}
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </a>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item asChild>
                      <a href={authLinks.retailerSignIn} aria-label="Retailer sign in">
                        <Store size={18} aria-hidden="true" /> Retailer sign in{" "}
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </a>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </div>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>

          <Link className="button button-small" href="/contact">
            Book a demo
          </Link>

          <div className="mobile-menu">
            <Dialog.Root open={open} onOpenChange={setOpen}>
              <Dialog.Trigger className="menu-trigger" aria-label="Open menu">
                <Menu size={23} aria-hidden="true" />
              </Dialog.Trigger>
              <Dialog.Portal>
                {/* Same scope carrier as the sign-in menu above — see the note
                    on DropdownMenu.Portal. */}
                <div className={PORTAL_SCOPE} style={PORTAL_SCOPE_STYLE}>
                  <Dialog.Overlay className={SHEET_OVERLAY_ANIMATION} />
                  <Dialog.Content className={`mobile-panel ${SHEET_CONTENT_ANIMATION}`}>
                    <Dialog.Title className="sr-only">Explore RouteFlow</Dialog.Title>
                    <Dialog.Description className="sr-only">
                      Wholesale orders, routes, and accounts.
                    </Dialog.Description>
                    <Dialog.Close className="menu-trigger self-end" aria-label="Close menu">
                      <X size={20} aria-hidden="true" />
                    </Dialog.Close>
                    <nav aria-label="Mobile">
                      {NAV_LINKS.map(({ href, label }) => (
                        <Link
                          key={href}
                          href={href}
                          onClick={() => setOpen(false)}
                          aria-current={pathname === href ? "page" : undefined}
                        >
                          {label}
                          <ArrowUpRight size={18} aria-hidden="true" />
                        </Link>
                      ))}
                      <Link href="/contact" onClick={() => setOpen(false)}>
                        Contact
                        <ArrowUpRight size={18} aria-hidden="true" />
                      </Link>
                    </nav>
                    <div className="mobile-access">
                      <a href={authLinks.distributorSignIn}>
                        Distributor sign in <ArrowUpRight size={16} aria-hidden="true" />
                      </a>
                      <a href={authLinks.retailerSignIn}>
                        Retailer sign in <ArrowUpRight size={16} aria-hidden="true" />
                      </a>
                      {/* ux-spec §3: the sheet carries the primary CTA too — the
                          header's "Book a demo" button is hidden ≤ 480px. */}
                      <Link href="/contact" onClick={() => setOpen(false)}>
                        Book a demo <ArrowUpRight size={16} aria-hidden="true" />
                      </Link>
                    </div>
                  </Dialog.Content>
                </div>
              </Dialog.Portal>
            </Dialog.Root>
          </div>
        </div>
      </div>
    </header>
  );
}
