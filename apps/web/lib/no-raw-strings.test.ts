/**
 * #1965 (spec 10) — static guard: no raw API/provider strings in the UI.
 *
 * Rule: the UI renders a sentence from a closed code -> copy map (`lib/reason-copy.ts`). A raw
 * `lastError`, a provider `error`, or a server/axios `.message` never goes into a JSX text node, an
 * attribute, or a template literal. This walks `apps/web/{app,components,lib}` (non-test) and fails
 * on an interpolation of a known raw carrier. Precedent: `apps/api/src/common/no-bare-cron.spec.ts`.
 *
 * Scope is deliberately the RAW CARRIERS below, not "any identifier ending in error": a page's own
 * form-validation state (`nameError`, `apiError` already mapped by the page) is app-authored copy and
 * would drown the rule in false positives. Each justified exception lives in ALLOWLIST with a reason.
 *
 * NOT covered (follow-up ticket): the global mutation toast in `app/providers.tsx` (shows the raw
 * server message unless a mutation opts out with `meta.localErrorToast`), and the ~100 toast
 * descriptions built from `err.response.data.message` through anything other than a plain chain or
 * a one-step `const` alias (e.g. `msg || "fallback"` inside an object literal, a helper that returns
 * the message, props forwarded through a component). This is a literal-shape scan with planted
 * fixtures, not a data-flow analysis.
 */
import * as fs from "fs";
import * as path from "path";

const WEB_ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"];

/** Interpolated member chains that carry unmapped API / provider / exception text. */
const RAW_CARRIERS: RegExp[] = [
  /(^|[.?])lastError$/,
  /\.error\??\.message$/, // react-query / axios error objects
  /^(err|error|e|ex|exception)\??\.message$/,
  /response\??\.data\??\.(message|error)$/,
  /(^|\.)welcomeEmail\.error$/,
  /^active\??\.error$/, // scan-modal per-invoice error (must hold closed copy only; see ALLOWLIST)
  /^data\.reason$/, // realtime payload enum
];

export interface RawHit {
  line: number;
  chain: string;
}

/** Every `{chain}` / `${chain}` in `text` whose chain is a raw carrier (comment lines skipped). */
export function findRawStringSites(text: string): RawHit[] {
  // Variable aliases: `const x = <expr naming a raw carrier>;` (multi-line ok), later interpolated.
  const aliases = new Set<string>();
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=([^;]*);/g)) {
    const expr = m[2].replace(/\s+/g, "");
    // A function-valued const, or a value reduced to a boolean/extracted group through
    // match/test/includes/startsWith, is a computation, not the raw text itself. slice/replace
    // still yield raw text, so they are NOT excluded.
    if (/=>|function|\.(match|test|includes|startsWith)\(/.test(expr)) continue;
    if (
      /response\??\.data\??\.(message|error)/.test(expr) ||
      /(^|[.?])lastError\b/.test(expr) ||
      /\b(err|error|e|ex|exception)\??\.message\b/.test(expr)
    )
      aliases.add(m[1]);
  }
  const hits: RawHit[] = [];
  text.split("\n").forEach((l, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
    for (const m of l.matchAll(/\$?\{\s*([\w$?.]+)\s*\}/g)) {
      if (RAW_CARRIERS.some((r) => r.test(m[1])) || aliases.has(m[1]))
        hits.push({ line: i + 1, chain: m[1] });
    }
  });
  return hits;
}

/** Justified exceptions: file (posix, relative to apps/web) + chain + a reason that says WHY it is safe. */
export const ALLOWLIST: Array<{ file: string; chain: string; reason: string }> = [
  {
    file: "components/ScanInvoiceModal.tsx",
    chain: "active.error",
    reason:
      "per-invoice error state is only ever set to the closed SCAN_FAILED_COPY / RECORDS_FAILED_COPY sentences from lib/reason-copy.ts, never to server text",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(WEB_ROOT, d)));
const rel = (f: string) => path.relative(WEB_ROOT, f).split(path.sep).join("/");

