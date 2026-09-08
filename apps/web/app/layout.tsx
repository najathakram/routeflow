import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif, Spline_Sans, Spline_Sans_Mono } from "next/font/google";
import { geistSans, geistMono } from "./fonts";
import "./globals.css";
// Marketing stylesheet. It has to be imported here, not from the segments that
// use it: the App Router drops the `not-found` segment's own CSS chunk on
// hydration, so `app/not-found.tsx` rendered completely unstyled (verified in
// the browser — the <link> is in the server HTML but is removed by the client
// router and never fetched). Loading it at the root is safe because every rule
// in the file is scoped under `.rf-marketing` (asserted in
// `app/(marketing)/marketing-port.static.test.ts`).
// Accepted cost: the whole marketing stylesheet (214,999 B raw / 35,939 B gzip,
// against globals.css at 6,433 / 2,328) now ships in the shared root chunk on
// every route, authenticated ones included. Follow-up condition: once
// `next build` succeeds on master (it fails today for the pre-existing
// ReactCurrentDispatcher reason), verify against a PRODUCTION build whether
// importing marketing.css from `app/(marketing)/layout.tsx` + `app/not-found.tsx`
// keeps the 404 styled — if it does, move the import back out of the root.
import "./(marketing)/marketing.css";
import { Providers } from "./providers";
import { TenantProvider } from "@/components/tenant-provider";
import { ServiceWorkerRegistry } from "@/components/ServiceWorkerRegistry";
import { SentryInit } from "@/components/SentryInit";

// Ledger UI typeface. Drives `font-sans` app-wide via --font-spline.
const splineSans = Spline_Sans({
  subsets: ["latin"],
  variable: "--font-spline",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// Ledger monospace — money columns and codes (tabular-nums) via .money / .mono.
const splineSansMono = Spline_Sans_Mono({
  subsets: ["latin"],
  variable: "--font-spline-mono",
  weight: ["400", "500", "600"],
  display: "swap",
});

// Kept as a fallback in the font stack during the Spline Sans migration.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// Marketing site display font. The italic face drives the <em> styling in
// display headings (`<h1 className="display">…<em>…</em>…`). Loaded once at
// the root, but the marketing CSS scopes it under `.rf-marketing` so the
// rest of the app keeps using Inter.
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // No maximumScale / userScalable lock — users must be able to pinch-zoom
  // (WCAG 2.1 SC 1.4.4 Resize Text). Locking zoom breaks low-vision access on
  // this data-dense app.
  // Match the RouteFlow brand: ink (#0E1F36) for the iOS/Android status-bar
  // tint. The old #2563eb pre-dated the cream/ink/teal palette.
  themeColor: "#0E1F36",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://www.routeflow.info"),
  title: { default: "RouteFlow", template: "%s · RouteFlow" },
  description:
    "The all-in-one platform for wholesale distribution. Manage orders, plan routes, track deliveries, and invoice customers.",
  manifest: "/operator-manifest.json",
  appleWebApp: {
    capable: true,
    title: "RouteFlow",
    statusBarStyle: "black-translucent",
    startupImage: "/brand/routeflow-mark-192.png",
  },
  icons: {
    icon: [{ url: "/brand/routeflow-mark-64.png", type: "image/png", sizes: "64x64" }],
    apple: [{ url: "/brand/routeflow-mark-180.png", sizes: "180x180" }],
    shortcut: "/brand/routeflow-mark-64.png",
  },
  openGraph: {
    title: "RouteFlow",
    description: "Wholesale distribution, simplified.",
    siteName: "RouteFlow",
    type: "website",
    images: [{ url: "/brand/routeflow-mark-512.png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${splineSans.variable} ${splineSansMono.variable} ${inter.variable} ${instrumentSerif.variable} ${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <TenantProvider>
          <Providers>{children}</Providers>
          <ServiceWorkerRegistry />
          <SentryInit />
        </TenantProvider>
      </body>
    </html>
  );
}
