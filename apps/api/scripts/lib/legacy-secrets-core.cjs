// AI limits PR-2: the core of `encrypt-legacy-secrets.mjs`. Plaintext secret config rows are rewritten through the REAL
// EncryptionService (owner 2026-11-05: keys never stored unencrypted). plaintextRefs finds rows BY REFERENCE (no value
// read); encryptAll is the ONE writer (row per transaction, row-locked, decrypt-verified, compare-and-swap on the old
// value, idempotent); applyGate decides whether `--apply` may run; keyGate proves the key first. Never logs a value, slug or name.

"use strict";

const {
  CIPHER_SHAPE,
  PLATFORM_CONFIG_SECRET_KEYS,
  SYSTEM_CONFIG_SECRET_KEYS,
} = require("./secret-config-keys.cjs");

const { isTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

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

/** How many tenants are not approved test tenants. A host that LOOKS local (a tunnel) holding any is not local. */
async function liveTenantCount(client) {
  const { rows } = await client.query(`SELECT slug FROM "Tenant"`);
  return rows.filter((t) => !isTestTenant(t.slug)).length;
}

/** 'ok' | 'failed' | 'none': can the loaded key read a ciphertext secret that is already stored? Reads ciphertext only. */
async function keyCanary(client, cipher) {
  const sys = await client.query(
    `SELECT value FROM "SystemConfig" WHERE key = ANY($1::text[]) AND value ~ $2 LIMIT 5`,
    [SYSTEM_CONFIG_SECRET_KEYS, CIPHER_SHAPE],
  );
  const plat = await client.query(
    `SELECT value FROM "PlatformConfig" WHERE key = ANY($1::text[]) AND value ~ $2 LIMIT 5`,
    [PLATFORM_CONFIG_SECRET_KEYS, CIPHER_SHAPE],
  );
  const rows = [...sys.rows, ...plat.rows];
  if (rows.length === 0) return "none";
  for (const { value } of rows) {
    try {
      cipher.decrypt(value);
      return "ok";
    } catch {
      /* try the next row */
    }
  }
  return "failed";
}

// One row, one transaction: 'encrypted' | 'already' (not plaintext when we got the lock) | 'failed' (no round-trip, or CAS lost).
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

// A protected tenant's row is skipped (counted) unless its id is in `allowProtected`.
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
    try {
      res[await encryptRow(client, cipher, ref)] += 1;
    } catch (err) {
      err.partial = { ...res };
      throw err;
    }
  }
  for (const [name, n] of Object.entries(perKey).sort()) log(`  ${name}: ${n} plaintext row(s)`);
  return res;
}

// Pure: a dry run, nothing to encrypt, or a provably local database passes; any other needs --live-tenant-override,
// --backup-taken, a real terminal and the typed phrase `ENCRYPT <rows> LIVE`.
function applyGate({ apply, local, liveOverride, backupTaken, isTTY, rows }) {
  if (!apply || rows === 0 || local) return { ok: true, phrase: null };
  if (!liveOverride)
    return {
      ok: false,
      reason: "the database is not provably local: --apply needs --live-tenant-override",
    };
  if (!backupTaken) return { ok: false, reason: "--backup-taken is required for a live run" };
  if (!isTTY)
    return { ok: false, reason: "a live run needs a real terminal for the typed confirmation" };
  return { ok: true, phrase: `ENCRYPT ${rows} LIVE` };
}

// Pure, before any write or prompt: the API's own 64-hex key (the dev placeholder is refused), proven by reading one
// ciphertext already stored. With none stored a live target needs --first-run-key on top of the full gate.
function keyGate({ keyHex, canary, firstRun, local }) {
  if (!/^[0-9a-f]{64}$/i.test(keyHex ?? ""))
    return {
      ok: false,
      reason: "ENCRYPTION_KEY must be the API's 64-hex key (not the dev placeholder)",
    };
  if (canary === "failed")
    return {
      ok: false,
      reason: "ENCRYPTION_KEY cannot read a secret already stored: not the API's key",
    };
  if (canary === "none" && !local && !firstRun)
    return {
      ok: false,
      reason: "no stored ciphertext proves the key: a first run needs --first-run-key",
    };
  return { ok: true };
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

module.exports = {
  plaintextRefs,
  liveTenantCount,
  keyCanary,
  encryptRow,
  encryptAll,
  applyGate,
  keyGate,
  parseAllowProtected,
};
