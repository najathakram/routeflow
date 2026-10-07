/**
 * B1210 (spec 71), LOCAL LANE ONLY: put a test tenant on a fulfilment business profile through the local super-admin,
 * and put its fulfilment config back EXACTLY afterwards.
 *
 *  - apply: the platform-admin API (preview then confirm), logged in with PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD
 *    (the throwaway `local-sa` from `npm run local:sa`, which local-env.mjs --e2e loads into the environment; nothing is
 *    written to disk here).
 *  - snapshot / restore: the tenant's TenantFeatureConfig and TenantFeatureOverride rows, read before and written back
 *    verbatim (delete the tenant's rows, re-insert the saved ones) on a connection built from the CHECKED explicit
 *    fields of a provably local database URL. No API path can un-set a mode, hence the rows.
 * Every entry point calls assertLocalFulfilmentTarget first.
 */
import { createRequire } from "node:module";
import {
  assertLocalFulfilmentTarget,
  type LocalFulfilmentTarget,
} from "../../lib/local-fulfilment-guard";

const req = createRequire(__filename);
const { Client } = req("pg");
const { localConnectionConfig } = req("../../../api/scripts/lib/local-db-target.cjs");

const TABLES = ["TenantFeatureConfig", "TenantFeatureOverride"] as const;
export type FulfilmentSnapshot = { tenantId: string } & Record<(typeof TABLES)[number], unknown[]>;

export function localTarget(apiOrigin: string): LocalFulfilmentTarget {
  return {
    baseUrl: process.env.PLAYWRIGHT_BASE_URL,
    apiUrl: apiOrigin,
    dbUrl: [process.env.E2E_SEED_DATABASE_URL, process.env.DATABASE_URL].find(
      (v) => v && v.trim() !== "",
    ),
    tenantSlug: process.env.PLAYWRIGHT_TENANT_SLUG ?? "e2e-routeflow",
    githubActions: process.env.GITHUB_ACTIONS,
  };
}

async function withDb<T>(t: LocalFulfilmentTarget, fn: (c: any) => Promise<T>): Promise<T> {
  assertLocalFulfilmentTarget(t);
  const client = new Client(localConnectionConfig(t.dbUrl));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function snapshotFulfilmentConfig(
  t: LocalFulfilmentTarget,
): Promise<FulfilmentSnapshot> {
  return withDb(t, async (c) => {
    const tenant = await c.query('SELECT id FROM "Tenant" WHERE slug = $1', [t.tenantSlug]);
    const tenantId: string | undefined = tenant.rows[0]?.id;
    if (!tenantId) throw new Error(`tenant "${t.tenantSlug}" not found in the local database`);
    const snap: any = { tenantId };
    for (const table of TABLES) {
      const r = await c.query(
        `SELECT coalesce(json_agg(t ORDER BY t.id), '[]'::json) AS rows FROM "${table}" t WHERE t."tenantId" = $1`,
        [tenantId],
      );
      snap[table] = r.rows[0].rows;
    }
    return snap as FulfilmentSnapshot;
  });
}

/** Writes the snapshot back verbatim and returns true when a fresh read-back is identical to it. */
export async function restoreFulfilmentConfig(
  t: LocalFulfilmentTarget,
  snap: FulfilmentSnapshot,
): Promise<boolean> {
  await withDb(t, async (c) => {
    await c.query("BEGIN");
    try {
      for (const table of TABLES) {
        await c.query(`DELETE FROM "${table}" WHERE "tenantId" = $1`, [snap.tenantId]);
        await c.query(
          `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(null::"${table}", $1::json)`,
          [JSON.stringify(snap[table])],
        );
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
  const after = await snapshotFulfilmentConfig(t);
  return JSON.stringify(after) === JSON.stringify(snap);
}

/** Applies a business profile to the tenant as the local super-admin (preview, then confirm with its fingerprint). */
export async function applyBusinessProfile(
  t: LocalFulfilmentTarget,
  snap: FulfilmentSnapshot,
  profile: string,
): Promise<void> {
  assertLocalFulfilmentTarget(t);
  const username = process.env.PLAYWRIGHT_SA_USERNAME;
  const password = process.env.PLAYWRIGHT_SA_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD are not set: run `npm run local:sa` once (local-env.mjs --e2e loads it).",
    );
  }
  const api = `${t.apiUrl}/api/v1`;
  const send = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`${api}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
    return (await res.json()) as any;
  };
  const { accessToken } = await send("/auth/login", { username, password });
  const base = `/platform-admin/tenants/${snap.tenantId}/business-profile`;
  const preview = await send(`${base}/preview`, { profile }, accessToken);
  await send(
    base,
    {
      profile,
      planFingerprint: preview.planFingerprint,
      reason: "local e2e spec 71 (restored afterwards)",
    },
    accessToken,
  );
}
