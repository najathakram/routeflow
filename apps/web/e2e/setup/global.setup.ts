/**
 * global.setup.ts
 *
 * Playwright globalSetup — runs once before all tests.
 *
 * Seeds the E2E test tenant (`e2e-routeflow`) by calling the seed script
 * from apps/api/scripts/e2e-seed.js. Pass DATABASE_URL as an env var to
 * target Railway; defaults to the local dev DB.
 *
 * This makes the test suite self-contained: running `npx playwright test`
 * always has a clean, ready-to-go test tenant.
 */

import { execSync } from "child_process";
import path from "path";

export default async function globalSetup(): Promise<void> {
  // Skip seeding if explicitly disabled (e.g. you've pre-seeded manually)
  if (process.env.SKIP_E2E_SEED === "true") {
    console.log("[global setup] SKIP_E2E_SEED=true — skipping seed step.");
    return;
  }

  const seedScript = path.resolve(
    __dirname,
    "../../../../apps/api/scripts/e2e-seed.js"
  );

  const env = { ...process.env };

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
    console.error("[global setup] E2E seed failed:");
    if (e.stdout) console.error(e.stdout);
    if (e.stderr) console.error(e.stderr);
    // Don't abort the whole test run — the tenant might already exist
    // or this might be a local env without DB access.
    console.warn("[global setup] Continuing despite seed error...");
  }
}
