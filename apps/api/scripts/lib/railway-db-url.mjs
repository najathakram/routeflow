// Shared Railway DATABASE_URL resolution, copied verbatim from the URL construction in
// apps/api/scripts/prod-migrate.mjs:22-41 (same `need` list, same encoding — the username is
// NOT URL-encoded there, only the password is — same suffix: none).
export const RAILWAY_PROXY_VARS = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "RAILWAY_TCP_PROXY_DOMAIN",
  "RAILWAY_TCP_PROXY_PORT",
];

/**
 * Proxy vars win over DATABASE_URL: under `railway run --service postgres` DATABASE_URL is the
 * unreachable *.railway.internal host. Mirrors prod-migrate.mjs's URL construction verbatim.
 *
 * `requireProxy: true` removes the DATABASE_URL fallback entirely — a partial proxy env then
 * throws instead of silently targeting whatever DATABASE_URL happens to be exported. Schema
 * WRITERS (prod-migrate.mjs) must use it; the read-only drift check does not.
 */
export function resolveDatabaseUrl(env = process.env, { requireProxy = false } = {}) {
  const missing = RAILWAY_PROXY_VARS.filter((k) => !env[k]);
  if (missing.length === 0) {
    return (
      `postgresql://${env.POSTGRES_USER}:${encodeURIComponent(env.POSTGRES_PASSWORD)}` +
      `@${env.RAILWAY_TCP_PROXY_DOMAIN}:${env.RAILWAY_TCP_PROXY_PORT}/${env.POSTGRES_DB}`
    );
  }
  if (!requireProxy && env.DATABASE_URL) return env.DATABASE_URL;
  throw new Error(
    `No DATABASE_URL and missing Railway variables: ${missing.join(", ")} — run under 'railway run --service postgres' or set DATABASE_URL`,
  );
}

/** decodeURIComponent that returns the raw value instead of throwing on malformed input
 *  (e.g. a bare `%` in a password) — redaction must never fail open. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? `${safeDecode(u.username)}:***@` : ""}${u.host}${u.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}

export function scrubSecrets(text, url) {
  let p;
  try {
    p = new URL(url).password;
  } catch {
    return text;
  }
  if (!p) return text;
  const needles = new Set([p, encodeURIComponent(p)]);
  try {
    needles.add(decodeURIComponent(p));
  } catch {
    // malformed percent-encoding: the raw + encoded forms above are still replaced
  }
  let out = text;
  for (const n of needles) if (n) out = out.split(n).join("***");
  return out;
}
