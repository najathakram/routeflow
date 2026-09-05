import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// p5 — direct unit contract for scripts/lib/railway-db-url.mjs (resolveDatabaseUrl, redactUrl,
// scrubSecrets). The library is ESM (`.mjs`) and this suite runs under ts-jest's CommonJS
// transform, so each case spawns a tiny `node --input-type=module` child that imports the real
// module by file:// URL and prints one JSON line — no ts-jest ESM loader involved, no database.

const API_DIR = path.resolve(__dirname, "../..");
const LIB_HREF = pathToFileURL(path.resolve(API_DIR, "scripts/lib/railway-db-url.mjs")).href;

const SCRIPT = `
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "${LIB_HREF}";
const mode = process.env.RDU_MODE;
try {
  if (mode === "resolve") {
    const requireProxy = process.env.RDU_REQUIRE_PROXY === "1";
    const url = resolveDatabaseUrl(process.env, { requireProxy });
    console.log(JSON.stringify({ ok: true, url }));
  } else if (mode === "redact") {
    console.log(JSON.stringify({ ok: true, value: redactUrl(process.env.RDU_INPUT) }));
  } else if (mode === "scrub") {
    console.log(
      JSON.stringify({ ok: true, value: scrubSecrets(process.env.RDU_TEXT, process.env.RDU_URL) }),
    );
  } else {
    throw new Error("railway-db-url.spec shim: unknown RDU_MODE " + mode);
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, message: e.message }));
}
`;

function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  return { ...env, ...extra };
}

function run(
  mode: string,
  extra: Record<string, string> = {},
): { ok: boolean; url?: string; value?: string; message?: string } {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", SCRIPT], {
    encoding: "utf8",
    env: scrubbedEnv({ RDU_MODE: mode, ...extra }),
  });
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(
      `railway-db-url shim failed (status ${res.status}):\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  return JSON.parse(res.stdout.trim());
}

describe("scripts/lib/railway-db-url.mjs contract (p5)", () => {
  describe("resolveDatabaseUrl", () => {
    it("proxy vars win over DATABASE_URL", () => {
      const result = run("resolve", {
        POSTGRES_USER: "u",
        POSTGRES_PASSWORD: "p",
        POSTGRES_DB: "d",
        RAILWAY_TCP_PROXY_DOMAIN: "h",
        RAILWAY_TCP_PROXY_PORT: "5",
        DATABASE_URL: "postgresql://ignored:ignored@ignored-host/ignored",
      });

      expect(result).toEqual({ ok: true, url: "postgresql://u:p@h:5/d" });
    });

    it("requireProxy: true throws on any missing var and never falls back to DATABASE_URL", () => {
      const result = run("resolve", {
        RDU_REQUIRE_PROXY: "1",
        POSTGRES_USER: "u",
        POSTGRES_PASSWORD: "p",
        POSTGRES_DB: "d",
        RAILWAY_TCP_PROXY_DOMAIN: "h",
        // RAILWAY_TCP_PROXY_PORT deliberately missing
        DATABASE_URL: "postgresql://fallback:fallback@fallback-host/fallback",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("RAILWAY_TCP_PROXY_PORT");
      // No fallback URL was ever constructed or returned.
      expect(result.url).toBeUndefined();
      expect(result.message).not.toContain("fallback-host");
    });

    it("partial vars without requireProxy fall back to DATABASE_URL", () => {
      const result = run("resolve", {
        POSTGRES_USER: "u",
        // the rest of the proxy vars are deliberately absent
        DATABASE_URL: "postgresql://fallback:pw@fallback-host/db",
      });

      expect(result).toEqual({ ok: true, url: "postgresql://fallback:pw@fallback-host/db" });
    });

    it("byte-identical to the pre-PR-1 prod-migrate.mjs URL construction (username unencoded, password encoded)", () => {
      const result = run("resolve", {
        POSTGRES_USER: "u",
        POSTGRES_PASSWORD: "p w",
        POSTGRES_DB: "d",
        RAILWAY_TCP_PROXY_DOMAIN: "h",
        RAILWAY_TCP_PROXY_PORT: "5",
      });

      expect(result).toEqual({ ok: true, url: "postgresql://u:p%20w@h:5/d" });
    });
  });

  describe("redactUrl", () => {
    it("returns '<unparseable url>' for a string that is not a URL", () => {
      const result = run("redact", { RDU_INPUT: "not a url" });

      expect(result).toEqual({ ok: true, value: "<unparseable url>" });
    });
  });

  describe("scrubSecrets", () => {
    it("returns the input unchanged when the URL has an empty password", () => {
      const result = run("scrub", {
        RDU_TEXT: "hello world, nothing secret here",
        RDU_URL: "postgresql://u@host/db",
      });

      expect(result).toEqual({ ok: true, value: "hello world, nothing secret here" });
    });
  });
});
