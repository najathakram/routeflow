import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif, Spline_Sans, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { TenantProvider } from "@/components/tenant-provider";
import { ServiceWorkerRegistry } from "@/components/ServiceWorkerRegistry";

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
  title: { default: "RouteFlow", template: "%s · RouteFlow" },
  description:
    "The all-in-one platform for wholesale distribution. Manage orders, plan routes, track deliveries, and invoice customers.",
  manifest: "/operator-manifest.json",
  appleWebApp: {
    capable: true,
    title: "RouteFlow",
    statusBarStyle: "black-translucent",
    startupImage: "/logo.svg",
  },
  icons: {
    icon: [
      { url: "/logo.svg", type: "image/svg+xml" },
      { url: "/favicon.png", type: "image/png", sizes: "64x64" },
    ],
    apple: [{ url: "/logo-seller.png", sizes: "180x180" }],
    shortcut: "/favicon.png",
  },
  openGraph: {
    title: "RouteFlow",
    description: "Wholesale distribution, simplified.",
    siteName: "RouteFlow",
    type: "website",
    images: [{ url: "/logo.svg" }],
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
        className={`${splineSans.variable} ${splineSansMono.variable} ${inter.variable} ${instrumentSerif.variable} font-sans antialiased`}
      >
        <TenantProvider>
          <Providers>{children}</Providers>
          <ServiceWorkerRegistry />
        </TenantProvider>
      </body>
    </html>
  );
}
