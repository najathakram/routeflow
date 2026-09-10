import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContentSecurityPolicy } from "./csp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained Node.js server for Docker deployment
  output: "standalone",

  // Pin the Turbopack workspace root to this app's grandparent (the repo
  // root, whether checked out at the main path or under .claude/worktrees/*).
  // Without this, Next 16 + Turbopack picks the wrong root when multiple
  // lockfiles are present in a worktree setup.
  turbopack: {
    root: path.resolve(__dirname, "..", ".."),
  },

  // Transpile monorepo packages so Next.js can compile their TypeScript/JSX
  transpilePackages: ["@routeflow/ui", "@routeflow/types"],

  // Skip ESLint + TypeScript checks during production builds — both run
  // separately in CI. Without this, stale type mismatches and missing ESLint
  // plugin configs from the monorepo lockfile block the Docker build.
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },

  // Disable source maps in production — prevents attackers from reading
  // unminified code and discovering internal logic/patterns.
  productionBrowserSourceMaps: false,

  // Defence in depth for GHSA-2xp9-vwfh-vxw4 — fixed in Next 15.5.25 (its audit-allowlist entry
  // is retired); the optimizer stays off because the app never renders next/image. Pinned by
  // components/next-config-images.static.test.ts.
  images: {
    unoptimized: true,
  },

  async redirects() {
    return [
      {
        source: "/route-runs/:id",
        destination: "/routes/:id",
        permanent: true,
      },
      {
        source: "/route-runs/:id/dispatch",
        destination: "/routes/:id/dispatch",
        permanent: true,
      },
      // /distributors is the URL the original marketing design used for the
      // wholesaler-side page; /wholesalers is the canonical URL. This used to
      // be a prerendered `redirect()` page (app/(marketing)/distributors/
      // page.tsx), but a prerendered redirect() page served from the ISR
      // cache lost its Location header on the standalone server (307, no
      // Location; spec 36 T1 red on 2026-09-08). A next.config redirect is
      // evaluated before middleware, so it always carries the Location header.
      {
        source: "/distributors",
        destination: "/wholesalers",
        permanent: false,
      },
    ];
  },

  // Security headers applied to all routes
  async headers() {
    // F11-001: real Content-Security-Policy replacing the legacy X-XSS-Protection stub.
    // 'unsafe-inline' is required for Tailwind's runtime style injection and for
    // react-pdf's inline SVG; 'unsafe-eval' is required by Next.js dev overlay and by
    // some Radix/Framer internals. Both should be tightened to nonces once the app
    // migrates to a nonce-based CSP. connect-src covers the Railway API + socket.io.
    // NODE_ENV is not a usable discriminator in a built image — `next build` forces
    // production, so this branch is dead in every Docker image; the http API origin is
    // derived from NEXT_PUBLIC_API_URL instead (prod is https -> no change).
    const isDev = process.env.NODE_ENV !== "production";
    const csp = buildContentSecurityPolicy({ isDev, apiUrl: process.env.NEXT_PUBLIC_API_URL });

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            // camera=(self): the dashboard scans barcodes / invoices with the
            // device camera (getUserMedia). camera=() disabled it entirely —
            // Android Chrome enforces this header and threw "access denied"
            // even with the browser permission granted (iOS Safari ignored it,
            // so iPhone worked). Same-origin is all the scanner needs.
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(self), payment=(self)",
          },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
      // F3-004: password-reset pages land with a single-use token in the URL.
      // Force no-referrer here (stricter than the site default) so the token can
      // never leak via the Referer of any subresource these pages load. The pages
      // also strip the token from the visible URL client-side after reading it.
      {
        source: "/reset-password",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        source: "/buyer/reset-password",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
