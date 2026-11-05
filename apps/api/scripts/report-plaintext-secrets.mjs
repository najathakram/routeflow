#!/usr/bin/env node
/**
 * READ-ONLY report (SA-1102 2.5): secret config rows still stored as PLAINTEXT.
 *
 * Counts SystemConfig rows whose key is a SystemConfigService secret, and PlatformConfig rows whose key is a
 * PlatformConfigService secret, whose value is non-empty and does not have the AES-256-GCM cipher shape
 * (IV_HEX:TAG_HEX:CIPHERTEXT_B64). The classification runs in the database, so no secret value is read into this
 * process. Output is KEYS AND COUNTS ONLY: never a value, never a tenant id or name. It makes no writes.
 *
 * Exit code: always 0 when it ran (it is a warning in `local:validate`, not a gate); 1 only if the arguments are bad.
 * A database it cannot reach is reported as a WARNING line, exit 0.
 *
 * The two key lists below mirror SECRET_KEYS (system-config.service.ts) and PLATFORM_SECRET_KEYS
 * (platform-config.service.ts); secret-keys.pin.spec.ts fails if they drift apart.
 *
 * Local compose DB:   npm run local:plaintext-secrets
 * Prod (per-call owner yes only):   railway run --service postgres node apps/api/scripts/report-plaintext-secrets.mjs
 */
import pg from "pg";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const SYSTEM_CONFIG_SECRET_KEYS = [
  "email.smtpPassword",
  "anthropic.apiKey",
  "zoho.clientSecret",
  "zoho.refreshToken",
];
const PLATFORM_CONFIG_SECRET_KEYS = ["claude.apiKey"];
// Same pattern as ENCRYPTED_FORMAT in apps/api/src/common/secret-at-rest.ts (POSIX-compatible).
const CIPHER_SHAPE = "^[0-9a-f]{32}:[0-9a-f]{32}:[A-Za-z0-9+/=]+$";

export async function countPlaintext(client) {
  const q = (table, keys) =>
    client.query(
      `SELECT "key", COUNT(*)::int AS n FROM "${table}"
       WHERE "key" = ANY($1::text[]) AND "value" <> '' AND "value" !~ $2
       GROUP BY "key" ORDER BY "key"`,
      [keys, CIPHER_SHAPE],
    );
  const [sys, plat] = [
    await q("SystemConfig", SYSTEM_CONFIG_SECRET_KEYS),
    await q("PlatformConfig", PLATFORM_CONFIG_SECRET_KEYS),
  ];
  const toMap = (res) => Object.fromEntries(res.rows.map((r) => [r.key, Number(r.n)]));
  return { systemConfig: toMap(sys), platformConfig: toMap(plat) };
}

export function formatReport({ systemConfig, platformConfig }) {
  const fmt = (m) =>
    `{${Object.keys(m)
      .sort()
      .map((k) => `${k}: ${m[k]}`)
      .join(", ")}}`;
  const total =
    Object.values(systemConfig).reduce((a, b) => a + b, 0) +
    Object.values(platformConfig).reduce((a, b) => a + b, 0);
  return total === 0
    ? "plaintext secrets at rest: none"
    : `WARNING plaintext secrets at rest: SystemConfig ${fmt(systemConfig)}; PlatformConfig ${fmt(platformConfig)}`;
}

async function main() {
  const url = resolveReportDbUrl("report-plaintext-secrets");
  if (!url) {
    console.log("WARNING plaintext secrets check could not run: no database configured");
    return;
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    console.log(formatReport(await countPlaintext(client)));
  } catch (err) {
    console.log(
      `WARNING plaintext secrets check could not run: ${err?.code ?? err?.message ?? err}`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
