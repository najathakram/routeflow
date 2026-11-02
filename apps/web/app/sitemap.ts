import type { MetadataRoute } from "next";
import { STATIC_SITE_PAGES } from "@/lib/static-site-page";
import { routes, site, SITEMAP_EXCLUDED_SLUGS } from "./(marketing)/lib/site";

// The public marketing URLs (spec.md R10, R-MKT T9): home, the routes[] table, and the demo
// booking page (W8), which is a page of its own and not a nav route. Anything in
// SITEMAP_EXCLUDED_SLUGS is left out. The ready-made pages that are not in `routes` (the four deep
// pages) are listed from STATIC_SITE_PAGES; / and /landing (an ad page, not for search) are not added.
export default function sitemap(): MetadataRoute.Sitemap {
  const excluded: readonly string[] = SITEMAP_EXCLUDED_SLUGS;
  const publicRoutes = routes.filter((route) => !excluded.includes(route.slug));

  const listed = new Set(["/", "/landing", ...routes.map((route) => `/${route.slug}`)]);
  const staticPages = Object.values(STATIC_SITE_PAGES).filter((path) => !listed.has(path));

  return [
    { url: site.origin + "/" },
    ...publicRoutes.map((route) => ({ url: `${site.origin}/${route.slug}` })),
    ...staticPages.map((path) => ({ url: site.origin + path })),
    { url: `${site.origin}/book-a-demo` },
  ];
}
