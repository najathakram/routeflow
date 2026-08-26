/**
 * global.setup.ts
 *
 * Playwright globalSetup — runs once before all tests.
 *
 * Seeds the E2E test tenant (`e2e-routeflow`) by calling the seed script from
 * apps/api/scripts/e2e-seed.js against the database named by DATABASE_URL
 * (E2E_SEED_DATABASE_URL wins when both are set — that's the name the CI
 * secret uses so it can't be confused with a service's own DATABASE_URL).
 *
 * Behavior matrix (deliberately loud — a silently-skipped seed rotted the CI
 * suite for a week in 2026-08 while "Continuing despite seed error..."
 * scrolled past unread):
 *   • SKIP_E2E_SEED=true      → skip, explicitly.
 *   • a DB URL is configured  → seed; ANY failure aborts the whole run.
 *   • no DB URL + CI          → skip with a notice — CI targets the deployed
 *     app, whose standing `e2e-routeflow` tenant is assumed pre-seeded (see
 *     the E2E_SEED_DATABASE_URL secret note in .github/workflows/ci.yml).
 *   • no DB URL + local       → seed the local-dev fallback DB; failure
 *     aborts (start docker `npm run db:up`, or set SKIP_E2E_SEED=true when
 *     pointing at a remote deployment you can't reach the DB of).
 */

import { execSync } from "child_process";
import path from "path";

export default async function globalSetup(): Promise<void> {
  if (process.env.SKIP_E2E_SEED === "true") {
    console.log("[global setup] SKIP_E2E_SEED=true — skipping seed step.");
    return;
  }

  // Empty string counts as unset: `DATABASE_URL: ${{ secrets.X }}` in a
  // workflow yields "" when the secret does not exist.
  const configuredDbUrl =
    [process.env.E2E_SEED_DATABASE_URL, process.env.DATABASE_URL].find(
      (v) => v && v.trim() !== "",
    ) ?? null;

  if (!configuredDbUrl && process.env.CI === "true") {
    console.log(
      "[global setup] No E2E_SEED_DATABASE_URL/DATABASE_URL in CI — skipping the seed.\n" +
        "  The suite runs against the deployed app's standing `e2e-routeflow` tenant.\n" +
        "  Add the E2E_SEED_DATABASE_URL repo secret to (re-)seed it on every run.",
    );
    return;
  }

  const seedScript = path.resolve(__dirname, "../../../../apps/api/scripts/e2e-seed.js");
  const env = { ...process.env };
  if (configuredDbUrl) env.DATABASE_URL = configuredDbUrl;

  console.log("[global setup] Running E2E seed...");
  try {
    const output = execSync(`node "${seedScript}"`, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Print each line with a prefix so it's easy to spot in CI logs
    output
      .trim()
      .split("\n")
      .forEach((line) => console.log(`  ${line}`));
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    console.error("[global setup] E2E seed FAILED:");
    if (e.stdout) console.error(e.stdout);
    if (e.stderr) console.error(e.stderr);
    // Fail the run — fixture-dependent specs would fail anyway, just less
    // legibly. Pre-seeded environments should say so via SKIP_E2E_SEED=true.
    throw new Error(
      "E2E seed failed (see output above). Fix the DB connection, or set " +
        "SKIP_E2E_SEED=true if the target tenant is already seeded.",
    );
  }
}
