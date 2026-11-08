// AI limits PR-2 (SA-1102 §4): the core of `encrypt-legacy-secrets.mjs`. Secret config rows written before encryption
// are plaintext (the read path passes them through); this rewrites each one through the REAL EncryptionService, so
// "keys are never stored unencrypted" (owner 2026-11-05) holds for old rows too.
//
//   plaintextRefs(client)        rows to fix, BY REFERENCE (table, id, tenantId, key): no value is read to find them
//   encryptAll({ ... })          the ONE writer: one row per transaction, row-locked, decrypt-verified before the
//                                UPDATE, compare-and-swap on the old value; idempotent (a second run finds nothing)
//   applyGate({ ... })           the one decision whether `--apply` may run, and the phrase to type
//   parseAllowProtected(argv)    every `--allow-protected <tenantId>`
//
// Never logs a secret value, a slug or a tenant name; counts and (for protected tenants) ids only. `client` is a pg
// Pool; `cipher` is an EncryptionService (or a stub with encrypt/decrypt).

"use strict";

const {
  CIPHER_SHAPE,
  PLATFORM_CONFIG_SECRET_KEYS,
  SYSTEM_CONFIG_SECRET_KEYS,
} = require("./secret-config-keys.cjs");

const SHAPE = new RegExp(CIPHER_SHAPE);

/** The rows still plaintext: non-empty, a secret key, not the cipher shape. Selected WITHOUT their value. */
async function plaintextRefs(client) {
  const sys = await client.query(
    `SELECT id, "tenantId", key FROM "SystemConfig"
     WHERE key = ANY($1::text[]) AND value <> '' AND value !~ $2 ORDER BY id`,
    [SYSTEM_CONFIG_SECRET_KEYS, CIPHER_SHAPE],
  );
  const plat = await client.query(
    `SELECT id, key FROM "PlatformConfig"
     WHERE key = ANY($1::text[]) AND value <> '' AND value !~ $2 ORDER BY id`,
    [PLATFORM_CONFIG_SECRET_KEYS, CIPHER_SHAPE],
  );
  return [
    ...sys.rows.map((r) => ({ table: "SystemConfig", id: r.id, tenantId: r.tenantId, key: r.key })),
    ...plat.rows.map((r) => ({ table: "PlatformConfig", id: r.id, tenantId: null, key: r.key })),
  ];
}

/**
 * One row, one transaction. 'encrypted' | 'already' (no longer plaintext when we got the lock) | 'failed' (the
 * cipher would not round-trip, or the compare-and-swap lost: the row is left as it was).
 */
async function encryptRow(client, cipher, ref) {
  const tx = await client.connect();
  try {
    await tx.query("BEGIN");
    const cur = await tx.query(`SELECT value FROM "${ref.table}" WHERE id = $1 FOR UPDATE`, [
      ref.id,
    ]);
    const old = cur.rows[0]?.value;
    if (!old || SHAPE.test(old)) {
      await tx.query("ROLLBACK");
      return "already";
    }
    const enc = cipher.encrypt(old);
    if (!SHAPE.test(enc) || cipher.decrypt(enc) !== old) {
      await tx.query("ROLLBACK");
      return "failed";
    }
    const upd = await tx.query(
      `UPDATE "${ref.table}" SET value = $1, "updatedAt" = now() WHERE id = $2 AND value = $3`,
      [enc, ref.id, old],
    );
    if (upd.rowCount !== 1) {
      await tx.query("ROLLBACK");
      return "failed";
    }
    await tx.query("COMMIT");
    return "encrypted";
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    tx.release();
  }
}

/**
 * @param {{ client, cipher, refs: Array, apply: boolean, protectedIds?: Set<string>, allowProtected?: Set<string>, log?: (s: string) => void }} o
 * A row of a protected tenant is skipped (counted) unless that tenant's id is in `allowProtected`.
 */
async function encryptAll({
  client,
  cipher,
  refs,
  apply,
  protectedIds = new Set(),
  allowProtected = new Set(),
  log = console.log,
}) {
  const res = { wouldEncrypt: 0, encrypted: 0, already: 0, failed: 0, skippedProtected: 0 };
  const perKey = {};
  for (const ref of refs) {
    const name = `${ref.table}:${ref.key}`;
    perKey[name] = (perKey[name] ?? 0) + 1;
    if (ref.tenantId && protectedIds.has(ref.tenantId) && !allowProtected.has(ref.tenantId)) {
      res.skippedProtected += 1;
      continue;
    }
    if (!apply) {
      res.wouldEncrypt += 1;
      continue;
    }
    res[await encryptRow(client, cipher, ref)] += 1;
  }
  for (const [name, n] of Object.entries(perKey).sort()) log(`  ${name}: ${n} plaintext row(s)`);
  return res;
}

/**
 * Pure: may `--apply` run, and what must be typed. A dry run, or nothing to encrypt, always passes. A provably local
 * database needs nothing more. Any other database needs `--live-target-override`, `--backup-taken` and a real terminal
 * for the typed phrase `ENCRYPT <rows> LIVE`.
 */
function applyGate({ apply, local, liveOverride, backupTaken, isTTY, rows }) {
  if (!apply || rows === 0 || local) return { ok: true, phrase: null };
  if (!liveOverride)
    return {
      ok: false,
      reason: "the database is not provably local: --apply needs --live-target-override",
    };
  if (!backupTaken) return { ok: false, reason: "--backup-taken is required for a live run" };
  if (!isTTY)
    return { ok: false, reason: "a live run needs a real terminal for the typed confirmation" };
  return { ok: true, phrase: `ENCRYPT ${rows} LIVE` };
}

/** Every `--allow-protected <tenantId>`; a flag with no id is an error. */
function parseAllowProtected(argv) {
  const ids = [];
  argv.forEach((a, i) => {
    if (a !== "--allow-protected") return;
    const id = argv[i + 1];
    if (!id || id.startsWith("--")) throw new Error("--allow-protected needs a tenant id");
    ids.push(id);
  });
  return ids;
}

module.exports = { plaintextRefs, encryptRow, encryptAll, applyGate, parseAllowProtected };
