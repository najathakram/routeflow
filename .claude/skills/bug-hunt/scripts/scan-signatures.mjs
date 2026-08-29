#!/usr/bin/env node
/**
 * scan-signatures.mjs — RouteFlow empirical bug-signature scanner.
 *
 * Greps the monorepo for the bug patterns that produced REAL confirmed findings
 * (see .claude/skills/bug-hunt/references/bug-signatures.md for the catalogue).
 * Zero dependencies — node:fs + node:path only. Meant as an EARLY-WARNING pass
 * before a PR and in CI; every pattern here has caused at least one shipped bug.
 *
 * Usage:
 *   node .claude/skills/bug-hunt/scripts/scan-signatures.mjs [options]
 *
 * Options:
 *   --only <id,id>   Run only the named signatures (also unlocks noisy-excluded ones).
 *   --json           Emit machine-readable JSON instead of the grouped report.
 *   --verbose        Print suppressed hits and per-pattern timing too.
 *   --max <n>        Cap printed hits per pattern (default 40; JSON is never capped).
 *   --list           List all signature ids and exit.
 *   --help           This text.
 *
 * Exit codes:
 *   0  clean, or only medium-signal patterns hit
 *   1  at least one HIGH-signal pattern has an unsuppressed hit (CI can gate on this)
 *   2  usage / internal error
 *
 * Suppression:
 *   - Inline: put `// scan-ok: <id> — <reason>` on the line ABOVE a hit.
 *   - Baseline: .claude/skills/bug-hunt/scan-ignore.json = { "<id>": ["path/substring", ...] }
 *     A hit whose repo-relative path contains any listed substring for that id is suppressed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..");
const IGNORE_FILE = path.join(SCRIPT_DIR, "..", "scan-ignore.json");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".expo",
  ".git",
  ".turbo",
  "android",
  "ios",
  ".claude",
  "generated",
  "playwright-report",
  "test-results",
  "local-assets",
]);
const EXTS = new Set([".ts", ".tsx"]);

// ---------------------------------------------------------------- file corpus

/** @typedef {{abs:string, rel:string, text:string, lines:string[], app:string}} F */

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (!EXTS.has(ext)) continue;
      out.push(path.join(dir, e.name));
    }
  }
}

function loadCorpus() {
  const paths = [];
  for (const top of ["apps", "packages"]) walk(path.join(ROOT, top), paths);
  /** @type {F[]} */
  const files = [];
  for (const abs of paths) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    let text;
    try {
      const st = fs.statSync(abs);
      if (st.size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const app = rel.startsWith("apps/api/")
      ? "api"
      : rel.startsWith("apps/web/")
        ? "web"
        : rel.startsWith("apps/mobile/")
          ? "mobile"
          : rel.startsWith("packages/")
            ? "packages"
            : "other";
    files.push({ abs, rel, text, lines: text.split(/\r?\n/), app });
  }
  return files;
}

const isTestFile = (rel) =>
  /\.(spec|test)\.tsx?$/.test(rel) || /\/(e2e|__tests__|__mocks__)\//.test(rel);

// ---------------------------------------------------------------- helpers

/** 1-based line number of a char offset. */
function lineAt(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

/**
 * Capture a balanced call span starting at the '(' at openIdx.
 * String/template-literal aware; returns the text inside (and including) the parens.
 */
function captureCall(text, openIdx, maxLen = 4000) {
  let depth = 0;
  let i = openIdx;
  const end = Math.min(text.length, openIdx + maxLen);
  while (i < end) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < end && text[i] !== q) {
        if (text[i] === "\\") i++;
        i++;
      }
    } else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
    i++;
  }
  return text.slice(openIdx, end);
}

/** Capture a balanced {...} span starting at openIdx (a '{'). */
function captureBraces(text, openIdx, maxLen = 6000) {
  let depth = 0;
  let i = openIdx;
  const end = Math.min(text.length, openIdx + maxLen);
  while (i < end) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < end && text[i] !== q) {
        if (text[i] === "\\") i++;
        i++;
      }
    } else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
    i++;
  }
  return text.slice(openIdx, end);
}

const trimHit = (s) => s.trim().slice(0, 120);

function hit(f, lineNo, note) {
  return { file: f.rel, line: lineNo, text: trimHit(f.lines[lineNo - 1] ?? ""), note };
}

// ---------------------------------------------------------------- signatures
//
// Each: { id, name, why, register:[], severity, signal, run(ctx) => hits }
// signal: "high" (gates CI) | "medium" | "noisy-excluded" (only runs via --only)

const SIGNATURES = [];

