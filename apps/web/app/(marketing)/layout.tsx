"use client";

import { usePathname } from "next/navigation";
import { MarketingNav } from "./components/nav";
import { MarketingFooter } from "./components/footer";
import { StickyAppBar } from "./components/sticky-app-bar";
import { getSideFromPath } from "./components/use-side";
import "./marketing.css";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const side = getSideFromPath(pathname);

  // Note: AutoRedirectIfAuthed used to live here (sending logged-in users
  // straight to /dashboard from `/`, `/retailers`, `/wholesalers`). It was
  // removed because its localStorage-only check would falsely fire for any
  // user with a stale token left over from an expired session — they'd get
  // bounced from `/` to `/dashboard` to `/login` and never see the marketing
  // site at all. Marketing pages now always render; users who want their
  // dashboard click "Sign in" in the nav.
  return (
    <div className="rf-marketing" data-side={side}>
      <MarketingNav />
      {children}
      <MarketingFooter />
      <StickyAppBar />
    </div>
  );
}
