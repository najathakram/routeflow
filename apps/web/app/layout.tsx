import type { Metadata, Viewport } from "next";
import { BRAND } from "@routeflow/types/brand";
import { geistSans, geistMono, inter, instrumentSerif, splineSans, splineSansMono } from "./fonts";
import "./globals.css";
// #2653: hides Google sign-in inside the app shell (html[data-shell]); globals.css is hash-pinned.
import "./shell.css";
import { SHELL_MARK_SCRIPT } from "@/lib/in-shell";
// The frame the public React pages wear (Privacy, Terms, sign-in, sign-up, 404). Root import: the
// App Router drops the `not-found` segment's own CSS chunk on hydration, so the frame's stylesheet
// has to load from the root for app/not-found.tsx to be styled.
import "@/components/site-frame/site-frame.css";
import { Providers } from "./providers";
import { TenantProvider } from "@/components/tenant-provider";
import { ServiceWorkerRegistry } from "@/components/ServiceWorkerRegistry";
import { SentryInit } from "@/components/SentryInit";

// Fonts are self-hosted in ./fonts.ts (#2397: next/font/google's build-time fetch failed deploys).

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // No maximumScale / userScalable lock — users must be able to pinch-zoom
  // (WCAG 2.1 SC 1.4.4 Resize Text). Locking zoom breaks low-vision access on
  // this data-dense app.
  // Match the brand: ink (#0E1F36) for the iOS/Android status-bar
  // tint. The old #2563eb pre-dated the cream/ink/teal palette.
  themeColor: "#0E1F36",
};

export const metadata: Metadata = {
  // The browser identity of every route that does not set its own: all of it comes from the brand
  // seam. The signed-out layouts restate it (lib/front-door-metadata.ts); the signed-in app keeps
  // this one until Program B.
  metadataBase: new URL(BRAND.origin),
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description:
    "The all-in-one platform for wholesale distribution. Manage orders, plan routes, track deliveries, and invoice customers.",
  manifest: "/operator-manifest.json",
  appleWebApp: {
    capable: true,
    title: BRAND.name,
    statusBarStyle: "black-translucent",
    startupImage: BRAND.icon["192"],
  },
  icons: {
    // Next always puts a file-based app/favicon.ico first in every route's icons, so no child
    // layout could replace it. It lives in public/ and is listed here, where a layout's own
    // `icons` now take its place.
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: BRAND.icon.favicon, type: "image/png", sizes: "64x64" },
    ],
    apple: [{ url: BRAND.icon.apple, sizes: "180x180" }],
    shortcut: BRAND.icon.favicon,
  },
  openGraph: {
    title: BRAND.name,
    description: "Wholesale distribution, simplified.",
    siteName: BRAND.name,
    type: "website",
    images: [{ url: BRAND.icon["512"] }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: SHELL_MARK_SCRIPT may set data-shell on <html> before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* #2653 / SA-542a: mark the app shell before first paint (no Google sign-in flash). */}
        <script dangerouslySetInnerHTML={{ __html: SHELL_MARK_SCRIPT }} />
      </head>
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
