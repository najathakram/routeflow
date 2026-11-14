import type { Metadata } from "next";
import { SiteFrame } from "@/components/site-frame/SiteFrame";
import { UmamiScript } from "@/components/UmamiScript";
import { frontDoorMetadata, frontDoorViewport } from "@/lib/front-door-metadata";

// Title, share block, icons, app-bar title and browser-bar colour for these routes come from the
// brand seam, so nothing is inherited from the root layout (see lib/front-door-metadata.ts).
export const metadata: Metadata = frontDoorMetadata();
export const viewport = frontDoorViewport;

// Privacy and Terms are the React pages left in this group; every other public page is a ready-made
// page in public/site. They wear the same frame as those pages (components/site-frame), so the site
// has one header, one footer and one set of type. The text of both documents is untouched.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteFrame>{children}</SiteFrame>
      {/* Visit counts: renders only with a site ID (see UmamiScript). */}
      <UmamiScript />
    </>
  );
}
