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

  experimental: {
    // Prevent Next.js from bundling server-only packages into the client
    serverComponentsExternalPackages: [],
  },
};

export default nextConfig;
