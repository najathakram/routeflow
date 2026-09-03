const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

export function requireLocalDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DB-backed specs need DATABASE_URL — run `npm run local:test:db`");
  // WHATWG URL brackets IPv6 hosts ("[::1]"); strip them before the lookup.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  // No CI escape hatch: CI's postgres service is reachable at `localhost`, so the refusal never
  // needed one — and a `RUN_DB_SPECS=ci` bypass would disable the guard exactly where these
  // specs run unattended against whatever DATABASE_URL the job happens to carry.
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run DB-backed specs against non-local host ${host} (allowed: ${[...LOCAL_HOSTS].join(", ")})`,
    );
  }
  return url;
}

export function describeDb(name: string, fn: () => void): void {
  // A silently-skipped lane reports green with zero executed tests — the failure mode this
  // lane exists to close. An unset RUN_DB_SPECS is therefore a hard error, not a skip.
  if (!process.env.RUN_DB_SPECS) {
    throw new Error(
      "DB-backed specs invoked without RUN_DB_SPECS — run them through npm run local:test:db (or the CI lane)",
    );
  }
  describe(name, fn);
}
