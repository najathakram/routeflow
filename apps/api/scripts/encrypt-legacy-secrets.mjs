#!/usr/bin/env node
// apps/api/scripts/encrypt-legacy-secrets.mjs
//
// AI limits PR-2 (owner 2026-11-05: keys are never stored unencrypted). Secret config rows written before encryption
// are plaintext (the read path passes them through); this rewrites each through the compiled EncryptionService.
//
//   node apps/api/scripts/encrypt-legacy-secrets.mjs            # DRY RUN (default): counts per key, no value read
//   node apps/api/scripts/encrypt-legacy-secrets.mjs --apply    # local database only
//       [--live-tenant-override --backup-taken]                 # any other: typed `ENCRYPT <n> LIVE`
//       [--allow-protected <tenantId> ...]                      # a protected tenant's rows, typed per tenant
//
// ONE WRITER: lib/legacy-secrets-core.cjs. Needs `npm run build -w apps/api` and the API's ENCRYPTION_KEY. Nobody runs
// `--apply` on production without the owner's yes for that command and a backup. Rows of a protected tenant are
// skipped and counted (row 195); output is keys, counts and tenant ids only, never a value, slug or name.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { redactUrl, resolveDatabaseUrl, scrubSecrets } from "./lib/railway-db-url.mjs";
import {
  applyGate,
  encryptAll,
  parseAllowProtected,
  plaintextRefs,
} from "./lib/legacy-secrets-core.cjs";

const SCRIPT = "encrypt-legacy-secrets";
const requireCjs = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function askOnTty(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, (a) => {
      rl.close();
      resolve(a);
    }),
  );
}

/** The compiled EncryptionService, built with the same ENCRYPTION_KEY the API reads. */
function loadCipher() {
  let mod;
  try {
    mod = requireCjs(join(here, "..", "dist", "common", "encryption.service.js"));
  } catch (e) {
    throw new Error(
      `${SCRIPT}: cannot load apps/api/dist/common/encryption.service.js. Run ` +
        `\`npm run build -w apps/api\` first (${e.message})`,
    );
  }
  return new mod.EncryptionService({
    get: (k) => (k === "nodeEnv" ? process.env.NODE_ENV : process.env[k]),
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
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
  const { classifyDbTarget } = requireCjs("./lib/production-guard.js");
  const { loadProtectedSlugs } = requireCjs("./lib/protected-slugs.cjs");
  const { protectedTenantIds, confirmProtectedOverride } = requireCjs(
    "./lib/live-target-guard.cjs",
  );
  const local = classifyDbTarget(url, process.env).ok;
  const pool = new pg.Pool({ connectionString: url });
  try {
    const slugs = loadProtectedSlugs(process.env, url);
    const refs = await plaintextRefs(pool);
    const protectedIds = new Set(await protectedTenantIds(pool, slugs));
    const heldBack = [
      ...new Set(refs.filter((r) => protectedIds.has(r.tenantId)).map((r) => r.tenantId)),
    ];
    const unknown = allowIds.filter((id) => !protectedIds.has(id));
    if (unknown.length > 0) {
      console.error(
        `${SCRIPT}: --allow-protected names ${unknown.length} tenant(s) that are not protected: refused`,
      );
      process.exitCode = 1;
      return;
    }
    const allowProtected = new Set();
    const writable = refs.filter(
      (r) => !protectedIds.has(r.tenantId) || allowIds.includes(r.tenantId),
    ).length;
    if (apply) {
      const gate = applyGate({
        apply,
        local,
        liveOverride: argv.includes("--live-tenant-override"),
        backupTaken: argv.includes("--backup-taken"),
        isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        rows: writable,
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
      for (const id of allowIds) {
        await confirmProtectedOverride({ tenantId: id, argv });
        allowProtected.add(id);
      }
    }
    console.log(
      `${SCRIPT}: ${refs.length} plaintext secret row(s) found${apply ? "" : " (DRY RUN, nothing written)"}`,
    );
    const cipher = apply && writable > 0 ? loadCipher() : null;
    if (cipher && !local && !/^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY ?? "")) {
      console.error(
        `${SCRIPT}: ENCRYPTION_KEY must be the API's 64-hex key for a live run: nothing written`,
      );
      process.exitCode = 1;
      return;
    }
    const res = await encryptAll({
      client: pool,
      cipher,
      refs,
      apply,
      protectedIds,
      allowProtected,
    });
    console.log(
      apply
        ? `${SCRIPT}: encrypted ${res.encrypted} · already ${res.already} · failed ${res.failed} · skipped protected ${res.skippedProtected}`
        : `${SCRIPT}: would encrypt ${res.wouldEncrypt} · skipped protected ${res.skippedProtected}`,
    );
    if (heldBack.length > 0)
      console.log(`${SCRIPT}: protected tenant id(s) with plaintext rows: ${heldBack.join(", ")}`);
    if (res.failed > 0) process.exitCode = 1;
  } catch (err) {
    console.error(scrubSecrets(`${SCRIPT}: ${err?.message ?? err}`, url));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
