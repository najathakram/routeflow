import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BRAND } from "@routeflow/types/brand";
import { frontDoorMetadata, frontDoorViewport } from "@/lib/front-door-metadata";

// The page is a client component, so its head lives in this layout. It keeps the portal's own title
// and share line (buyer/layout.tsx says the same), and takes the share image, icons, app-bar title
// and a white browser bar from the brand seam instead of the buyer layout's green. The manifest
// link stays the app's (buyer/layout.tsx).
export const metadata: Metadata = frontDoorMetadata({
  label: `${BRAND.name} Buyer Portal`,
  shareDescription: "Order from your sellers, track deliveries, manage invoices.",
});
export const viewport = frontDoorViewport;

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
