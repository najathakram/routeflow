"use client";

import { usePathname } from "next/navigation";
import { MarketingNav } from "./components/nav";
import { MarketingFooter } from "./components/footer";
import { getSideFromPath } from "./components/use-side";
import "./marketing.css";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const side = getSideFromPath(pathname);

  // Note: signed-in users are redirected away from `/` by the middleware
  // (rf-op-auth → /dashboard, rf-buyer-auth → /buyer/portal), keyed on the
  // presence cookies which track the live session (lib/presence-cookies.ts).
  // An earlier client-side AutoRedirectIfAuthed component here was removed
  // because its localStorage-only check falsely fired on stale tokens and
  // hid the marketing site; the middleware approach avoids that because the
  // cookies are cleared whenever a token refresh fails. All marketing pages
  // other than `/` always render, even while signed in.
  return (
    <div className="rf-marketing" data-side={side}>
      <MarketingNav />
      {children}
      <MarketingFooter />
    </div>
  );
}
