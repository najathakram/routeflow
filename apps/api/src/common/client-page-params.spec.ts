/**
 * T3 (S4, Next 15 upgrade — apps/web 14.2.35 → 15.5.25 + React 19): Next 15 makes `params` and
 * `searchParams` async on every page — a Client Component must read the route param via the
 * `useParams()`/`useSearchParams()` hook instead of destructuring the old synchronous prop, and a
 * Server Component must `await` the (now-`Promise`) prop before use. See
 * `.claude/pipeline/2026-09-10-next-15/spec.md` R3/R4 and this test plan's §0 correction: the
 * offender count is counted by **site**, not by file — `customers/[id]/page.tsx` destructures the
 * old prop at two sites (:1902 `CustomerDetailPageInner`, :4286 the default-export Suspense
 * wrapper), so a fix that converts only one of the two still leaves an offender.
 *
 * No runtime imports — plain `fs.readFileSync` walking the tree, matching the house convention
 * (see `no-dead-deps.spec.ts`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const APP_DIR = join(REPO_ROOT, "apps/web/app");

/** The old Next <15 synchronous prop shapes for `params` / `searchParams`, as a union of three
 *  site patterns (each match is one `file:line` site; group 1 is the prop key):
 *  - DESTRUCTURE_PARAM — a parameter-list destructure whose name list contains the key, whatever
 *    else it holds: `({ params }: …)`, `({ params, searchParams }: …)`, the nested
 *    `({ params: { id } }: …)`, or the alias-typed `({ params }: Props)`.
 *  - PROPS_READ — a whole-props read, `props.params` / `props.searchParams`.
 *  - PROPS_DESTRUCTURE — a body destructure of the props object, `const { params } = props`. */
const DESTRUCTURE_PARAM = /\(\s*\{[^()]*?\b(params|searchParams)\b[^()]*?\}\s*:/g;
const PROPS_READ = /\bprops\.(params|searchParams)\b/g;
const PROPS_DESTRUCTURE =
  /\b(?:const|let)\s*\{[^}]*\b(params|searchParams)\b[^}]*\}\s*=\s*props\b/g;
const SYNC_PROP_PATTERNS = [DESTRUCTURE_PARAM, PROPS_READ, PROPS_DESTRUCTURE];

/** A Server Component prop annotation (`params: …` / `searchParams?: …`) that is NOT the Next 15
 *  `Promise<…>` shape — each match is one stale site. */
const SERVER_SYNC_ANNOTATION = /\b(params|searchParams)\s*\??\s*:(?!\s*Promise<)/g;

/** A Server Component consumes the async prop by awaiting it (or unwrapping it with `use()`). */
const SERVER_AWAIT =
  /\bawait\s+(?:props\.)?(params|searchParams)\b|\buse\(\s*(?:props\.)?(params|searchParams)\s*\)/;

/** A prop type wrapped as `Promise<...>` is the Next 15 async-prop shape and has already been
 *  converted; only a plain (non-Promise) type annotation is the stale sync shape. Matches the
 *  ANNOTATION key (`searchParams: Promise<…>`), not the destructure, so it is satisfied by both
 *  idiomatic conversions: the inline `({ searchParams }: { searchParams: Promise<…> })` form and
 *  a hoisted `type Props = { searchParams: Promise<…> }`. */
const PROMISE_WRAPPED = /\b(?:params|searchParams)\s*:\s*Promise</;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function walkPageFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkPageFiles(full, out);
      continue;
    }
    if (entry === "page.tsx") out.push(full);
  }
  return out;
}

