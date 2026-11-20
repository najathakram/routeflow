import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContentSecurityPolicy } from "./csp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The ready-made pages (public/site/<page>.html) and the address each is served at: the one list the
// rewrites and the raw-path redirects below read. lib/static-site-page.ts keeps the same list for
// the route (static-site.test.ts pins that the two agree).
export const SITE_PAGES = {
  home: "/",
  pricing: "/pricing",
  product: "/product",
  landing: "/landing",
  "getting-started": "/getting-started",
  "does-and-doesnt": "/does-and-doesnt",
  "data-in-and-out": "/data-in-and-out",
  security: "/security",
  company: "/company",
  contact: "/contact",
};

// A page that carries {{brand:key}} tokens is complete only after app/site-page has filled them, so
// its raw file address must not serve it: it redirects to the clean address (307, like the other
// temporary redirects here). site-raw-path-redirect.static.test.ts fails when a page gains tokens
// without being listed, which is derived here from the file itself.
const tokenisedPages = Object.keys(SITE_PAGES).filter((page) =>
  /\{\{brand:/i.test(readFileSync(path.join(__dirname, "public", "site", `${page}.html`), "utf8")),
);

// The two addresses of the site, read from the brand seam (packages/types/brand/brand.json), the one
// place a host is typed. This file cannot import TypeScript, so it reads the JSON itself.
export function readSiteHosts() {
  const brand = JSON.parse(
    readFileSync(
      path.join(__dirname, "..", "..", "packages", "types", "brand", "brand.json"),
      "utf8",
    ),
  );
  return { origin: brand.origin, oldOrigin: brand.oldOrigin };
}

// The installed phone app's web view only allows the old host; it must never be sent to another one.
// Its user-agent token is the shell marker (packages/ui shell-bridge.ts SHELL_UA_PRODUCT). Next
// anchors a header value as a whole-string pattern, hence the dots.
const SHELL_USER_AGENT = ".*RouteFlowShell.*";

// A signed-in visitor's presence cookies (lib/presence-cookies.ts OP_PRESENCE_COOKIE and
// BUYER_PRESENCE_COOKIE; this file cannot import TypeScript, so the test pins these two names to
// the imported constants). A visitor who has one stays on the old host, where the middleware reads
// it and sends them into the app. One list for every host rule.
const PRESENCE_COOKIES = ["rf-op-auth", "rf-buyer-auth"];

/** The `missing` list every host rule carries: not the phone shell, not signed in. */
function hostRuleMissing() {
  return [
    { type: "header", key: "user-agent", value: SHELL_USER_AGENT },
    ...PRESENCE_COOKIES.map((key) => ({ type: "cookie", key })),
  ];
}

// Public addresses: the ready-made pages plus the two React pages (privacy, terms). Sign-in, sign-up
// and the reset pages are not here on purpose: they keep working on the old host.
const PUBLIC_PATHS = [...Object.values(SITE_PAGES), "/privacy", "/terms"];

/**
 * Temporary redirects from the old host to the same address on the new one, for the public addresses
 * only, never for the shell. They exist only while the two hosts differ; with one host a rule would
 * redirect to itself and loop. A legacy alias that ends on a public page gets its own rule to the
 * final page on the new host (one hop), placed before the same-host alias.
 * @param {{ origin: string, oldOrigin: string }} hosts
 * @param {Array<{ source: string, destination: string }>} aliases
 */
export function buildSiteHostRedirects({ origin, oldOrigin }, aliases) {
  const to = new URL(origin);
  const from = new URL(oldOrigin);
  if (to.host === from.host) return [];
  const rule = (source, destPath) => ({
    source,
    has: [{ type: "host", value: from.hostname.replace(/\./g, "\\.") }],
    missing: hostRuleMissing(),
    destination: `${to.origin}${destPath === "/" ? "" : destPath}`,
    permanent: false,
  });
  const publicPaths = new Set(PUBLIC_PATHS);
  return [
    ...PUBLIC_PATHS.map((source) => rule(source, source)),
    ...aliases
      .filter((alias) => publicPaths.has(alias.destination.replace(/#.*$/, "")))
      .map((alias) => rule(alias.source, alias.destination)),
  ];
}

// The old marketing site's pages and addresses a visitor might guess, sent to the closest page of
// the new site (owner order, "no old look left anywhere"). The first eight are permanent, so search
// engines move the old addresses across; the last four stay temporary. A next.config redirect is
// evaluated before middleware and always carries its Location header (a prerendered redirect() page
// served from the ISR cache lost it; spec 36). /distributors, /demo and /about were guessed
// addresses that pointed at these pages: they go straight to the end of the chain. /faq,
// /integrations and /quickbooks open the FAQ section on the home page (id="faq").
const LEGACY_ALIASES = [
  { source: "/wholesalers", destination: "/product", permanent: true },
  { source: "/distributors", destination: "/product", permanent: true },
  { source: "/retailers", destination: "/#stores", permanent: true },
  { source: "/buyer", destination: "/#stores", permanent: true },
  { source: "/book-a-demo", destination: "/contact", permanent: true },
  { source: "/demo", destination: "/contact", permanent: true },
  { source: "/sign-in", destination: "/login", permanent: true },
  { source: "/about", destination: "/company", permanent: true },
  { source: "/features", destination: "/product", permanent: false },
  { source: "/faq", destination: "/#faq", permanent: false },
  { source: "/integrations", destination: "/#faq", permanent: false },
  { source: "/quickbooks", destination: "/#faq", permanent: false },
];

// Every page's raw file address, which on the old host goes straight to the new host's page too.
const RAW_PAGE_ALIASES = Object.entries(SITE_PAGES).map(([page, destination]) => ({
  source: `/site/${page}.html`,
  destination,
}));

/** The whole redirect list for a pair of hosts (redirects() reads them from the brand seam). */
export function buildRedirects(hosts) {
  return [
    ...buildSiteHostRedirects(hosts, [...LEGACY_ALIASES, ...RAW_PAGE_ALIASES]),
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
    // SA-1146 B-1 (B446): Checkout used to return to these two addresses, which are not pages. A link already
    // out (a Stripe session lives 23 h) lands on Billing with the return notice. Temporary on purpose; remove
    // both 7 days after deploy (register row). Pinned by lib/billing-return-redirects.static.test.ts.
    {
      source: "/billing/success",
      destination: "/settings/billing?checkout=success",
      permanent: false,
    },
    {
      source: "/billing/cancel",
      destination: "/settings/billing?checkout=cancelled",
      permanent: false,
    },
    ...LEGACY_ALIASES,
    // The raw file address of a tokenised page (see tokenisedPages).
    ...tokenisedPages.map((page) => ({
      source: `/site/${page}.html`,
      destination: SITE_PAGES[page],
      permanent: false,
    })),
  ];
}

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
  transpilePackages: ["@routeflow/ui", "@routeflow/types", "@routeflow/scanning"],

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
    return buildRedirects(readSiteHosts());
  },

  // The home, pricing, product, landing, company, contact and four deep pages (getting-started,
  // does-and-doesnt, data-in-and-out, security) are ready-made HTML under public/site (page,
  // styles, scripts, font and marks together). A beforeFiles rewrite serves each at its own
  // address after the middleware has run. The route behind it (app/site-page) is the file plus the
  // first-touch tag on every page and, when the build has a site ID, the visit-count tags.
  async rewrites() {
    return {
      beforeFiles: Object.entries(SITE_PAGES).map(([page, source]) => ({
        source,
        destination: `/site-page/${page}`,
      })),
    };
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
          // Site audit 2026-11-02 §7: www answered with no HSTS, so a first visit over http
          // was never pinned to https. One year, this host only: no includeSubDomains
          // (the API and other hosts are not ours to pin from here) and no preload
          // (a list entry outlives any later change of mind).
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
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
      // A6: the marketing site's static, signed-out pages were shipping only
      // `s-maxage` (App Router's own ISR default) with no plain `max-age`, so
      // a shared/CDN cache could reuse the response but a visitor's own
      // browser had nothing telling it to — every in-session navigation
      // between marketing pages re-fetched the HTML. `stale-while-revalidate`
      // matches the App Router's own 300s ISR window (`x-nextjs-stale-time`),
      // so a background revalidation never blocks a repeat visit. Listed
      // explicitly, one path per route — NEVER widen this to a wildcard: every
      // other route in this app is either authenticated or reads
      // tenant/session state (buyer portal, dashboard, admin, auth), and a
      // shared Cache-Control there would leak one visitor's response to the
      // next behind the same CDN edge.
      {
        source: "/",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400",
          },
        ],
      },
      {
        source:
          "/:path(product|pricing|landing|company|contact|privacy|terms|getting-started|does-and-doesnt|data-in-and-out|security)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400",
          },
        ],
      },
      // The files and the route behind those pages. Asked for by their own name they would repeat
      // the page at a second address, so search engines are told to leave them out; the pages
      // carry their own canonical link.
      {
        source:
          "/site/:page(home|pricing|product|landing|company|contact|getting-started|does-and-doesnt|data-in-and-out|security).html",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
      {
        source:
          "/site-page/:page(home|pricing|product|landing|company|contact|getting-started|does-and-doesnt|data-in-and-out|security)",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
    ];
  },
};

export default nextConfig;
