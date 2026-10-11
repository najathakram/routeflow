// Prisma generated-client freshness check (pure, offline, no DB, no `prisma` spawn).
//
// WHY: a stale generated client (e.g. after merging a master that changed apps/api/prisma/schema)
// surfaces deep inside `npm run verify` as an api check-types error plus schema-derived specs red,
// after a whole heavy-slot hold (~45 min measured 2026-10-10). This check costs milliseconds and
// runs BEFORE the slot is taken (scripts/verify-turbo.mjs).
//
// SIGNAL: `prisma generate` (prisma-client-js, no custom `output`) copies the datamodel it was
// generated from to `<node_modules>/.prisma/client/schema.prisma` (and inlines the same text into
// index.js as `inlineSchema`). The schema FOLDER is merged in file-name order, but the copy is
// not byte-equal to the sources: Prisma's formatter re-aligns columns and moves a field written
// AFTER a block attribute (`@@index`) up above it. So the check compares the two as, per top-level
// block (`model X`, `enum Y`, ...), the multiset of its lines after the ONLY normalisations
// observed: `//` comments dropped, whitespace runs collapsed, blank lines dropped, line order
// within a block ignored. Any added/removed/changed field, attribute, enum value or block makes
// the multisets differ; a freshly generated client compares equal (proved by
// scripts/prisma-fresh.self-test.mjs against the real checkout when a generated client exists).
// A comment-only schema edit is deliberately NOT stale (generation would not change behaviour).
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BLOCK_OPEN = /^(model|enum|type|view|generator|datasource)\s+(\w+)\s*\{/;

/** Pure. Parses datamodel text into `Map<"kind Name", sortedNormalisedLines[]>`. */
export function schemaBlocks(text) {
  const blocks = new Map();
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .replace(/\/\/.*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    if (!current) {
      const m = BLOCK_OPEN.exec(line);
      if (m) {
        current = { key: `${m[1]} ${m[2]}`, lines: [] };
        // anything after the `{` on the opening line (not used by this repo's schema) is kept
        const rest = line.slice(m[0].length).trim();
        if (rest && rest !== "}") current.lines.push(rest);
        if (rest === "}") {
          blocks.set(current.key, []);
          current = null;
        }
      }
      continue;
    }
    if (line === "}") {
      blocks.set(current.key, current.lines.sort());
      current = null;
    } else current.lines.push(line);
  }
  return blocks;
}

/** Reads every `*.prisma` in the schema folder, in file-name order (Prisma merges them so). */
export function readSchemaFolder(schemaDir) {
  const files = readdirSync(schemaDir)
    .filter((f) => f.endsWith(".prisma"))
    .sort();
  if (!files.length) return null;
  return files.map((f) => readFileSync(join(schemaDir, f), "utf8")).join("\n");
}

/** Pure given the two directories. `{ fresh, reason }`; `reason` is `null` when fresh. */
export function checkPrismaClientFresh({ schemaDir, clientDir }) {
  if (!schemaDir || !existsSync(schemaDir)) {
    return { fresh: false, reason: `schema folder not found: ${schemaDir}` };
  }
  const source = readSchemaFolder(schemaDir);
  if (source === null) return { fresh: false, reason: `no *.prisma files in ${schemaDir}` };
  if (!clientDir) {
    return {
      fresh: false,
      reason:
        "generated Prisma client not resolvable from apps/api (@prisma/client not installed? run npm ci, then prisma generate)",
    };
  }
  if (!existsSync(clientDir)) {
    return {
      fresh: false,
      reason: `generated Prisma client not found (${clientDir}) — never generated here`,
    };
  }
  const generatedPath = join(clientDir, "schema.prisma");
  if (!existsSync(generatedPath)) {
    return { fresh: false, reason: `generated client has no schema.prisma (${generatedPath})` };
  }
  const want = schemaBlocks(source);
  const have = schemaBlocks(readFileSync(generatedPath, "utf8"));
  const diffs = [];
  for (const [key, lines] of want) {
    if (!have.has(key)) diffs.push(`${key} missing from the generated client`);
    else if (have.get(key).join("\n") !== lines.join("\n")) diffs.push(`${key} differs`);
  }
  for (const key of have.keys())
    if (!want.has(key)) diffs.push(`${key} only in the generated client`);
  if (!diffs.length) return { fresh: true, reason: null };
  const shown = diffs.slice(0, 5).join("; ");
  const more = diffs.length > 5 ? ` (+${diffs.length - 5} more)` : "";
  return {
    fresh: false,
    reason: `generated client does not match ${schemaDir}: ${shown}${more}`,
  };
}

/** Where `apps/api` resolves its generated client: `<node_modules>/.prisma/client`, found the way
 *  Node itself finds it (relative to the installed `@prisma/client`). `null` if not installed. */
export function resolveGeneratedClientDir(apiDir) {
  try {
    const fromApi = createRequire(join(apiDir, "package.json"));
    const fromClient = createRequire(fromApi.resolve("@prisma/client/package.json"));
    return join(fromClient.resolve(".prisma/client/package.json"), "..");
  } catch {
    return null;
  }
}

/** The fix text printed on a stale client. */
export const PRISMA_STALE_FIX =
  "fix: cd apps/api && npx prisma generate\n" +
  "note: worktrees that share node_modules through junctions share ONE generated client, " +
  "so generating here changes it for those worktrees too.";

/** Whether a run's plan reaches @routeflow/api (so the generated client matters). Pure. */
export function planReachesApi({ scope, excluded = [] }) {
  const API = "@routeflow/api";
  if (excluded.includes(API)) return false;
  return scope.mode === "full" || (scope.workspaces ?? []).includes(API);
}

/**
 * The verify preflight, as one pure-ish decision (injectable resolver so a self-test needs no real
 * client). Never runs on CI (`env.CI` truthy — CI generates its own client and stays byte-identical)
 * and only when the plan reaches @routeflow/api. Returns `{ ran: false, why }` when skipped, else
 * `{ ran: true, fresh, reason, message }` where `message` is the stderr text for a stale client.
 */
export function prismaPreflight({
  env,
  scope,
  excluded = [],
  apiDir,
  resolveClient = resolveGeneratedClientDir,
}) {
  if (env.CI) return { ran: false, why: "CI" };
  if (!planReachesApi({ scope, excluded })) return { ran: false, why: "api not in plan" };
  const r = checkPrismaClientFresh({
    schemaDir: join(apiDir, "prisma", "schema"),
    clientDir: resolveClient(apiDir),
  });
  if (r.fresh) return { ran: true, fresh: true, reason: null, message: null };
  return {
    ran: true,
    fresh: false,
    reason: r.reason,
    message:
      `verify: STALE Prisma client — ${r.reason}\n` +
      `${PRISMA_STALE_FIX}\n` +
      `Refusing to queue a heavy-slot hold that would fail ~45 min in on this (nothing was run).`,
  };
}
