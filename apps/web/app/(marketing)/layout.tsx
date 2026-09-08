import { SiteHeader } from "./components/site-header";
import { SiteFooter } from "./components/site-footer";
import { EditorialMotion } from "./components/editorial-motion";

// Note: signed-in users are redirected away from `/` by the middleware
// (rf-op-auth → /dashboard, rf-buyer-auth → /buyer/portal), keyed on the
// presence cookies which track the live session (lib/presence-cookies.ts).
// An earlier client-side AutoRedirectIfAuthed component here was removed
// because its localStorage-only check falsely fired on stale tokens and hid
// the marketing site; the middleware approach avoids that because the
// cookies are cleared whenever a token refresh fails. All marketing pages
// other than `/` always render, even while signed in.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="rf-marketing">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-[#10264d] focus:shadow-lg"
      >
        Skip to main content
      </a>
      <SiteHeader />
      <main id="main-content">{children}</main>
      <SiteFooter />
      <EditorialMotion />
    </div>
  );
}
