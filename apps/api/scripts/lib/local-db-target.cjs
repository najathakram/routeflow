/**
 * Is a database URL PROVABLY local? An allowlist, never a denylist: anything that is not
 * on the list (a Railway proxy host, `*.railway.internal`, an unknown remote host, an empty or
 * unparseable value) is NOT local, so a target we cannot classify fails closed.
 *
 * Same host set as `assertSafeTarget` in apps/api/prisma/seed.ts (localhost, IPv4/IPv6 loopback,
 * and the docker-compose service host `postgres`). Used by e2e-seed.js to keep the approved-buyer
 * fixture (a GLOBAL BuyerAccount with a committed throwaway password) off every non-local target.
 * There is deliberately no override flag.
 */
"use strict";

const LOCAL_DB_HOSTS = ["localhost", "127.0.0.1", "::1", "postgres"];

/** Query parameters that can REDIRECT the connection to another host (libpq / pg-connection-string). */
const REDIRECTING_PARAMS = ["host", "hostaddr", "service"];

/**
 * The connection's REAL target, resolved by `pg-connection-string` (the parser `pg` itself uses), never by our
 * own reading of the URL: a `?host=prod.example.com` query overrides the authority's host in that parser, so
 * `new URL(u).hostname` says "localhost" while pg connects to prod. Returns explicit
 * `{ host, port, user, password, database }` fields when the URL is PROVABLY local, else null. Callers build
 * `pg.Client` from THESE fields, never from the raw string, so what was checked is exactly what is dialled.
 * Rejected outright: any host/hostaddr/service query parameter (any case), a multi-host list, a unix-socket
 * path, an encoded `?…` smuggled into the database name.
 */
function localConnectionConfig(dbUrl) {
  if (typeof dbUrl !== "string" || dbUrl.trim() === "") return null;
  let url;
  try {
    url = new URL(dbUrl);
  } catch {
    return null;
  }
  for (const key of url.searchParams.keys()) {
    if (REDIRECTING_PARAMS.includes(key.toLowerCase())) return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parse } = require("pg-connection-string");
  let cfg;
  try {
    cfg = parse(dbUrl);
  } catch {
    return null;
  }
  // WHATWG URL / the parser keep the brackets on an IPv6 literal: "[::1]".
  const host = String(cfg.host ?? "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!LOCAL_DB_HOSTS.includes(host)) return null; // also rejects "a,b" lists and "/socket/paths"
  let database;
  try {
    database = decodeURIComponent(cfg.database ?? "");
  } catch {
    return null;
  }
  if (/[?&=]/.test(database)) return null; // a query smuggled into the database name
  return {
    host,
    port: cfg.port ? Number(cfg.port) : 5432,
    user: cfg.user ?? undefined,
    password: cfg.password ?? undefined,
    database,
  };
}

function isLocalDbTarget(dbUrl) {
  return localConnectionConfig(dbUrl) !== null;
}

module.exports = { isLocalDbTarget, localConnectionConfig, LOCAL_DB_HOSTS };
