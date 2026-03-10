/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile monorepo packages so Next.js can compile their TypeScript/JSX
  transpilePackages: ["@routeflow/ui", "@routeflow/types"],

  experimental: {
    // Prevent Next.js from bundling server-only packages into the client
    serverComponentsExternalPackages: [],
  },
};

export default nextConfig;
