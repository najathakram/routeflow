#!/usr/bin/env node
/**
 * #2338 (T0.10): ONE command per role for the native-parity proof (plan R6):
 *
 *   npm run parity:capture -- --role buyer                  # web captures + index
 *   npm run parity:capture -- --role buyer --native loaded  # + iPhone and iPad captures of that state
 *        [--link-base exp://127.0.0.1:8081/--] [--base-url http://localhost:3001]
 *
 * Prerequisites (local only, test tenants only):
 *   npm run local:up && npm run local:seed      # the `test` tenant, incl. the parity buyers
 *   native: `expo start` on the Mac mini pointed at the local API, the app open in Expo Go on both
 *   simulators and signed in as that state's buyer (the dev-only parity login).
 *
 * Output: local-assets/proofs/<date>/native-parity/<role>/ (gitignored) + index.html.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { REPO_ROOT, parityDate } = require("./paths.cjs");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function run(cmd, args, opts) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} exited ${r.status}`);
}

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  const role = arg("--role", "buyer");
  const baseUrl = arg("--base-url", "http://localhost:3001");
  const nativeState = arg("--native", null);
  const env = { ...process.env, PARITY_DATE: parityDate() };

  const apiOk = await reachable("http://localhost:3000/api/v1/health");
  const webOk = await reachable(baseUrl);
  if (!apiOk || !webOk) {
    throw new Error(
      `local stack not reachable (api ${apiOk ? "up" : "DOWN"}, web ${webOk ? "up" : "DOWN"} at ${baseUrl}). ` +
        "Run `npm run local:up && npm run local:seed` first.",
    );
  }

  run(
    "npx",
    [
      "playwright",
      "test",
      "-c",
      "playwright.native-parity.config.ts",
      // One capture spec per role; the parity-setup project still runs as its dependency.
      `${role}.capture.ts`,
    ],
    {
      cwd: join(REPO_ROOT, "apps", "web"),
      env: { ...env, PLAYWRIGHT_BASE_URL: baseUrl },
    },
  );

  if (nativeState) {
    const linkBase = arg("--link-base", null);
    run(
      process.execPath,
      [
        join(here, "capture-native.mjs"),
        "--role",
        role,
        "--state",
        nativeState,
        ...(linkBase ? ["--link-base", linkBase] : []),
      ],
      { env },
    );
  }

  run(process.execPath, [join(here, "build-index.mjs"), "--role", role], { env });
}

main().catch((e) => {
  console.error(`\nparity:capture failed: ${e.message ?? e}`);
  process.exit(1);
});
