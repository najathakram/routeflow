import path from "node:path";
import { fileURLToPath } from "node:url";

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

  experimental: {
    // Prevent Next.js from bundling server-only packages into the client
    serverComponentsExternalPackages: [],
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
    ];
  },

  // Security headers applied to all routes
  async headers() {
    // F11-001: real Content-Security-Policy replacing the legacy X-XSS-Protection stub.
    // 'unsafe-inline' is required for Tailwind's runtime style injection and for
    // react-pdf's inline SVG; 'unsafe-eval' is required by Next.js dev overlay and by
    // some Radix/Framer internals. Both should be tightened to nonces once the app
    // migrates to a nonce-based CSP. connect-src covers the Railway API + socket.io.
    const isDev = process.env.NODE_ENV !== "production";
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      // Dev: the local API/socket run on plain http/ws (localhost:3000), which
      // `https: wss:` alone blocks — every API call fails CSP. Prod unchanged.
      `connect-src 'self' https: wss:${isDev ? " http://localhost:* ws://localhost:*" : ""}`,
      // PDF previews render in an <iframe> from a blob: URL (invoice scanning,
      // the invoice builder) or from a signed API/storage URL (customer
      // documents). Without an explicit frame-src these fall back to
      // default-src 'self' and render blank — images were unaffected because
      // img-src already allows blob:, which is why PNGs previewed but PDFs did
      // not. `data:` is deliberately excluded: data: URIs in frames are an XSS
      // vector, and nothing here needs them.
      "frame-src 'self' blob: https:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

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
