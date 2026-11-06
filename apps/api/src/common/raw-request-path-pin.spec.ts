import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * Class pin: a request path can carry a single-use link token, so a log line, an audit row or an error tag must never
 * be built from the raw path. `redacted-route.ts` is the one helper that turns a request into something safe to store.
 *
 * Every non-spec api file that reads `req.path`, `req.url` or `req.originalUrl` is inventoried below with the reason.
 * A new reader fails this spec until someone lists it: as LOGIC (the value is matched, never written anywhere) or as
 * a SINK (it writes a route somewhere, so it must go through the helper).
 */
const SRC = join(__dirname, "..");

/** Reads the path to decide something; the value is never logged, stored or tagged. */
const LOGIC: Record<string, string> = {
  "auth/guards/jwt-auth.guard.ts": "matches the change-password route to allow a flagged session",
  "uploads/uploads.controller.ts": "extracts the storage key from the path",
  "uploads/uploads-access.guard.ts": "extracts the storage key from the path",
  "tenant/tenant-status.guard.ts": "READ_ONLY allow-list lookup",
  "buyer/guards/buyer-seller-context.guard.ts":
    "read-only exemption lookup; its log context is redactedRoute",
  "common/throttler-exception.filter.ts":
    "retry-after choice for the login route; its log line is redactedRoute",
  "common/redacted-route.ts": "the helper itself",
  "common/sentry-redact.ts": "the Sentry scrub itself",
};

/** Writes a route somewhere (log, audit row, Sentry tag): must import the helper. */
const SINKS: Record<string, string> = {
  "auth/guards/no-impersonation.guard.ts": "fallback route in the refusal log",
  "tenant/tenant-required.interceptor.ts": "fallback route in the warn log",
  "common/lock-conflict.filter.ts": "fallback `path` tag",
};

const READS = /\b(?:req|request)\??\.(?:originalUrl|url|path)\b|\boriginalUrl\b(?!\??\s*:)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

function readers(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split(sep).join("/");
    if (rel.startsWith("common/testing/")) continue;
    const hits = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !isComment(line) && READS.test(line));
    if (hits.length) found.set(rel, hits);
  }
  return found;
}

describe("raw request-path readers", () => {
  const found = readers();

  it("every file that reads a raw request path is inventoried", () => {
    const unlisted = [...found.keys()].filter((f) => !(f in LOGIC) && !(f in SINKS));
    expect(unlisted).toEqual([]);
  });

  it("the inventory holds no stale entries", () => {
    const stale = [...Object.keys(LOGIC), ...Object.keys(SINKS)].filter((f) => !found.has(f));
    expect(stale).toEqual([]);
  });

  it.each(Object.keys(SINKS))("%s sends its fallback through redactPath", (rel) => {
    const src = readFileSync(join(SRC, rel), "utf8");
    expect(src).toMatch(/from "[./]+(?:\/common)?\/redacted-route"/);
    for (const line of found.get(rel) ?? []) expect(line).toContain("redactPath(");
  });

  it.each(Object.keys(LOGIC))("%s does not write the raw path into a message", (rel) => {
    for (const line of found.get(rel) ?? []) {
      expect(line).not.toMatch(/logger|console\.|message:|warn\(|error\(|log\(/i);
    }
  });

  it("the sinks that log a route from a request use the helper, not a raw read", () => {
    for (const rel of [
      "auth/guards/impersonation.guard.ts",
      "billing/addon.guard.ts",
      "auth/guards/roles.guard.ts",
      "audit/audit.interceptor.ts",
      "common/sentry-exception.filter.ts",
    ]) {
      expect(readFileSync(join(SRC, rel), "utf8")).toMatch(/redacted-route"/);
    }
  });
});
