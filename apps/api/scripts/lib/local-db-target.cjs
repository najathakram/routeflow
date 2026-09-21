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

function isLocalDbTarget(dbUrl) {
  if (typeof dbUrl !== "string" || dbUrl.trim() === "") return false;
  let host;
  try {
    host = new URL(dbUrl).hostname;
  } catch {
    return false;
  }
  // WHATWG URL keeps the brackets on an IPv6 literal: "[::1]".
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOCAL_DB_HOSTS.includes(host);
}

module.exports = { isLocalDbTarget, LOCAL_DB_HOSTS };
