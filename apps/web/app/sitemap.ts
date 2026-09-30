import type { MetadataRoute } from "next";
import { routes, site, SITEMAP_EXCLUDED_SLUGS } from "./(marketing)/lib/site";

// The 7 public marketing URLs (spec.md R10, R-MKT T9). Legal shells
// (`/privacy`, `/terms`) are excluded per SITEMAP_EXCLUDED_SLUGS.
export default function sitemap(): MetadataRoute.Sitemap {
  const excluded: readonly string[] = SITEMAP_EXCLUDED_SLUGS;
  const publicRoutes = routes.filter((route) => !excluded.includes(route.slug));

  return [
    { url: site.origin + "/" },
    ...publicRoutes.map((route) => ({ url: `${site.origin}/${route.slug}` })),
  ];
}