// ---- 1. DEAD BACKEND CAPABILITY -------------------------------------------
SIGNATURES.push({
  id: "dead-hook",
  name: "Dead backend capability (exported API hook with zero call sites)",
  why: "A built+tested server feature the UI never wired up — users can't reach it.",
  register: ["B13", "B21", "B29", "B36", "B37", "B41", "B42"],
  severity: "high",
  signal: "high",
  run(ctx) {
    const hits = [];
    const defs = []; // { name, f, lineNo }
    for (const f of ctx.files) {
      if (!/^apps\/(web|mobile)\/lib\/api\/[^/]+\.tsx?$/.test(f.rel)) continue;
      const re = /export (?:function|const) (use[A-Z]\w*)/g;
      let m;
      while ((m = re.exec(f.text))) defs.push({ name: m[1], f, lineNo: lineAt(f.text, m.index) });
    }
    // Group by name — the same hook name may exist in both apps; a caller in
    // EITHER app means the capability is alive (B13/B24 correction).
    const byName = new Map();
    for (const d of defs) {
      if (!byName.has(d.name)) byName.set(d.name, []);
      byName.get(d.name).push(d);
    }
    for (const [name, defList] of byName) {
      const defFiles = new Set(defList.map((d) => d.f.rel));
      const re = new RegExp(`\\b${name}\\b`);
      let used = false;
      for (const f of ctx.files) {
        if (f.app !== "web" && f.app !== "mobile") continue;
        if (isTestFile(f.rel)) continue;
        if (!re.test(f.text)) continue;
        if (!defFiles.has(f.rel)) {
          used = true;
          break;
        }
        // Same file: any non-comment reference besides the export line counts.
        for (let i = 0; i < f.lines.length; i++) {
          const ln = f.lines[i];
          if (!re.test(ln)) continue;
          const t = ln.trim();
          if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
          if (new RegExp(`export (?:function|const) ${name}\\b`).test(ln)) continue;
          used = true;
          break;
        }
        if (used) break;
      }
      if (!used) {
        for (const d of defList) hits.push(hit(d.f, d.lineNo, `no caller in web OR mobile`));
      }
    }
    return hits;
  },
});

