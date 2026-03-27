/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained Node.js server for Docker deployment
  output: "standalone",

  // Transpile monorepo packages so Next.js can compile their TypeScript/JSX
  transpilePackages: ["@routeflow/ui", "@routeflow/types"],

  // Skip ESLint during production builds — ESLint runs separately in CI.
  // Without this, missing plugin configs from the monorepo lockfile cause
  // the Docker build to fail with "Definition for rule not found" errors.
  eslint: {
    ignoreDuringBuilds: true,
  },

  experimental: {
    // Prevent Next.js from bundling server-only packages into the client
    serverComponentsExternalPackages: [],
  },
};

export default nextConfig;
