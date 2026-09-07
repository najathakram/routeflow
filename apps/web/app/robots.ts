import type { MetadataRoute } from "next";
import { site } from "./(marketing)/lib/site";

// Production SEO stance: allow everything, point at the sitemap
// (spec.md R10, R-MKT T9).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${site.origin}/sitemap.xml`,
  };
}
