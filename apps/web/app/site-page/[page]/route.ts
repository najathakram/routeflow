// Serves the ready-made pages (public/site/<page>.html) at their
// own addresses. next.config.mjs rewrites "/", "/pricing", "/product" and "/landing" here, after the
// middleware, so the signed-in redirect on "/" still comes first. The route is built once: the page
// is the file plus, when NEXT_PUBLIC_UMAMI_WEBSITE_ID is set, the visit-count tags (see
// lib/static-site-page.ts). Everything else in the file is served as it is.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STATIC_SITE_PAGE_NAMES,
  withVisitCount,
  type StaticSitePage,
} from "@/lib/static-site-page";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return STATIC_SITE_PAGE_NAMES.map((page) => ({ page }));
}

// `next build` runs in apps/web; a root-level run (a script, a test) finds it one level down.
function readPage(page: StaticSitePage): string {
  for (const base of [process.cwd(), join(process.cwd(), "apps", "web")]) {
    try {
      return readFileSync(join(base, "public", "site", `${page}.html`), "utf8");
    } catch {
      // try the next place
    }
  }
  throw new Error(`public/site/${page}.html not found from ${process.cwd()}`);
}

export async function GET(_request: Request, { params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!STATIC_SITE_PAGE_NAMES.includes(page as StaticSitePage)) {
    return new Response("Not found", { status: 404 });
  }
  // Written out in full so Next inlines it at build time, as in UmamiScript.
  const html = withVisitCount(
    readPage(page as StaticSitePage),
    page as StaticSitePage,
    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID,
  );
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
