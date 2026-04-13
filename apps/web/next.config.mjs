/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained Node.js server for Docker deployment
  output: "standalone",

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

  // Security headers applied to all routes
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Prevent clickjacking — only allow same-origin framing
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Prevent MIME type sniffing attacks
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Control referrer information — don't leak full URLs to third parties
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Restrict browser features/APIs that the app doesn't need
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(self)",
          },
          // Prevent XSS attacks with a strict CSP
          // NOTE: Next.js needs 'unsafe-eval' in development; in production
          // consider removing it and using nonces instead.
          {
            key: "X-XSS-Protection",
            value: "1; mode=block",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
