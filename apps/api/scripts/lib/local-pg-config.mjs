// The `--local` guard for the T6 / report scripts. `new URL(u).hostname` is NOT the host `pg` dials: a
// `?host=prod…` query overrides the authority in pg-connection-string, so a hostname allowlist can be walked
// past. This resolves the URL with the same parser pg uses (local-db-target.cjs) and returns explicit fields;
// callers build `pg.Client(cfg)` from THOSE, so what was checked is exactly what is dialled (#2204).
import { createRequire } from "node:module";

const { localConnectionConfig } = createRequire(import.meta.url)("./local-db-target.cjs");

/** Explicit `{ host, port, user, password, database }` for a PROVABLY local URL, else throws. */
export function requireLocalPgConfig(url) {
  const cfg = localConnectionConfig(url);
  if (!cfg) {
    throw new Error(
      "--local refuses a target that is not provably local (host, ?host=/hostaddr=/service overrides, " +
        "multi-host and socket targets are all refused)",
    );
  }
  return cfg;
}