function isClientComponent(source: string): boolean {
  // The directive must be the first statement of the file (ignoring leading blank/comment
  // noise is unnecessary here — every "use client" page in this repo puts it on line 1).
  return /^\s*["']use client["'];?/.test(source);
}

type Site = { file: string; line: number; key: "params" | "searchParams" };

function findSyncPropMatches(source: string): { index: number; key: Site["key"] }[] {
  const matches: { index: number; key: Site["key"] }[] = [];
  for (const pattern of SYNC_PROP_PATTERNS) {
    const re = new RegExp(pattern);
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) {
      matches.push({ index: match.index, key: match[1] as Site["key"] });
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}

function findDestructureSites(source: string, file: string): Site[] {
  return findSyncPropMatches(source).map(({ index, key }) => ({
    file: toPosix(relative(REPO_ROOT, file)),
    line: lineOf(source, index),
    key,
  }));
}

function labelSites(sites: Site[]): string[] {
  return sites.map((s) => `${s.file}:${s.line} (${s.key})`);
}

describe("Next 15 async route-param props (T3, R3)", () => {
  const pageFiles = walkPageFiles(APP_DIR);
  const filesWithSource = pageFiles.map((file) => ({ file, source: readFileSync(file, "utf8") }));

  it("no Client Component page.tsx destructures the params/searchParams prop directly", () => {
    // Red today: 18 sites across 17 files (test plan §0) — every one of them is a Client
    // Component still using the pre-15 synchronous prop instead of useParams()/useSearchParams().
    // The walk guard keeps an empty offender list from meaning "nothing was read".
    // The matcher is pinned HERE, not in a standalone it(): a fixture-only test would stay green
    // even if this block stopped using the matcher. Every stale sync-prop form must be flagged;
    // the hook forms that replace it must not be.
    const staleForms = [
      "({ params }: { params: { id: string } })",
      "({ params, searchParams }: { params: { id: string }; searchParams: { q?: string } })",
      "({ params: { id } }: { params: { id: string } })",
      "type Props = { params: { id: string } }; function P({ params }: Props) {}",
      "function P(props: { params: { id: string } }) { return props.params.id; }",
      "function P(props: Props) { const { params } = props; }",
    ];
    const hookForms = [
      "const params = useParams();",
      "const { id } = useParams<{ id: string }>();",
      "const searchParams = useSearchParams();",
    ];
    for (const snippet of staleForms) {
      expect({ snippet, flagged: findSyncPropMatches(snippet).length > 0 }).toEqual({
        snippet,
        flagged: true,
      });
    }
    for (const snippet of hookForms) {
      expect({ snippet, matches: findSyncPropMatches(snippet).length }).toEqual({
        snippet,
        matches: 0,
      });
    }
    expect(pageFiles.length).toBeGreaterThan(0);
    const offenders = filesWithSource
      .filter(({ source }) => isClientComponent(source))
      .flatMap(({ file, source }) => findDestructureSites(source, file));
    expect(labelSites(offenders)).toEqual([]);
  });

  it("every Client Component page.tsx under a dynamic route segment imports useParams from next/navigation", () => {
    // Red today: the 17 files listed by the offender test above still rely on the sync prop
    // instead of the hook, so none of them import useParams — this must become [].
    // Scoped to dynamic-segment folders (path contains "[") — a static-route client page has
    // no route param to read. Also guards against an empty walk reading as "no offenders".
    expect(pageFiles.length).toBeGreaterThan(0);
    const offenders = filesWithSource
      .filter(({ file, source }) => isClientComponent(source) && /\[[^/\\]+\]/.test(file))
      .filter(
        ({ source }) =>
          !/import\s*\{[^}]*\buseParams\b[^}]*\}\s*from\s*["']next\/navigation["']/.test(source),
      )
      .map(({ file }) => toPosix(relative(REPO_ROOT, file)))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("no Server Component page.tsx reads params/searchParams without the Next 15 Promise shape", () => {
    // Tree-wide R3 for server pages: every `params`/`searchParams` annotation must be
    // `Promise<…>`, and the file must await (or `use()`) the prop. Red at base on
    // finance/expenses/page.tsx (plain-object searchParams, never awaited). The walk guard keeps
    // an empty offender list from meaning "nothing was read".
    expect(pageFiles.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const { file, source } of filesWithSource) {
      if (isClientComponent(source) || !/\b(params|searchParams)\b/.test(source)) continue;
      const rel = toPosix(relative(REPO_ROOT, file));
      const re = new RegExp(SERVER_SYNC_ANNOTATION);
      let match: RegExpExecArray | null;
      while ((match = re.exec(source))) {
        offenders.push(`${rel}:${lineOf(source, match.index)} (${match[1]} not Promise<…>)`);
      }
      if (!SERVER_AWAIT.test(source)) offenders.push(`${rel}:1 (never awaited)`);
    }
    expect(offenders).toEqual([]);
  });

  it("the Server Component reading searchParams (finance/expenses redirect) awaits it before use", () => {
    // Red today: apps/web/app/(dashboard)/finance/expenses/page.tsx destructures
    // `{ searchParams }: { searchParams: { ... } }` as a plain (non-Promise) prop and never
    // awaits it — the Next 15 shape is `{ searchParams }: { searchParams: Promise<{ ... }> }`
    // with `const params = await searchParams;` (or equivalent) before use.
    const target = filesWithSource.find(({ file }) =>
      toPosix(file).endsWith("apps/web/app/(dashboard)/finance/expenses/page.tsx"),
    );
    expect(target).toBeDefined();
    const { source } = target!;
    expect(isClientComponent(source)).toBe(false);
    // Both remain red today: the prop is annotated as a plain object, not a Promise, and the
    // file never awaits it. Deliberately does NOT also require a prop-destructure site — that
    // would reject an equally correct `type Props = { searchParams: Promise<…> }` conversion.
    expect(PROMISE_WRAPPED.test(source)).toBe(true);
    expect(/\bawait\s+searchParams\b/.test(source)).toBe(true);
  });

  it("next.config.mjs no longer declares experimental.serverComponentsExternalPackages (R4)", () => {
    // Red today: next.config.mjs has `experimental: { serverComponentsExternalPackages: [] }` —
    // the option was folded into stable `serverExternalPackages` in Next 15.
    const nextConfig = readFileSync(join(REPO_ROOT, "apps/web/next.config.mjs"), "utf8");
    expect(nextConfig.includes("serverComponentsExternalPackages")).toBe(false);
  });

  it("every Client Component page reads only the route params its own folder declares", () => {
    // After the Next 15 conversion `useParams()` is untyped (`Record<string, ParamValue>`), so a
    // mistyped key — `const id = params.idd as string` — type-checks and is undefined at runtime.
    // The old `{ params: { id: string } }` prop annotation made that a tsc error; nothing did after
    // the conversion. This pins every key read off a useParams() binding to the dynamic segments the
    // page's own path declares (`[id]`, `[transactionId]`, `[categoryId]`, `[...slug]`). Only reads
    // off the useParams() binding are checked, so an unrelated `params` — an axios config, a
    // URLSearchParams — never trips it, and `x.method(` call sites are skipped.
    const offenders: string[] = [];
    let checked = 0;
    for (const { file, source } of filesWithSource) {
      if (!isClientComponent(source)) continue;
      const rel = toPosix(relative(REPO_ROOT, file));
      const segments = new Set<string>();
      const segRe = /\[(?:\.\.\.)?([^\]/]+)\]/g;
      let seg: RegExpExecArray | null;
      while ((seg = segRe.exec(rel))) segments.add(seg[1]);
      if (segments.size === 0) continue;
      const declared = Array.from(segments).join(", ");

      const names = new Set<string>();
      const bindRe = /\b(?:const|let)\s+(\w+)\s*=\s*useParams\b/g;
      let bind: RegExpExecArray | null;
      while ((bind = bindRe.exec(source))) names.add(bind[1]);
      for (const name of Array.from(names)) {
        const readRe = new RegExp(`\\b${name}\\.(\\w+)\\b(?!\\s*\\()`, "g");
        let read: RegExpExecArray | null;
        while ((read = readRe.exec(source))) {
          checked++;
          if (!segments.has(read[1])) {
            offenders.push(
              `${rel}:${lineOf(source, read.index)} (${name}.${read[1]}; folder declares ${declared})`,
            );
          }
        }
      }

      const destructRe = /\b(?:const|let)\s*\{([^}]*)\}\s*=\s*useParams\b/g;
      let dest: RegExpExecArray | null;
      while ((dest = destructRe.exec(source))) {
        const keys = dest[1]
          .split(",")
          .map((k) => k.split(/[:=]/)[0].trim())
          .filter(Boolean);
        for (const key of keys) {
          checked++;
          if (!segments.has(key)) {
            offenders.push(
              `${rel}:${lineOf(source, dest.index)} ({ ${key} }; folder declares ${declared})`,
            );
          }
        }
      }
    }
    // An empty offender list must not mean "nothing was read".
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
