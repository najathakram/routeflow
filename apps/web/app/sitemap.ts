import type { MetadataRoute } from "next";
import { routes, site, SITEMAP_EXCLUDED_SLUGS } from "./(marketing)/lib/site";

// The public marketing URLs (spec.md R10, R-MKT T9): home, the routes[] table, and the demo
// booking page (W8), which is a page of its own and not a nav route. Anything in
// SITEMAP_EXCLUDED_SLUGS is left out.
export default function sitemap(): MetadataRoute.Sitemap {
  const excluded: readonly string[] = SITEMAP_EXCLUDED_SLUGS;
  const publicRoutes = routes.filter((route) => !excluded.includes(route.slug));

  return [
    { url: site.origin + "/" },
    ...publicRoutes.map((route) => ({ url: `${site.origin}/${route.slug}` })),
    { url: `${site.origin}/book-a-demo` },
  ];
}
