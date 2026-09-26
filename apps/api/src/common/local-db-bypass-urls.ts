/**
 * URLs that LOOK local to `new URL(u).hostname` while `pg` would dial elsewhere (or that no allowlist can
 * classify). Shared by the helper's spec and the every-guard spec, so a new bypass is added once (#2162, #2204).
 */
export const NON_LOCAL_DB_URLS: ReadonlyArray<readonly [string, string]> = [
  ["a Railway TCP proxy URL", "postgresql://u:p@roundhouse.proxy.rlwy.net:12345/railway"],
  ["a *.railway.internal URL", "postgresql://u:p@postgres.railway.internal:5432/railway"],
  ["an unknown remote host", "postgresql://u:p@db.example.com:5432/app"],
  ["a custom proxy host with no railway marker", "postgresql://u:p@pg.internal-proxy.net:5432/x"],
  ["a lookalike host", "postgresql://u:p@localhost.host.invalid:5432/x"],
  ["localhost only in the userinfo", "postgresql://localhost@host.invalid:5432/x"],
  ["a ?host= override", "postgresql://u:p@localhost:5432/x?host=prod.invalid"],
  ["a ?hostaddr= override", "postgresql://u:p@localhost:5432/x?hostaddr=203.0.113.9"],
  ["a ?service= indirection", "postgresql://u:p@localhost:5432/x?service=prod"],
  ["a ?HOST= in any case", "postgresql://u:p@localhost:5432/x?HOST=prod.invalid"],
  [
    "a host param among others",
    "postgresql://u:p@localhost:5432/x?sslmode=disable&host=host.invalid",
  ],
  ["a multi-host list", "postgresql://u:p@localhost,host.invalid:5432/x"],
  ["a unix-socket host", "postgresql://u:p@/x?host=%2Fvar%2Frun%2Fpostgresql"],
  [
    "a query smuggled in the database name",
    "postgresql://u:p@localhost:5432/routeflow_dev%3Fhost%3Dprod.invalid",
  ],
  ["an empty string", ""],
  ["an unparseable value", "not a url"],
];
