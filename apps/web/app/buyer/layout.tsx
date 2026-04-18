import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#047857",
};

export const metadata: Metadata = {
  title: { default: "RouteFlow Buyer Portal", template: "%s · RouteFlow" },
  description: "Order directly from your suppliers. Track deliveries, view invoices, and manage standing orders.",
  manifest: "/buyer-manifest.json",
  appleWebApp: {
    capable: true,
    title: "RouteFlow",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/logo-buyer.svg", type: "image/svg+xml" }],
    apple: "/logo-buyer.svg",
  },
  openGraph: {
    title: "RouteFlow Buyer Portal",
    description: "Order from your suppliers, track deliveries, manage invoices.",
    type: "website",
  },
};

export default function BuyerLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
