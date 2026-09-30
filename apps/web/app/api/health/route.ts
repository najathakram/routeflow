import { NextResponse } from "next/server";

/**
 * Deploy-readiness probe. Exists so CI can tell "the web app is broken" apart
 * from "the web app is one commit behind" — the whole point of the gate in
 * .github/workflows/ci.yml, which had been polling the API's /health (a
 * different service) and calling that a web deploy check.
 *
 * `RAILWAY_GIT_COMMIT_SHA` is injected by Railway into the RUNNING container of
 * a GitHub-connected service. Verified 2026-08-29 against the live web service:
 *
 *   railway ssh --service @routeflow/web 'printf "%s" "$RAILWAY_GIT_COMMIT_SHA"'
 *   → 5603ee632ff2d9b2addb1f2f8d6fe7135e348f7f   (== master HEAD at the time)
 *
 * Note it does NOT appear in `railway variables --service @routeflow/web`, which
 * lists only service-scoped vars — absence there is not absence at runtime.
 * Nothing has to be baked at build time, so neither the Dockerfile nor
 * next.config.mjs needs to change.
 *
 * force-dynamic is load-bearing: a statically prerendered copy would freeze
 * whatever the BUILD saw and Railway's edge would keep serving it, which is
 * precisely the staleness this endpoint is here to detect.
 *
 * Deliberately minimal payload — no commit message, no deployment id. The repo
 * is private; a bare SHA plus branch name is all the gate needs.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      branch: process.env.RAILWAY_GIT_BRANCH ?? null,
      timestamp: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
