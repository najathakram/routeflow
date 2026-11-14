// Serves the ready-made pages (public/site/<page>.html) at their own addresses. next.config.mjs
// rewrites "/", "/pricing", "/product" and the rest here, after the middleware, so the signed-in
// redirect on "/" still comes first. The route is built once: the page is the file with its brand
// tokens filled in and, when NEXT_PUBLIC_UMAMI_WEBSITE_ID is set, the visit-count tags
// (lib/read-site-page.ts, lib/static-site-page.ts). Everything else in the file is served as it is.
import { readServedSitePage } from "@/lib/read-site-page";
import { STATIC_SITE_PAGE_NAMES, type StaticSitePage } from "@/lib/static-site-page";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return STATIC_SITE_PAGE_NAMES.map((page) => ({ page }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!STATIC_SITE_PAGE_NAMES.includes(page as StaticSitePage)) {
    return new Response("Not found", { status: 404 });
  }
  const html = readServedSitePage(page as StaticSitePage);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