// ---- 2. CONFIRM-THEN-NAVIGATE ---------------------------------------------
SIGNATURES.push({
  id: "confirm-navigate",
  name: "Confirm dialog whose accept action only navigates",
  why: "The user confirms a state change but only the screen changes — nothing is recorded.",
  register: ["B34"],
  severity: "high",
  signal: "high",
  run(ctx) {
    const hits = [];
    for (const f of ctx.files) {
      if (f.app !== "mobile" && f.app !== "web") continue;
      if (isTestFile(f.rel)) continue;
      const re = /\b(confirm|Alert\.alert)\s*\(/g;
      let m;
      while ((m = re.exec(f.text))) {
        const span = captureCall(f.text, m.index + m[0].length - 1);
        // accept-callback is a bare navigation…
        if (!/\(\s*\)\s*=>\s*\{?\s*(void\s+)?router\.(replace|push|back)\s*\(/.test(span)) continue;
        // …and nothing in the dialog mutates anything.
        if (
          /mutate|mutateAsync|apiClient|axios|fetch\s*\(|\.post\(|\.patch\(|\.put\(|\.delete\(|dispatch\(|set[A-Z]\w*\(/.test(
            span,
          )
        )
          continue;
        // Legit navigate-only dialogs: discard/leave prompts and "continue where
        // you were" prompts — the state change already happened (or is being
        // intentionally thrown away).
        if (
          /discard|unsaved|will be lost|lose (your|these|this)|stay in app|continue in|leave (this|the) (page|screen)/i.test(
            span,
          )
        )
          continue;
        hits.push(hit(f, lineAt(f.text, m.index), "confirm accepts, then only navigates"));
      }
    }
    return hits;
  },
});

// ---- 3. IMPOSSIBLE ENUM BRANCH --------------------------------------------
SIGNATURES.push({
  id: "impossible-enum",
  name: "UI branch on a status/type string the server never emits",
  why: "The branch is dead — its UI state can never appear (or masks the real value).",
  register: ["B10", "B16", "B18"],
  severity: "medium",
  signal: "medium",
  run(ctx) {
    // Server vocabulary: every SCREAMING_CASE token in schema.prisma + apps/api/src.
    const server = new Set();
    const collect = (text) => {
      const re = /\b[A-Z][A-Z0-9_]{2,}\b/g;
      let m;
      while ((m = re.exec(text))) server.add(m[0]);
    };
    if (ctx.schemaText) collect(ctx.schemaText);
    for (const f of ctx.files) if (f.app === "api") collect(f.text);
    // Client-declared unions: a token that appears as a member of a client-side
    // union type is client state, not a server enum — comparing against it is
    // legitimate (e.g. routeStore's local ItemDeliveryStatus "UNRESOLVED").
    const clientUnions = new Set();
    for (const f of ctx.files) {
      if (f.app !== "web" && f.app !== "mobile" && f.app !== "packages") continue;
      const re = /["']([A-Z][A-Z0-9_]{2,})["']\s*\||\|\s*["']([A-Z][A-Z0-9_]{2,})["']/g;
      let m;
      while ((m = re.exec(f.text))) clientUnions.add(m[1] ?? m[2]);
    }
    const hits = [];
    for (const f of ctx.files) {
      if (f.app !== "web" && f.app !== "mobile") continue;
      if (isTestFile(f.rel)) continue;
      const re =
        /\.(status|state|type|paymentStatus|deliveryStatus|orderStatus|invoiceStatus)\s*[!=]==?\s*["']([A-Z][A-Z0-9_]{2,})["']/g;
      let m;
      while ((m = re.exec(f.text))) {
        if (server.has(m[2]) || clientUnions.has(m[2])) continue;
        hits.push(
          hit(
            f,
            lineAt(f.text, m.index),
            `"${m[2]}" not found anywhere in apps/api or schema.prisma`,
          ),
        );
      }
    }
    return hits;
  },
});

// ---- 4. INERT FORM ---------------------------------------------------------
SIGNATURES.push({
  id: "inert-form",
  name: "<form> with no onSubmit and no action",
  why: "Submit does nothing (or full-page reloads) — user input silently goes nowhere.",
  register: ["B06"],
  severity: "high",
  signal: "high",
  run(ctx) {
    const hits = [];
    for (const f of ctx.files) {
      if (f.app !== "web" || !f.rel.endsWith(".tsx") || isTestFile(f.rel)) continue;
      const re = /<form(?=[\s>])/g;
      let m;
      while ((m = re.exec(f.text))) {
        // Capture the opening tag: forward to the first '>' at brace-depth 0
        // that is not part of an arrow '=>'.
        let i = m.index,
          depth = 0,
          tag = null;
        const end = Math.min(f.text.length, m.index + 2000);
        while (i < end) {
          const c = f.text[i];
          if (c === "{") depth++;
          else if (c === "}") depth--;
          else if (c === ">" && depth === 0 && f.text[i - 1] !== "=") {
            tag = f.text.slice(m.index, i + 1);
            break;
          }
          i++;
        }
        if (tag === null) continue;
        if (/onSubmit\s*=/.test(tag) || /\baction\s*=/.test(tag)) continue;
        hits.push(hit(f, lineAt(f.text, m.index), "no onSubmit, no action"));
      }
    }
    return hits;
  },
});

// ---- 5. DECORATIVE ACTION LABEL -------------------------------------------
SIGNATURES.push({
  id: "decorative-label",
  name: "Action/label prop rendered as plain text with no press handler",
  why: "It looks tappable but is not — the promised action is unreachable.",
  register: ["B23"],
  severity: "medium",
  signal: "high",
  run(ctx) {
    const hits = [];
    for (const f of ctx.files) {
      if (f.app !== "mobile" || !f.rel.endsWith(".tsx") || isTestFile(f.rel)) continue;
      for (let i = 0; i < f.lines.length; i++) {
        const ln = f.lines[i];
        if (
          !/<Text\b[^>]*>\s*\{(action|actionLabel)\}\s*<\/Text>/.test(ln) &&
          !/\{(action|actionLabel)\s*\?\s*<Text\b[^>]*>\s*\{\1\}\s*<\/Text>/.test(ln)
        )
          continue;
        const around = f.lines.slice(Math.max(0, i - 4), i + 5).join("\n");
        if (/onPress|Pressable|Touchable|onAction/.test(around)) continue;
        hits.push(hit(f, i + 1, "no Pressable/onPress within 4 lines"));
      }
    }
    return hits;
  },
});

// ---- 6. MONEY RE-DERIVATION ------------------------------------------------
SIGNATURES.push({
  id: "money-rederive",
  name: "qty * unitPrice arithmetic outside pricing.ts",
  why: "Boxed lines store per-piece proration; naive multiply overcharges by unitsPerBox.",
  register: ["B49", "B50", "B60"],
  severity: "critical",
  signal: "high",
  run(ctx) {
    const hits = [];
    const re =
      /\b(?:[\w.]*\.)?(qty|quantity)\s*\*\s*(?:[\w.]*\.)?(unitPrice|price)\b|\b(?:[\w.]*\.)?(unitPrice|price)\s*\*\s*(?:[\w.]*\.)?(qty|quantity)\b/;
    for (const f of ctx.files) {
      if (f.app === "other" || isTestFile(f.rel)) continue;
      if (/(^|\/)pricing\.ts$/.test(f.rel)) continue;
      if (/\/mocks\/|prisma\/seed\.ts$/.test(f.rel)) continue; // fixture data, not billing
      for (let i = 0; i < f.lines.length; i++) {
        const ln = f.lines[i];
        if (!re.test(ln)) continue;
        const t = ln.trim();
        if (t.startsWith("//") || t.startsWith("*") || /re-derive|NEVER/.test(ln)) continue;
        const prev = f.lines[i - 1] ?? "";
        // computeLineSubtotal call sites sometimes carry an explanatory comment.
        if (/computeLineSubtotal|scan-ok/.test(ln) || /computeLineSubtotal/.test(prev)) continue;
        hits.push(hit(f, i + 1));
      }
    }
    return hits;
  },
});

// ---- 7. RAW MONEY FORMATTING ----------------------------------------------
SIGNATURES.push({
  id: "raw-tofixed",
  name: "toFixed(2) on a money value in a component",
  why: "Bypasses formatMoney — inconsistent currency display and float artefacts.",
  register: [],
  severity: "low",
  // 200+ hits: `${x.toFixed(2)}` is (for better or worse) the repo-wide display
  // idiom, so per-line reports are not actionable. Run via --only raw-tofixed
  // when doing a dedicated formatMoney migration.
  signal: "noisy-excluded",
  run(ctx) {
    const hits = [];
    const moneyish =
      /price|total|amount|balance|cost|due|paid|subtotal|tax|revenue|deposit|payout|fee|credit/i;
    for (const f of ctx.files) {
      if (!f.rel.endsWith(".tsx") || isTestFile(f.rel)) continue;
      if (f.app !== "web" && f.app !== "mobile") continue;
      if (/lib\/(format|pricing)/.test(f.rel)) continue;
      for (let i = 0; i < f.lines.length; i++) {
        const ln = f.lines[i];
        if (!ln.includes(".toFixed(2)")) continue;
        if (!moneyish.test(ln)) continue;
        if (/formatMoney|formatCurrency/.test(ln)) continue;
        hits.push(hit(f, i + 1));
      }
    }
    return hits;
  },
});

// ---- 8. CALENDAR-DATE WITH LOCAL FORMATTER --------------------------------
SIGNATURES.push({
  id: "calendar-date",
  name: "Local-timezone formatter applied to a UTC-midnight calendar date",
  why: "Negative-UTC viewers see the previous day (schedule/issue/expiry dates).",
  register: ["B91", "B59"],
  severity: "medium",
  signal: "medium",
  run(ctx) {
    const hits = [];
    // periodStart/periodEnd deliberately absent: those are real timestamps
    // (subscription instants), not UTC-midnight calendar dates.
    const dateField =
      /(scheduledDate|issueDate|dueDate|expiryDate|expiresOn|deliveryDate|invoiceDate|licen[cs]e\w*Date)/;
    for (const f of ctx.files) {
      if (f.app !== "web" && f.app !== "mobile") continue;
      if (isTestFile(f.rel)) continue;
      for (let i = 0; i < f.lines.length; i++) {
        const ln = f.lines[i];
        if (!dateField.test(ln)) continue;
        if (
          !/toLocaleDateString\(|toLocaleString\(|\.getDate\(\)|\.getDay\(\)|\.getMonth\(\)/.test(
            ln,
          )
        )
          continue;
        if (/timeZone:\s*["']UTC/.test(ln) || /formatCalendarDate|formatDateUTC/.test(ln)) continue;
        hits.push(hit(f, i + 1));
      }
    }
    return hits;
  },
});

// ---- 9. SWALLOWED WRITE FAILURE -------------------------------------------
SIGNATURES.push({
  id: "swallowed-write",
  name: "Empty/log-only catch around a DB write / payment / stock movement",
  why: "The write fails, nobody hears it — data quietly diverges from reality.",
  register: ["B83"],
  severity: "high",
  signal: "medium",
  run(ctx) {
    const hits = [];
    const writeish =
      /prisma\.|\btx\.\w+\.(create|update|upsert|delete)|payment|stockMovement|movement|invoice|refund/i;
    for (const f of ctx.files) {
      if (f.app !== "api" || isTestFile(f.rel)) continue;
      if (/\/scripts\//.test(f.rel)) continue;
      // empty catch blocks
      const reEmpty = /catch(\s*\(\s*[\w$]*\s*\))?\s*\{\s*\}/g;
      let m;
      while ((m = reEmpty.exec(f.text))) {
        const ln = lineAt(f.text, m.index);
        const before = f.lines.slice(Math.max(0, ln - 16), ln).join("\n");
        if (!writeish.test(before)) continue;
        hits.push(hit(f, ln, "empty catch after a write"));
      }
      // .catch(() => {}) / .catch(() => null) inline swallow
      const reInline = /\.catch\(\s*\(\s*[\w$]*\s*\)\s*=>\s*(\{\s*\}|null|undefined|void 0)\s*\)/g;
      while ((m = reInline.exec(f.text))) {
        const ln = lineAt(f.text, m.index);
        // the statement being caught (approx: this line + 5 lines back)
        const stmt = f.lines.slice(Math.max(0, ln - 6), ln).join("\n");
        if (!writeish.test(stmt)) continue;
        // best-effort side channels are legitimately fire-and-forget
        if (
          /notifications|sendTo|email|mail\b|storage\.|presignedUrl|audit|push|toast|logger/i.test(
            stmt,
          )
        )
          continue;
        // an explicit best-effort comment right above is an accepted decision
        const comment = f.lines.slice(Math.max(0, ln - 10), ln).join("\n");
        if (/best-effort|fire-and-forget|non-critical|advisory/i.test(comment)) continue;
        hits.push(hit(f, ln, "swallowed failure on/near a write — verify it is safe to lose"));
      }
    }
    return hits;
  },
});

// ---- 10. UNIMPORTED COMPONENT ---------------------------------------------
SIGNATURES.push({
  id: "unimported-component",
  name: "Component file nothing imports",
  why: "Built UI that never renders — a feature someone believes shipped.",
  register: ["B31"],
  severity: "medium",
  signal: "high",
  run(ctx) {
    const hits = [];
    for (const f of ctx.files) {
      if (!f.rel.endsWith(".tsx") || isTestFile(f.rel)) continue;
      const inComponents =
        /^apps\/(web|mobile)\/components\//.test(f.rel) || /\/_components\//.test(f.rel);
      if (!inComponents) continue;
      const base = path.basename(f.rel, ".tsx");
      if (base === "index") continue;
      // Platform-resolved variants (Foo.web.tsx next to Foo.tsx) are imported
      // implicitly by the bundler — never dead just because unimported.
      if (/\.(web|native|ios|android)$/.test(base)) continue;
      const needle = new RegExp(`/${base}["']`);
      const bare = new RegExp(`from\\s+["'][^"']*\\b${base}["']`);
      let used = false;
      for (const g of ctx.files) {
        if (g.rel === f.rel) continue;
        if (g.app !== f.app && g.app !== "packages") continue;
        if (needle.test(g.text) || bare.test(g.text)) {
          used = true;
          break;
        }
      }
      if (!used) hits.push(hit(f, 1, `${base}.tsx imported nowhere in apps/${f.app}`));
    }
    return hits;
  },
});

// ---- 11. HARDCODED THRESHOLD ----------------------------------------------
SIGNATURES.push({
  id: "hardcoded-threshold",
  name: "Magic-number threshold shadowing a configurable per-record field",
  why: "Ignores the tenant's own setting (e.g. product.reorderPoint) — wrong alerts.",
  register: ["B25"],
  severity: "low",
  signal: "medium",
  run(ctx) {
    const hits = [];
    const re = /\b[\w.]*(stock|onHand|available|inventory)\w*\s*<=?\s*(\d+)\b/i;
    for (const f of ctx.files) {
      if (f.app === "other" || isTestFile(f.rel)) continue;
      for (let i = 0; i < f.lines.length; i++) {
        const t = f.lines[i].trim();
        if (t.startsWith("//") || t.startsWith("*")) continue;
        const m = f.lines[i].match(re);
        if (!m) continue;
        const n = Number(m[2]);
        if (n < 2) continue; // <= 0 / < 1 are emptiness checks, not thresholds
        if (/reorderPoint|threshold|config|setting/i.test(f.lines[i])) continue;
        hits.push(hit(f, i + 1, `compares against literal ${n}; is there a per-record field?`));
      }
    }
    return hits;
  },
});

// ---- 12. FETCH-CAP + CLIENT AGGREGATE -------------------------------------
SIGNATURES.push({
  id: "fetch-cap-aggregate",
  name: "Capped list fetch whose result is reduce()'d into a KPI",
  why: "The aggregate silently excludes rows past the cap — numbers wrong at scale.",
  register: ["B12"],
  severity: "medium",
  signal: "medium",
  run(ctx) {
    const hits = [];
    for (const f of ctx.files) {
      if (f.app !== "web" && f.app !== "mobile") continue;
      if (isTestFile(f.rel) || /\/lib\/api\//.test(f.rel)) continue;
      if (!/\.reduce\(/.test(f.text)) continue;
      const reduceLines = [];
      for (let i = 0; i < f.lines.length; i++)
        if (/\.reduce\(/.test(f.lines[i])) reduceLines.push(i + 1);
      const re = /limit:\s*(\d+)/g;
      let m;
      while ((m = re.exec(f.text))) {
        const n = Number(m[1]);
        // 50-ish limits are dropdown fills; the fetch-"all" sentinels (100/200/999)
        // feeding an aggregate are the B12 shape. Require a reduce nearby so the
        // limit and the aggregate are plausibly the same data.
        if (n < 90) continue;
        const ln = lineAt(f.text, m.index);
        const t = (f.lines[ln - 1] ?? "").trim();
        if (t.startsWith("//") || t.startsWith("*")) continue;
        if (!reduceLines.some((r) => Math.abs(r - ln) <= 60)) continue;
        hits.push(hit(f, ln, `limit ${n} with a client-side reduce() within 60 lines`));
      }
    }
    return hits;
  },
});

// ---- 13. COMING-SOON PLACEHOLDER ------------------------------------------
SIGNATURES.push({
  id: "coming-soon",
  name: "Screen shipping a hardcoded coming-soon empty state",
  why: "Nav routes users into a dead end that demos badly and erodes trust.",
  register: ["B07", "B37", "B38", "B39", "B43"],
  severity: "medium",
  signal: "medium",
  run(ctx) {
    const hits = [];
    const re =
      /coming soon|isn'?t live yet|not live yet|isn'?t ready yet|isn'?t wired up|placeholder screen/i;
    for (const f of ctx.files) {
      if (f.app !== "web" && f.app !== "mobile") continue;
      if (isTestFile(f.rel) || !/\/(app|components)\//.test(f.rel)) continue;
      // Marketing pages announcing the app launch are intentional copy.
      if (/\(marketing\)/.test(f.rel)) continue;
      for (let i = 0; i < f.lines.length; i++) {
        const ln = f.lines[i];
        if (!re.test(ln)) continue;
        const t = ln.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        hits.push(hit(f, i + 1));
      }
    }
    return hits;
  },
});

// ---- 14. UNSCOPED TENANT QUERY --------------------------------------------
SIGNATURES.push({
  id: "unscoped-tenant",
  name: "Prisma query on a tenant-scoped model without tenantId",
  why: "Cross-tenant read/write — the security class behind the findUnique-echo fixes.",
  register: ["B52"],
  severity: "high",
  // ~300 hits even restricted to writes: the codebase idiom is fetch-tenant-scoped
  // then write by unique id (often inside a tx), which a grep cannot distinguish
  // from a genuine cross-tenant hole. Run via --only unscoped-tenant for a
  // dedicated #446-class security audit, module by module.
  signal: "noisy-excluded",
  run(ctx) {
    const hits = [];
    // Which client properties are tenant-scoped?
    const scoped = new Set();
    if (ctx.schemaText) {
      const re = /model\s+(\w+)\s*\{([^]*?)\n\}/g;
      let m;
      while ((m = re.exec(ctx.schemaText))) {
        if (/^\s*tenantId\s/m.test(m[2])) {
          const n = m[1];
          scoped.add(n[0].toLowerCase() + n.slice(1));
        }
      }
    }
    for (const f of ctx.files) {
      if (f.app !== "api" || isTestFile(f.rel)) continue;
      if (/\/scripts\/|prisma\/seed\.ts$/.test(f.rel)) continue;
      // Identity/platform modules legitimately operate across tenants
      // (login by unique token, platform-admin console, tenant bootstrap).
      if (/\/(auth|platform-admin|tenant|tenants|billing|users)\//.test(f.rel)) continue;
      // WRITES only: fetch-by-unique-id-then-verify is the read idiom here, but a
      // raw update/delete without tenantId is the cross-tenant echo class (#446).
      const re = /\b(?:prisma|tx)\.(\w+)\.(update|delete|updateMany|deleteMany)\s*\(/g;
      let m;
      while ((m = re.exec(f.text))) {
        if (!scoped.has(m[1])) continue;
        const span = captureCall(f.text, m.index + m[0].length - 1);
        if (/tenantId/.test(span)) continue;
        const ln = lineAt(f.text, m.index);
        // fetched-then-verified idiom: an ownership check just above/below
        const around = f.lines.slice(Math.max(0, ln - 20), ln + 8).join("\n");
        if (/tenantId/.test(around) || /forTenant\(/.test(around)) continue;
        hits.push(
          hit(f, ln, `${m[1]}.${m[2]} without tenantId (and none nearby) — cross-tenant write?`),
        );
      }
    }
    return hits;
  },
});

// ---- 15. MESSAGE POINTING AT NOTHING --------------------------------------
SIGNATURES.push({
  id: "phantom-copy",
  name: "Copy directing users to a screen/control that may not exist",
  why: "Support burden + trust damage; the promised control was never built.",
  register: ["B05", "B42"],
  severity: "low",
  signal: "medium",
  run(ctx) {
    const hits = [];
    const re =
      /(in|from|via) the web (portal|dashboard|app)|configured (in|on) the web|in Settings ?[→>]|add a rate in/i;
    for (const f of ctx.files) {
      if (f.app !== "mobile" && f.app !== "web") continue;
      if (isTestFile(f.rel)) continue;
      for (let i = 0; i < f.lines.length; i++) {
        const ln = f.lines[i];
        if (!re.test(ln)) continue;
        const t = ln.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        hits.push(hit(f, i + 1, "verify the referenced screen/control exists"));
      }
    }
    return hits;
  },
});

// ---- 16. EDIT-FORM OMISSION (heuristic — needs human confirmation) --------
SIGNATURES.push({
  id: "edit-form-omission",
  name: "Edit modal with item rows whose submit payload omits the items",
  why: "Editing drops child data (B09: standing-order edit lost its items).",
  register: ["B09"],
  severity: "high",
  signal: "noisy-excluded",
  run(ctx) {
    const hits = [];
    for (const f of ctx.files) {
      if (f.app !== "web" && f.app !== "mobile") continue;
      if (!/Edit\w*Modal|\w+OrderModal/.test(path.basename(f.rel))) continue;
      if (!/\bitems\b/.test(f.text)) continue;
      const re = /\bmutate(?:Async)?\s*\(\s*\{/g;
      let m;
      while ((m = re.exec(f.text))) {
        const span = captureBraces(f.text, m.index + m[0].length - 1);
        if (/\bitems\b/.test(span)) continue;
        hits.push(
          hit(f, lineAt(f.text, m.index), "mutation payload has no items key — verify manually"),
        );
      }
    }
    return hits;
  },
});

// ---- 17. VALIDATION ASYMMETRY ---------------------------------------------
SIGNATURES.push({
  id: "validation-asymmetry",
  name: "Client zod length rule differs from server DTO rule for the same field",
  why: "Client accepts what the server rejects (opaque 400) or vice-versa.",
  register: ["B03"],
  severity: "medium",
  signal: "medium",
  run(ctx) {
    // server: @MinLength(n)/@MaxLength(n) decorator → next field name
    const server = new Map(); // field -> {min?, max?, file, line}
    for (const f of ctx.files) {
      if (f.app !== "api" || isTestFile(f.rel)) continue;
      const re = /@(MinLength|MaxLength)\((\d+)\)[^]{0,200}?^\s*(\w+)[?!]?\s*[:!]/gm;
      let m;
      while ((m = re.exec(f.text))) {
        const field = m[3];
        const entry = server.get(field) ?? {};
        entry[m[1] === "MinLength" ? "min" : "max"] = Number(m[2]);
        entry.where = `${f.rel}:${lineAt(f.text, m.index)}`;
        server.set(field, entry);
      }
    }
    const hits = [];
    for (const f of ctx.files) {
      if (f.app !== "web" && f.app !== "mobile") continue;
      if (isTestFile(f.rel)) continue;
      const re = /^\s*(\w+):\s*z\s*\.string\(\)[^\n]*?\.(min|max)\((\d+)/gm;
      let m;
      while ((m = re.exec(f.text))) {
        const s = server.get(m[1]);
        if (!s) continue;
        const kind = m[2];
        const n = Number(m[3]);
        const sv = kind === "min" ? s.min : s.max;
        if (sv === undefined || sv === n) continue;
        hits.push(
          hit(
            f,
            lineAt(f.text, m.index),
            `client .${kind}(${n}) vs server ${kind === "min" ? "@MinLength" : "@MaxLength"}(${sv}) at ${s.where}`,
          ),
        );
      }
    }
    return hits;
  },
});

// ---- 18. MUTATION-BEFORE-TEST ---------------------------------------------
SIGNATURES.push({
  id: "mutation-before-test",
  name: "Date object mutated before the condition that reads it",
  why: "The branch tests the mutated value — condition is dead (B46 duplicated invoices daily).",
  register: ["B46"],
  severity: "high",
  signal: "medium",
  run(ctx) {
    const hits = [];
    const seen = new Set(); // dedupe: one report per (file, condition line)
    for (const f of ctx.files) {
      if (f.app === "other" || isTestFile(f.rel)) continue;
      for (let i = 0; i < f.lines.length; i++) {
        const m = f.lines[i].match(
          /\b([\w$]+)\.set(Date|Month|FullYear|Hours)\((?!\s*[\w$]+\.get)/,
        );
        if (!m) continue;
        const v = m[1];
        // only literal/constant mutations are suspicious (setDate(1)); relative
        // arithmetic like setDate(getDate()+1) is normal date walking
        if (!new RegExp(`${v}\\.set${m[2]}\\(\\s*\\d+\\s*\\)`).test(f.lines[i])) continue;
        for (let j = i + 1; j <= Math.min(i + 5, f.lines.length - 1); j++) {
          const cond = f.lines[j];
          if (new RegExp(`if\\s*\\([^)]*\\b${v}\\.get${m[2]}\\(`).test(cond)) {
            const key = `${f.rel}:${j}`;
            if (!seen.has(key)) {
              seen.add(key);
              hits.push(
                hit(
                  f,
                  i + 1,
                  `${v}.set${m[2]}(…literal…) at :${i + 1}, then tested with get${m[2]}() at :${j + 1} — condition may be constant`,
                ),
              );
            }
            break;
          }
        }
      }
    }
    return hits;
  },
});

// ---- 19. DENOMINATION-BLIND MERGE (heuristic — needs human confirmation) --
SIGNATURES.push({
  id: "denomination-merge",
  name: "Quantities from two sources summed without box/piece reconciliation",
  why: "Boxes + pieces added as raw numbers double- or under-counts stock (B47).",
  register: ["B47"],
  severity: "high",
  signal: "noisy-excluded",
  run(ctx) {
    const hits = [];
    const re = /\b[\w.]*(quantity|qty)\w*\s*\+\s*[\w.]*(quantity|qty)\b/i;
    for (const f of ctx.files) {
      if (f.app === "other" || isTestFile(f.rel)) continue;
      if (/(^|\/)pricing\.ts$/.test(f.rel)) continue;
      if (!/unitsPerBox|boxes|pieces/i.test(f.text)) continue; // only boxed-aware modules
      for (let i = 0; i < f.lines.length; i++) {
        if (!re.test(f.lines[i])) continue;
        if (/normalizeBoxesPieces/.test(f.lines[i])) continue;
        hits.push(hit(f, i + 1, "are both sides in the same unit (boxes vs pieces)?"));
      }
    }
    return hits;
  },
});

// ---- 20. GUARD ON A DEAD MODEL --------------------------------------------
SIGNATURES.push({
  id: "dead-model-guard",
  name: "Safety check reading a model nothing writes",
  why: "The guard always passes/fails the same way — protection that protects nothing (B54).",
  register: ["B54"],
  severity: "medium",
  signal: "medium",
  run(ctx) {
    const reads = new Map(); // model -> [{f, lineNo}]
    const writes = new Set();
    const nested = new Set(); // models plausibly written via nested create (relation field names)
    for (const f of ctx.files) {
      if (f.app !== "api" || isTestFile(f.rel)) continue;
      // Writes: scan a normalized copy where `.forTenant()\n  .model.op(` chains
      // are joined, so the tenant-scoped client's writes count too (missing this
      // faked systemConfig/invoiceScan as write-less in the first tuning run).
      const norm = f.text.replace(/forTenant\((?:[^)]*)\)\s*\.\s*/g, "forTenant().");
      // ANY receiver counts as a write (`db.messageThread.create` where
      // `db = prisma.forTenant()` — aliased clients faked messageThread as
      // write-less in the second tuning run). Overcounting writes only ever
      // REMOVES hits, so the loose receiver is the safe direction.
      const reW =
        /\b[\w$)\]]+\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;
      let m;
      while ((m = reW.exec(norm))) if (m[1] !== "forTenant") writes.add(m[1]);
      // Reads: original text (accurate line numbers); multi-line forTenant read
      // chains may be missed, which only under-reports — safe for this pattern.
      const reR =
        /\b(?:prisma|tx|forTenant\(\))\.(\w+)\.(findUnique|findFirst|findMany|count|aggregate|groupBy)\s*\(/g;
      while ((m = reR.exec(f.text))) {
        const model = m[1];
        if (model === "forTenant") continue;
        if (!reads.has(model)) reads.set(model, []);
        reads.get(model).push({ f, lineNo: lineAt(f.text, m.index) });
      }
    }
    // Nested writes: `<relationField>: { create` / createMany — map relation field to model
    if (ctx.schemaText) {
      const relRe = /^\s*(\w+)\s+(\w+)\[\]/gm; // listField Model[]
      let m;
      const fieldToModel = new Map();
      while ((m = relRe.exec(ctx.schemaText))) {
        const model = m[2];
        fieldToModel.set(m[1], model[0].toLowerCase() + model.slice(1));
      }
      for (const f of ctx.files) {
        if (f.app !== "api") continue;
        for (const [field, model] of fieldToModel) {
          if (writes.has(model)) continue;
          if (
            new RegExp(
              `\\b${field}\\s*:\\s*\\{\\s*(create|createMany|upsert|update|deleteMany|set)\\b`,
            ).test(f.text)
          ) {
            nested.add(model);
          }
        }
      }
    }
    const hits = [];
    for (const [model, sites] of reads) {
      if (writes.has(model) || nested.has(model)) continue;
      // skip infra-ish models (migrations table etc.) and $-methods
      if (model.startsWith("$")) continue;
      for (const s of sites.slice(0, 3)) {
        hits.push(
          hit(
            s.f,
            s.lineNo,
            `model "${model}" is read here but never written anywhere in apps/api`,
          ),
        );
      }
    }
    return hits;
  },
});

// ---------------------------------------------------------------- runner

function parseArgs(argv) {
  const args = { only: null, json: false, verbose: false, max: 40, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only")
      args.only = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--json") args.json = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--max") args.max = Number(argv[++i]) || 40;
    else if (a === "--list") args.list = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function loadBaseline() {
  try {
    const raw = fs.readFileSync(IGNORE_FILE, "utf8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    console.log(
      src
        .split("*/")[0]
        .replace(/^\/\*\*?/, "")
        .replace(/^ \* ?/gm, ""),
    );
    process.exit(0);
  }
  if (args.list) {
    for (const s of SIGNATURES) console.log(`${s.id.padEnd(24)} [${s.signal}] ${s.name}`);
    process.exit(0);
  }
  if (args.only) {
    const known = new Set(SIGNATURES.map((s) => s.id));
    for (const id of args.only)
      if (!known.has(id)) {
        console.error(`unknown signature id: ${id} (use --list)`);
        process.exit(2);
      }
  }

  const files = loadCorpus();
  let schemaText = null;
  try {
    schemaText = fs.readFileSync(path.join(ROOT, "apps/api/prisma/schema.prisma"), "utf8");
  } catch {}
  const ctx = { files, schemaText };
  const baseline = loadBaseline();

  const active = SIGNATURES.filter((s) =>
    args.only ? args.only.includes(s.id) : s.signal !== "noisy-excluded",
  );

  const results = [];
  for (const sig of active) {
    const t0 = Date.now();
    let hits = [];
    try {
      hits = sig.run(ctx);
    } catch (e) {
      console.error(`signature ${sig.id} crashed: ${e.stack}`);
      process.exitCode = 2;
      continue;
    }
    const suppressed = [];
    const kept = [];
    const base = (baseline[sig.id] ?? []).map((p) => String(p).replace(/\\/g, "/"));
    for (const h of hits) {
      const f = files.find((x) => x.rel === h.file);
      const above = f?.lines[h.line - 2] ?? "";
      const inline =
        new RegExp(`scan-ok:\\s*${sig.id}\\b`).test(above) ||
        new RegExp(`scan-ok:\\s*${sig.id}\\b`).test(f?.lines[h.line - 1] ?? "");
      // A baseline entry is either "path/fragment" (whole file — coarse) or
      // "path/fragment::matched text" (that one occurrence only). Prefer the second:
      // a file-level entry also hides NEW hits later added to the same file.
      const inBase = base.some((p) => {
        const sep = p.indexOf("::");
        if (sep === -1) return h.file.includes(p);
        return (
          h.file.includes(p.slice(0, sep)) && (h.text ?? "").trim() === p.slice(sep + 2).trim()
        );
      });
      if (inline || inBase) suppressed.push({ ...h, via: inline ? "inline" : "baseline" });
      else kept.push(h);
    }
    kept.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    results.push({ sig, hits: kept, suppressed, ms: Date.now() - t0 });
  }

  const gate = results.some((r) => r.sig.signal === "high" && r.hits.length > 0);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          root: ROOT,
          exitCode: gate ? 1 : 0,
          signatures: results.map((r) => ({
            id: r.sig.id,
            name: r.sig.name,
            severity: r.sig.severity,
            signal: r.sig.signal,
            register: r.sig.register,
            hitCount: r.hits.length,
            hits: r.hits,
            suppressed: r.suppressed,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    let totalHits = 0;
    for (const r of results) {
      if (r.hits.length === 0 && !args.verbose) continue;
      totalHits += r.hits.length;
      const tag = r.sig.signal === "high" ? "HIGH-SIGNAL" : r.sig.signal.toUpperCase();
      console.log(`\n■ ${r.sig.id} — ${r.sig.name}`);
      console.log(`  ${r.sig.why}`);
      console.log(
        `  register: ${r.sig.register.join(", ") || "—"} | severity: ${r.sig.severity} | ${tag} | ${r.hits.length} hit(s)` +
          (r.suppressed.length ? ` | ${r.suppressed.length} suppressed` : "") +
          (args.verbose ? ` | ${r.ms}ms` : ""),
      );
      for (const h of r.hits.slice(0, args.max)) {
        console.log(`    ${h.file}:${h.line}  ${h.text}${h.note ? `  [${h.note}]` : ""}`);
      }
      if (r.hits.length > args.max)
        console.log(`    … ${r.hits.length - args.max} more (use --max)`);
      if (args.verbose)
        for (const s of r.suppressed) {
          console.log(`    (suppressed via ${s.via}) ${s.file}:${s.line}`);
        }
    }
    console.log(
      `\n${totalHits} hit(s) across ${results.filter((r) => r.hits.length).length} signature(s); scanned ${files.length} files.`,
    );
    console.log(
      gate
        ? "EXIT 1 — a HIGH-signal pattern hit; triage before merging (suppress with // scan-ok: <id> — reason)."
        : "EXIT 0 — no high-signal hits.",
    );
  }
  process.exit(process.exitCode === 2 ? 2 : gate ? 1 : 0);
}

main();
