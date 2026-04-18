import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { TenantProvider } from "@/components/tenant-provider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#2563eb",
};

export const metadata: Metadata = {
  title: { default: "RouteFlow", template: "%s · RouteFlow" },
  description: "The all-in-one platform for wholesale distribution. Manage orders, plan routes, track deliveries, and invoice customers.",
  manifest: "/operator-manifest.json",
  appleWebApp: {
    capable: true,
    title: "RouteFlow",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/logo.svg", type: "image/svg+xml" }],
    apple: "/logo.svg",
  },
  openGraph: {
    title: "RouteFlow",
    description: "Wholesale distribution, simplified.",
    siteName: "RouteFlow",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} font-sans antialiased`}>
        <TenantProvider>
          <Providers>{children}</Providers>
        </TenantProvider>
      </body>
    </html>
  );
}