describe("findRawStringSites — planted-fixture pins (#1965)", () => {
  it("flags a raw lastError in JSX text, an attribute and a template literal", () => {
    expect(findRawStringSites("<p>{ri.lastError}</p>").map((h) => h.chain)).toEqual([
      "ri.lastError",
    ]);
    expect(findRawStringSites("<p title={ri.lastError}>x</p>")).toHaveLength(1);
    expect(findRawStringSites("const s = `${ri.lastError} - retry`;")).toHaveLength(1);
  });

  it("flags axios/react-query error messages and provider error fields", () => {
    expect(findRawStringSites("<p>{createOperator.error.message}</p>")).toHaveLength(1);
    expect(findRawStringSites("<p>{err.message}</p>")).toHaveLength(1);
    expect(findRawStringSites("<p>{err?.response?.data?.message}</p>")).toHaveLength(1);
    expect(findRawStringSites("x {success.welcomeEmail.error} y")).toHaveLength(1);
  });

  it("flags the variable-alias shape: a const assigned from a raw carrier, then interpolated (review B2)", () => {
    const src = [
      "const rmsg =",
      "  (receiveErr as { response?: { data?: { message?: string } } })?.response?.data",
      "    ?.message ?? 'fallback';",
      "notes.push(`Vendor bill ${rmsg}`);",
    ].join("\n");
    expect(findRawStringSites(src).map((h) => h.chain)).toEqual(["rmsg"]);
    expect(
      findRawStringSites("const m = err.message;\nreturn <p>{m}</p>;").map((h) => h.chain),
    ).toEqual(["m"]);
  });

  it("flags an alias derived through slice/replace (truncating or rewriting raw text is still raw text)", () => {
    expect(
      findRawStringSites("const m = err.message.slice(0, 200);\nreturn <p>{m}</p>;").map(
        (h) => h.chain,
      ),
    ).toEqual(["m"]);
    expect(
      findRawStringSites("const t = err.message.replace(/x/g, '');\nreturn <p>{t}</p>;").map(
        (h) => h.chain,
      ),
    ).toEqual(["t"]);
  });

  it("does not flag an alias that is only tested or logged, never interpolated", () => {
    const src =
      'const msg: string = err?.response?.data?.message ?? "";\nconst bad = /api key/i.test(msg);';
    expect(findRawStringSites(src)).toHaveLength(0);
  });

  it("flags the realtime payload reason and the scan-modal active.error shapes", () => {
    expect(findRawStringSites("description: `${data.customerName} - ${data.reason}`")).toHaveLength(
      1,
    );
    expect(findRawStringSites("<p>{data.reason}</p>")).toHaveLength(1);
    expect(findRawStringSites('<p className="x">{active.error}</p>')).toHaveLength(1);
  });

  it("does not flag mapped copy, function calls, comments, or app-authored validation state", () => {
    expect(findRawStringSites("<p>{describeRunFailure(ri.lastError).text}</p>")).toHaveLength(0);
    expect(findRawStringSites("<p>{nameError}</p><p>{errors.slug.message}</p>")).toHaveLength(0);
    expect(findRawStringSites("// <p>{ri.lastError}</p>")).toHaveLength(0);
    expect(findRawStringSites(" * {ri.lastError} in a doc comment")).toHaveLength(0);
  });
});

describe("no raw API/provider strings in the UI (#1965)", () => {
  it("walks a non-trivial tree (an empty scan must not report green)", () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  it("REG-1965: every raw-carrier interpolation is on the allow-list with a reason", () => {
    const violations: string[] = [];
    for (const f of FILES) {
      for (const h of findRawStringSites(fs.readFileSync(f, "utf8"))) {
        const ok = ALLOWLIST.some((a) => a.file === rel(f) && a.chain === h.chain);
        if (!ok) violations.push(`${rel(f)}:${h.line} renders raw {${h.chain}}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("every allow-list entry carries a real reason and still matches a hit (no stale entries)", () => {
    for (const a of ALLOWLIST) {
      expect(a.reason.length).toBeGreaterThan(40);
      const file = path.join(WEB_ROOT, a.file);
      expect(fs.existsSync(file)).toBe(true);
      const hit = findRawStringSites(fs.readFileSync(file, "utf8")).some(
        (h) => h.chain === a.chain,
      );
      expect(hit).toBe(true);
    }
  });
});
