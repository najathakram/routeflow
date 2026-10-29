#!/usr/bin/env node
/**
 * Self-test for the register clone and its guards (B1-b1, SPEC v3.2 "Ruling v3" / G5).
 *
 * Runs against a local bare repo (the "remote") plus clones, never the real remote or tree:
 *   - RF_REGISTRY_MODE_TEST is honoured only with BUGS_SELF_TEST=1, and always warns (MUST 2);
 *   - a clone whose origin is not the register remote is refused before anything is reset (SHOULD 7);
 *   - `registry:clone`: clone, refresh, dirty refusal.
 *
 * Run directly: `node scripts/registry-clone.self-test.mjs` (wired into `npm run verify`).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PFX, append, fixture, git } from "./lib/registry-fixture.mjs";
import * as rc from "./lib/registry-clone.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLONE_CMD = join(ROOT, "scripts", "registry-clone.mjs");
const fx = fixture("rf-regclone-");
const { tmp, bare, check, section, env } = fx;

fx.world();
const B = fx.clone("b");

await section("RF_REGISTRY_MODE_TEST needs BUGS_SELF_TEST (MUST 2)", async () => {
  const url = pathToFileURL(join(ROOT, "scripts", "lib", "registry-root.mjs")).href;
  const code = `import { registryMode } from ${JSON.stringify(url)}; console.log(registryMode());`;
  const probe = (extra) => {
    const e = { ...env(), RF_REGISTRY_DIR: join(tmp, "m"), RF_REGISTRY_MODE_TEST: "clone" };
    delete e.BUGS_SELF_TEST;
    return spawnSync("node", ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: { ...e, ...extra },
    });
  };
  for (const [extra, mode] of [
    [{}, "tracked"],
    [{ BUGS_SELF_TEST: "1" }, "clone"],
  ]) {
    const r = probe(extra);
    check(`${mode} mode, and it warns`, [r.stdout.trim(), /WARNING/.test(r.stderr)], [mode, true]);
  }
});
await section("the clone's origin must be the register remote (SHOULD 7)", async () => {
  git(tmp, "init", "--bare", "--initial-branch=main", join(tmp, "elsewhere.git"));
  const A3 = fx.clone("a3");
  git(A3, "remote", "set-url", "origin", join(tmp, "elsewhere.git"));
  const head = git(A3, "rev-parse", "HEAD");
  let err;
  try {
    rc.cloneRegistry({ cloneDir: A3 });
  } catch (e) {
    err = e;
  }
  check(
    "a foreign origin: exit 2, the clone untouched",
    [err?.exitCode, git(A3, "rev-parse", "HEAD") === head],
    [2, true],
  );
});
await section("registry:clone", async () => {
  const fresh = join(tmp, "fresh");
  const cl = () =>
    spawnSync("node", [CLONE_CMD], {
      encoding: "utf8",
      env: env({ RF_REGISTRY_DIR: fresh, RF_REGISTRY_REMOTE: bare }),
    });
  check("clones when absent", [cl().status, existsSync(join(fresh, PFX, "bugs.jsonl"))], [0, true]);
  fx.other(B, append("rows.txt", "later\n"));
  check(
    "refreshes when present (idempotent)",
    [
      cl().status,
      readFileSync(join(fresh, PFX, "rows.txt"), "utf8").includes("later"),
      cl().status,
    ],
    [0, true, 0],
  );
  appendFileSync(join(fresh, PFX, "rows.txt"), "mine\n");
  const dirty = cl();
  check(
    "dirty clone: exit 2, prints the fix, keeps the edit",
    [
      dirty.status,
      /commit-record/.test(dirty.stderr),
      readFileSync(join(fresh, PFX, "rows.txt"), "utf8").endsWith("mine\n"),
    ],
    [2, true, true],
  );
});

fx.finish("registry-clone");
