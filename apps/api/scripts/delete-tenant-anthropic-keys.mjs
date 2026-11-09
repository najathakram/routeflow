#!/usr/bin/env node
// apps/api/scripts/delete-tenant-anthropic-keys.mjs
//
// AI limits PR-2 (owner 2026-11-05: RouteFlow's key runs every scan; a business key is no longer read, so no stored copy
// should remain). Removes the stored business Claude keys (SystemConfig `anthropic.apiKey`). Never the platform key.
//
//   node apps/api/scripts/delete-tenant-anthropic-keys.mjs            # DRY RUN (default): counts only, nothing written
//   node apps/api/scripts/delete-tenant-anthropic-keys.mjs --apply    # local database, test tenants only
//       --after-pr3                                                   # every --apply: the API no longer reads the key (PR-3 deployed)
//       [--live-tenant-override --backup-taken]                       # any other tenant or database, typed `DELETE <n> LIVE`
//       [--allow-protected <tenantId> ...]                            # a protected tenant's row, typed per tenant
//
// ONE WRITER: lib/delete-anthropic-keys-core.cjs (one transaction, an AuditLog row per delete, all or nothing; a second
// run deletes 0). Nobody runs `--apply` against production without the owner's yes for that command, after a backup and
// only once the API no longer reads the key (`--after-pr3` is the operator's attestation). A dry run opens a read-only
// database session. Output is counts only: never a value, slug, name or tenant id.

import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import pg from "pg";
import { redactUrl, resolveDatabaseUrl, scrubSecrets } from "./lib/railway-db-url.mjs";
import {
  applyGate,
  deleteAll,
  keyRefs,
  liveTenantCount,
  parseAllowProtected,
  planDeletes,
  poolConfig,
  runOrderGate,
} from "./lib/delete-anthropic-keys-core.cjs";

const SCRIPT = "delete-tenant-anthropic-keys";
const requireCjs = createRequire(import.meta.url);

// One reader for every typed answer (the run order phrase, then each protected tenant's): lines that arrive together are queued.
const typed = [];
const waiting = [];
let rl;
const askOnTty = (prompt) => {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on("line", (line) => (waiting.length > 0 ? waiting.shift()(line) : typed.push(line)));
    rl.on("close", () => waiting.splice(0).forEach((resolve) => resolve("")));
  }
  process.stdout.write(prompt);
  return typed.length > 0
    ? Promise.resolve(typed.shift())
    : new Promise((resolve) => waiting.push(resolve));
};

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const liveOverride = argv.includes("--live-tenant-override");
  let allowIds;
  let url;
  try {
    allowIds = parseAllowProtected(argv);
    url = resolveDatabaseUrl(process.env);
  } catch (err) {
    console.error(`${SCRIPT}: ${err.message}`);
    process.exit(1);
  }
  console.error(`${SCRIPT}: target ${redactUrl(url)} (${apply ? "APPLY" : "dry run"})`);
  // The API reads and writes the business key until PR-3 is deployed: a delete before then is undone by the next save.
  const order = runOrderGate({ apply, afterPr3: argv.includes("--after-pr3") });
  if (!order.ok) {
    console.error(`${SCRIPT}: ${order.reason}`);
    process.exit(1);
  }
  const { classifyDbTarget } = requireCjs("./lib/production-guard.js");
  const { loadProtectedSlugs } = requireCjs("./lib/protected-slugs.cjs");
  const { protectedTenantIds, confirmProtectedOverride } = requireCjs(
    "./lib/live-target-guard.cjs",
  );
  const pool = new pg.Pool(poolConfig(url, apply));
  try {
    const refs = await keyRefs(pool);
    // A tunnel to production looks local: the host counts as local only when every tenant in it is a test tenant.
    const hostLocal = classifyDbTarget(url, process.env).ok;
    const liveTenants = hostLocal ? await liveTenantCount(pool) : 0;
    const local = hostLocal && liveTenants === 0;
    if (hostLocal && !local)
      console.error(
        `${SCRIPT}: local host, but ${liveTenants} non-test tenant(s): treated as live`,
      );
    const slugs = loadProtectedSlugs(process.env, url);
    const protectedIds = new Set(await protectedTenantIds(pool, slugs));
    const unknown = allowIds.filter((id) => !protectedIds.has(id));
    if (unknown.length > 0) {
      console.error(
        `${SCRIPT}: --allow-protected names ${unknown.length} tenant(s) that are not protected: refused`,
      );
      process.exitCode = 1;
      return;
    }
    const { write, skipped } = planDeletes({
      refs,
      protectedIds,
      allowProtected: new Set(allowIds),
      liveOverride,
    });
    const heldCount = new Set(
      refs.filter((r) => protectedIds.has(r.tenantId)).map((r) => r.tenantId),
    ).size;
    console.log(
      `${SCRIPT}: ${refs.length} business key row(s) found (test tenants ${refs.filter((r) => r.isTest).length}` +
        ` · other ${refs.filter((r) => !r.isTest).length}); would delete ${write.length}` +
        ` · skipped protected ${skipped.protected} · skipped non-test ${skipped.nonTest}`,
    );
    if (heldCount > 0) console.log(`${SCRIPT}: protected tenant(s) with a key row: ${heldCount}`);
    if (!apply) return console.log(`${SCRIPT}: DRY RUN, nothing written`);
    const gate = applyGate({
      apply,
      local,
      liveOverride,
      backupTaken: argv.includes("--backup-taken"),
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      rows: write.length,
      nonTestRows: write.filter((r) => !r.isTest).length,
    });
    if (!gate.ok) {
      console.error(`${SCRIPT}: ${gate.reason}`);
      process.exitCode = 1;
      return;
    }
    if (
      gate.phrase &&
      (await askOnTty(`Type exactly "${gate.phrase}" to continue: `)).trim() !== gate.phrase
    ) {
      console.error(`${SCRIPT}: the typed confirmation did not match: nothing written`);
      process.exitCode = 1;
      return;
    }
    for (const id of allowIds)
      await confirmProtectedOverride({ tenantId: id, argv, ask: askOnTty });
    const n = await deleteAll({ client: pool, write });
    console.log(`${SCRIPT}: deleted ${n} key row(s), each with an AuditLog row`);
  } catch (err) {
    console.error(scrubSecrets(`${SCRIPT}: ${err?.message ?? err}`, url));
    process.exitCode = 1;
  } finally {
    rl?.close();
    await pool.end().catch(() => undefined);
  }
}

await main();
