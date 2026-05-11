"use client";

import { usePathname } from "next/navigation";
import { AutoRedirectIfAuthed } from "@/components/AutoRedirectIfAuthed";
import { MarketingNav } from "./components/nav";
import { MarketingFooter } from "./components/footer";
import { StickyAppBar } from "./components/sticky-app-bar";
import { getSideFromPath, isLandingRoute } from "./components/use-side";
import "./marketing.css";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const side = getSideFromPath(pathname);
  const landing = isLandingRoute(pathname);

  return (
    <div className="rf-marketing" data-side={side}>
      {/* Already-signed-in users on the home, /retailers, or /wholesalers landings
          get punted straight to their dashboard. Browseable pages (/product, /pricing,
          /company) intentionally don't redirect — a logged-in operator browsing
          pricing for a referral shouldn't be bounced. */}
      <AutoRedirectIfAuthed disabled={!landing} />
      <MarketingNav />
      {children}
      <MarketingFooter />
      <StickyAppBar />
    </div>
  );
}
