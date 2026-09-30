#!/usr/bin/env node
// route-task.mjs
//
// Scores a task description against ROUTING-PLAN.md §2 (breadth / risk /
// boundedness / novelty / verifiability) and prints a routing recommendation:
// which engine to use (light-loop / bug-pipeline / dev-pipeline / workflow),
// whether "ultracode" (Fable ultrathink framing) is warranted, and a per-role
// model@effort assignment. Built for skills-build-brief-2026-09-10.md §1 as
// the UserPromptSubmit hook's advisor.
//
// No dependencies. Node >= 18. ES module. Never calls a model, never runs
// tests, never writes anything outside a selftest temp dir.
//
// Usage:
//   node route-task.mjs "<task text>" [--files a.ts,b.ts,...] [--project <dir>]
//       [--session-id <sid>] [--json] [--explain]
//   echo '{"prompt":"<task text>","files":["a.ts"],"session_id":"<sid>"}' | \
//       node route-task.mjs
//       (UserPromptSubmit hook shape -- stdin JSON, `prompt` field is the task
//        text, `session_id` feeds the Part C 2026-09-12 approach pin/rotation
//        below; used automatically when no positional task text is given and
//        stdin is not a TTY)
//   node route-task.mjs selftest
//   node route-task.mjs --help
//
// Modes:
//   (default)   "--advise" mode: a single line <= 400 bytes --
//               "Route: <engine> · Ultracode: ON|OFF — <reason> · Roles: role=model@effort ..."
//               This is what the hook prints for context injection.
//   --json      the full routing object (scores, roles, scorecard overrides).
//   --explain   appends a human-readable score breakdown after the normal
//               output (or, combined with nothing else, just the breakdown).
//
// A prompt classified as conversational (a short ack, or a short phrase with
// no verb of change -- "is this done?", "yes", "go ahead") prints NOTHING and
// exits 0, so the hook stays silent instead of narrating routing for every
// chat turn. --json/--explain override that (debugging aid) and still show
// the classification.
//
// Question routing (P3, owner ruling 2026-09-11): a task is routed as a
// question -- same silent quiet path, no engine dispatch -- when it is either
// question-shaped (starts with a question word or ends in "?") or hits a
// QUESTION_VERB (review/audit/investigate/analyze/assess/evaluate/explain/
// summarize/compare/inventory/retrieve/list), AND carries zero VERB_OF_CHANGE
// hits -- with no word-count gate. This is evaluated AFTER the bug-signal
// check, so a bug reported as a question ("why does checkout crash?") still
// reaches bug-pipeline instead of going quiet.
//
// This script only ever reads:
//   - the task text (argv or stdin JSON)
//   - --files paths (existence checks only -- never file contents)
//   - <project>/.claude/lessons/LESSONS-DIGEST.md (novelty: known lessons)
//   - <project>/.claude/pipeline/**/fix-cards/* (novelty: filenames only)
//   - <project>/package.json, jest.config.* (verifiability)
//   - <project>/.claude/approach.json (Part C 2026-09-12: the approach pin
//     written by approach.mjs next -- see decideApproach below)
//   - <project>/.claude/pipeline/approach-rotation.json (rotation state)
//   - best-effort: shells out to pipeline-ledger.mjs summary --json --project
//     <dir> (sibling script) to look for a `routingScorecard`; any failure
//     (missing script, bad JSON, timeout) is swallowed and just means "no
//     override available" -- this never throws and never blocks routing.
//   - a temp directory under os.tmpdir() (selftest only)
// and writes only <project>/.claude/pipeline/approach-rotation.json, and only
// when a fresh (unpinned, not-yet-logged) session's task lands on the
// rotation branch of decideApproach -- see the Part C 2026-09-12 addition
// below. Nothing else is ever written.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const LEDGER_SCRIPT = path.join(SCRIPT_DIR, "pipeline-ledger.mjs");

const ADVISE_BYTE_CAP = 400;

// ---------------------------------------------------------------------------
// small fs / text helpers (all best-effort; never throw)
// ---------------------------------------------------------------------------

function safeReadFile(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function safeReadJson(p) {
  const raw = safeReadFile(p);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeListDirs(p, limit = 40) {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .slice(0, limit)
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function byteLen(s) {
  return Buffer.byteLength(s, "utf8");
}

// ---------------------------------------------------------------------------
// keyword tables (ROUTING-PLAN.md §2 + brief §1)
// ---------------------------------------------------------------------------

const BREADTH_WORDS = [
  "audit", "review", "research", "migrate", "migration", "design", "compare",
  "comparison", "holistic", "thoroughly", "entire", "every", "whole", "all",
  "end-to-end", "across the codebase", "across the repo", "codebase-wide",
  "workflow", "ultracode",
];

const RISK_WORDS = [
  "money", "pricing", "price", "payment", "payments", "billing", "invoice",
  "tax", "payroll", "auth", "authentication", "authorization", "tenancy",
  "tenant", "multi-tenant", "schema", "migration", "pii", "credential",
  "credentials", "secret", "ssn", "stripe", "paypal", "ledger", "ach",
];

const RISK_PATH_PATTERNS = [
  /schema\.prisma$/i,
  /[/\\]migrations?[/\\]/i,
  /\bauth\b/i,
  /billing/i,
  /payment/i,
  /tenan(t|cy)/i,
  /\.env(\.|$)/i,
  /payroll/i,
];

const BOUNDED_WORDS = [
  "fix", "rename", "typo", "one file", "single file", "small tweak", "tiny",
  "quick fix", "one-line", "oneliner", "one liner", "hotfix", "small fix",
];

// Part C 2026-09-12: UI signal for decideApproach's "HIGH-risk or major or
// ui -> dev-pipeline standard" rule (owner ruling: a UI change earns the
// heavier local:e2e-gated arm even when otherwise small/bounded, rather than
// landing randomly on a raw/superpowers rotation slot).
const UI_WORDS = [
  "ui", "ux", "frontend", "front-end", "component", "css", "stylesheet",
  "responsive", "accessibility", "a11y", "modal", "dialog", "layout",
  "screen", "page layout", "design system", "storybook", "tailwind",
];

const BUG_ID_RE = /\b(b|bug-)\d{2,5}\b/i;
const BUG_WORDS = [
  "regression", "repro", "reproduce", "broken", "doesn't work", "does not work",
  "not working", "crash", "crashes", "crashing", "fails", "failing", "bug",
  "defect", "reverts", "stack trace", "exception", "incorrect output",
  "wrong output", "throws an error",
];

const VERB_OF_CHANGE = [
  "fix", "add", "build", "implement", "refactor", "change", "update",
  "create", "remove", "delete", "rename", "migrate", "design", "write",
  "generate", "deploy", "push", "commit", "merge", "run", "test", "debug",
  "optimize", "upgrade",
  "install", "configure", "hook", "wire", "integrate", "replace", "extend",
  "improve", "clean", "cleanup", "patch", "resolve", "adjust", "modify",
  "enable", "disable", "move", "split", "rewrite", "port", "convert",
  "make", "set up", "setup",
];

// P3: question-shaped verbs -- analysis/lookup asks that should route as a
// question (silent quiet path), not as an engine dispatch. Split out of
// VERB_OF_CHANGE (owner ruling 2026-09-11, brief B/P3): these verbs used to
// sit in VERB_OF_CHANGE, which meant an ordinary analysis question like
// "review the diff" or "audit the ledger and tell me why" always carried a
// "verb of change" hit and, combined with the old word-count gate, routed to
// an engine instead of staying quiet.
const QUESTION_VERBS = [
  "review", "audit", "investigate", "analyze", "analyse", "assess",
  "evaluate", "explain", "summarize", "summarise", "compare", "inventory",
  "retrieve", "list",
];

// head-position checks for the isQuestion fix (brief/fix conflict on the P3
// "How would you plan ... adjust ..." fixture -- design: resolve by ORDER and
// DEFINITION of the question check, not by pulling "adjust" out of
// VERB_OF_CHANGE, which stays the write-verb ground truth). The old
// QUESTION_STARTERS list (what/how/why/.../can/should/could/would/did/will/
// was/were) that used to back an unread startsWithQuestion/looksLikeQuestion
// chain is retired here -- INTERROGATIVE_LEAD plus the "?"-terminated check
// already cover every starter that mattered to a fixture, and REQUEST_LEAD
// below (not a starter list) is what actually disqualifies a request from
// reading as a question. No dead variable remains.
const INTERROGATIVE_LEAD = /^\s*(how|what|why|which|where|when|who|whether|is|are|does|do|did|should)\b/i;

// REQUEST_LEAD (authority: brief B P3 + lead ruling 2026-09-12
// engine-instrument fix round -- superseding the earlier, narrower
// "please|pls|can you|could you|would you|will you|let's" list): a REQUEST is
// any prompt whose head is one of --
//   please|pls
//   (can|could|would|will|shall|should|may) (you|we|i)
//   let's
//   we (need|should|want|have|ought) to
//   i('d| would| want|'m going) (like )?(you )?to
//   what if we
//   how about( we)?
//   why don't (we|you)
// -- optionally preceded by a bare leading "whether " (the "whether we should
// rename the field" fixture: a deliberation fragment whose head, once
// "whether" is looked past, is the "we should" shape above). When a
// REQUEST_LEAD head like this is followed -- ANYWHERE in the sentence, not
// just immediately -- by a VERB_OF_CHANGE hit, isRequestForm treats it as a
// change request exactly as an imperative would (see isQuestion below); the
// first-person-plural regression this fixed: "Can we add a caching layer to
// the router?" / "Could we refactor the invoice service?" / "Should we
// implement the new export endpoint?" / "whether we should rename the field"
// used to all fall through to isQuestion -> route=null (silent) even though
// each carries a write verb -- only "Can you ..." (the old, narrower
// REQUEST_LEAD) used to survive as a request.
const REQUEST_LEAD =
  /^\s*(?:whether\s+)?(?:please|pls|(?:can|could|would|will|shall|should|may)\s+(?:you|we|i)|let'?s|we\s+(?:need|should|want|have|ought)(?:\s+to)?|i(?:'d|\s+would|\s+want|'m\s+going)\s+(?:like\s+)?(?:you\s+)?to|what\s+if\s+we|how\s+about(?:\s+we)?|why\s+don'?t\s+(?:we|you))\b/i;

// changeVerbAtHead: true only when the first word of the task (after an
// optional REQUEST_LEAD prefix, e.g. "can you fix ...") is itself a
// VERB_OF_CHANGE entry -- i.e. the verb of change is in IMPERATIVE (head)
// position, not merely present somewhere later in the sentence. This is what
// lets "How would you plan ... adjust ...?" read as a pure question (no
// change verb at its head) while "adjust the rounding on invoices" and "Can
// you adjust the invoice rounding?" both read as requests.
function changeVerbAtHead(text) {
  const trimmed = text.trim().replace(REQUEST_LEAD, "").trim();
  const m = trimmed.match(/^[a-z0-9-]+/i);
  if (!m) return false;
  const head = m[0].toLowerCase();
  return VERB_OF_CHANGE.some((v) => v.toLowerCase() === head);
}

// G3: a bare acknowledgement carries no task -- the hook should stay silent
// rather than route it. Matched only against the FULL trimmed/lowercased/
// punctuation-stripped text (not a substring test), so "yes" is an ack but
// "yes, and also rename the button" is not.
const ACK_SET = new Set([
  "yes", "no", "ok", "okay", "continue", "go ahead", "proceed", "looks good",
  "lgtm", "thanks", "thank you", "hmm", "sure", "next", "done", "y", "n",
]);

function stripPunctuationForAck(s) {
  return s.replace(/[!?.,;:'"()]+/g, "").trim();
}

function isAckText(taskText) {
  return ACK_SET.has(stripPunctuationForAck(taskText.trim().toLowerCase()));
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "have", "has",
  "had", "are", "was", "were", "will", "would", "should", "could", "not",
  "but", "you", "your", "our", "its", "onto", "over", "under", "then", "than",
  "when", "where", "what", "how", "why", "who", "about", "there", "their",
  "them", "just", "also", "each", "some", "more", "most", "such",
]);

function countMatches(lowerText, words) {
  let count = 0;
  const hits = [];
  for (const w of words) {
    const re = new RegExp(`\\b${escapeRe(w.toLowerCase())}\\b`, "i");
    if (re.test(lowerText)) {
      count++;
      hits.push(w);
    }
  }
  return { count, hits };
}

// finding: BUG_WORDS false-positives -- a slash-command token (e.g.
// "/bug-hunt") or the discovery phrase "bug hunt"/"bug hunting" must never
// contribute to the bug-word count (a bug hunt is discovery, not a known
// defect), and "debug"/"debugging" must never match "bug". buildBugScanText
// strips both BEFORE counting; countBugWordMatches then matches each
// BUG_WORDS entry with a LEADING word boundary only (no trailing \b) so
// plurals like "bugs"/"regressions" still count, while "debug*" (no
// boundary before "bug" -- "e" then "b" are both word chars) still cannot
// match "bug" either way.
function buildBugScanText(taskText) {
  return taskText
    .replace(/(^|[\s(])\/[\w-]+/g, "$1")
    .replace(/\bbug[- ]hunt(ing)?\b/gi, "");
}

function countBugWordMatches(lowerScanText) {
  let count = 0;
  const hits = [];
  for (const w of BUG_WORDS) {
    const re = new RegExp(`\\b${escapeRe(w.toLowerCase())}`, "i");
    if (re.test(lowerScanText)) {
      count++;
      hits.push(w);
    }
  }
  return { count, hits };
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []);
}

function significantTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && t.length >= 4);
}

// ---------------------------------------------------------------------------
// novelty: does a lesson or fix-card already cover this?
// ---------------------------------------------------------------------------

function findFixCardFiles(pipelineDir, cap = 200) {
  const out = [];
  if (!dirExists(pipelineDir)) return out;
  // Depth: <pipelineDir>/*/fix-cards/* and <pipelineDir>/fix-cards/*
  const direct = path.join(pipelineDir, "fix-cards");
  if (dirExists(direct)) {
    for (const name of safeReadFileNames(direct)) {
      out.push(path.join(direct, name));
      if (out.length >= cap) return out;
    }
  }
  for (const sub of safeListDirs(pipelineDir)) {
    const candidate = path.join(pipelineDir, sub, "fix-cards");
    if (dirExists(candidate)) {
      for (const name of safeReadFileNames(candidate)) {
        out.push(path.join(candidate, name));
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

function safeReadFileNames(dir, limit = 100) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .slice(0, limit)
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function checkNovelty(taskText, projectDir) {
  const taskTokens = new Set(significantTokens(taskText));
  if (taskTokens.size === 0) return { novel: true, matched: null };

  const digestPath = path.join(projectDir, ".claude", "lessons", "LESSONS-DIGEST.md");
  const digest = safeReadFile(digestPath);
  if (digest) {
    for (const line of digest.split(/\r?\n/)) {
      if (!line.startsWith("- L-")) continue;
      const lessonTokens = significantTokens(line);
      const overlap = lessonTokens.filter((t) => taskTokens.has(t));
      if (overlap.length >= 2) {
        const idMatch = line.match(/L-\d+/);
        return { novel: false, matched: idMatch ? idMatch[0] : "lesson" };
      }
    }
  }

  const pipelineDir = path.join(projectDir, ".claude", "pipeline");
  for (const f of findFixCardFiles(pipelineDir)) {
    const base = path.basename(f, path.extname(f)).replace(/[-_]/g, " ");
    const nameTokens = significantTokens(base);
    const overlap = nameTokens.filter((t) => taskTokens.has(t));
    if (overlap.length >= 2) {
      return { novel: false, matched: path.basename(f) };
    }
  }

  return { novel: true, matched: null };
}

// ---------------------------------------------------------------------------
// verifiability: tests dir + jest config present
// ---------------------------------------------------------------------------

const TEST_DIR_NAMES = ["tests", "__tests__", "test"];
const JEST_CONFIG_NAMES = [
  "jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs",
  "jest.config.json",
];

function checkVerifiability(projectDir) {
  let hasTestsDir = TEST_DIR_NAMES.some((n) => dirExists(path.join(projectDir, n)));
  if (!hasTestsDir) {
    outer: for (const top of safeListDirs(projectDir)) {
      for (const n of TEST_DIR_NAMES) {
        if (dirExists(path.join(projectDir, top, n))) {
          hasTestsDir = true;
          break outer;
        }
      }
    }
  }

  let hasJestConfig = JEST_CONFIG_NAMES.some((n) => fileExists(path.join(projectDir, n)));
  if (!hasJestConfig) {
    const pkg = safeReadJson(path.join(projectDir, "package.json"));
    if (
      pkg &&
      (pkg.jest ||
        (pkg.devDependencies && pkg.devDependencies.jest) ||
        (pkg.dependencies && pkg.dependencies.jest))
    ) {
      hasJestConfig = true;
    }
  }

  return { hasTestsDir, hasJestConfig, verifiable: hasTestsDir && hasJestConfig };
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

function computeScores(taskText, files, projectDir) {
  const lower = taskText.toLowerCase();
  const wordCount = taskText.trim().split(/\s+/).filter(Boolean).length;

  const breadth = countMatches(lower, BREADTH_WORDS);
  const breadthLevel = breadth.count >= 2 ? "HIGH" : breadth.count === 1 ? "MED" : "LOW";

  const riskWords = countMatches(lower, RISK_WORDS);
  const riskPathHits = files.filter((f) => RISK_PATH_PATTERNS.some((re) => re.test(f)));
  const riskLevel = riskWords.count > 0 || riskPathHits.length > 0 ? "HIGH" : "LOW";

  const boundedWords = countMatches(lower, BOUNDED_WORDS);
  const bounded = boundedWords.count > 0 || files.length === 1;

  const isBugId = BUG_ID_RE.test(taskText);
  const bugScanLower = buildBugScanText(taskText).toLowerCase();
  const bugWords = countBugWordMatches(bugScanLower);
  const isBug = isBugId || bugWords.count > 0;

  const verbHits = countMatches(lower, VERB_OF_CHANGE);
  const questionVerbHits = countMatches(lower, QUESTION_VERBS);
  // lead ruling 2026-09-12 (brief B P3 + engine-instrument fix round): the
  // REQUEST rule, evaluated before the question path below -- a REQUEST_LEAD
  // head ("can we", "let's", "whether we should", ...) is a change request,
  // not a question, when it is followed ANYWHERE in the sentence by a
  // VERB_OF_CHANGE hit (verbHits, computed over the whole text -- since the
  // lead occupies only the head, any hit found is necessarily in what follows
  // it). This is what makes "Can we add a caching layer to the router?" /
  // "Could we refactor the invoice service?" / "Should we implement the new
  // export endpoint?" / "whether we should rename the field" route as engine
  // work again instead of falling through to isQuestion -> silent -- while
  // "Can you explain how the router works?" and "should we archive the
  // marketing pack" (no write verb after the lead) still read as questions.
  const isRequestForm = REQUEST_LEAD.test(taskText) && verbHits.count > 0;
  // a question routes as a question -- no word-count gate. It's shaped like a
  // question (interrogative-led, or "?"-terminated) AND is not an
  // isRequestForm ask AND has no change verb in IMPERATIVE (head) position
  // (changeVerbAtHead) -- a change verb appearing later in the sentence
  // (e.g. "... how would you adjust our skills", no REQUEST_LEAD match since
  // "how", not a modal/pronoun/"let's"/etc., sits at the head) no longer
  // disqualifies the question read; only isRequestForm, or a change verb AT
  // THE HEAD, makes it a request. isQuestion itself is just a score;
  // decideRoute evaluates it AFTER the bug-signal check so a bug reported as
  // a question ("why does checkout crash?") still reaches bug-pipeline.
  const isQuestion =
    // interrogative-led or "?"-terminated: a change verb elsewhere in the
    // sentence no longer disqualifies it -- only isRequestForm, or a change
    // verb AT THE HEAD, makes it a request.
    ((INTERROGATIVE_LEAD.test(taskText) || /\?\s*$/.test(taskText.trim())) &&
      !isRequestForm &&
      !changeVerbAtHead(taskText)) ||
    // bare QUESTION_VERB (review/audit/retrieve/...), not itself interrogative-
    // led or "?"-terminated: unchanged from before this fix -- quiet only when
    // there is no VERB_OF_CHANGE hit anywhere in the sentence.
    (questionVerbHits.count > 0 && verbHits.count === 0);
  // G3: stay silent on a bare acknowledgement too -- either it's short with
  // no verb of change ("yes", "go ahead", "next"), or it's an exact match
  // (after trimming/lowercasing/punctuation-stripping) against the ack set.
  // (This is independent of the P3 question path above and is still checked
  // before the bug-signal check -- an ack carries no task either way.)
  const isShortNonVerb = wordCount <= 3 && verbHits.count === 0;
  const isConversational = isShortNonVerb || isAckText(taskText);

  const novelty = checkNovelty(taskText, projectDir);
  const verifiability = checkVerifiability(projectDir);

  const wideOrchestration = /\bworkflow\b|\borchestrat\w*|\bmulti-agent\b/i.test(taskText);
  const uiHits = countMatches(lower, UI_WORDS);
  const isUi = uiHits.count > 0;

  return {
    wordCount,
    breadth: { level: breadthLevel, count: breadth.count, hits: breadth.hits },
    risk: { level: riskLevel, wordHits: riskWords.hits, pathHits: riskPathHits },
    bounded: { value: bounded, hits: boundedWords.hits, fileCount: files.length },
    isBug: { value: isBug, viaId: isBugId, hits: bugWords.hits },
    isConversational,
    isRequestForm,
    isQuestion,
    novelty,
    verifiability,
    wideOrchestration,
    isUi: { value: isUi, hits: uiHits.hits },
  };
}

// ---------------------------------------------------------------------------
// route decision (Pipeline law, CLAUDE.md owner ruling 2026-09-03 + ROUTING-PLAN §2/§6)
// ---------------------------------------------------------------------------

function decideRoute(taskText, files, scores) {
  if (scores.isConversational) {
    return { route: null, reason: "conversational prompt (ack, or short with no verb of change)" };
  }
  if (scores.isBug.value) {
    const via = scores.isBug.viaId ? "registry id" : `wording (${scores.isBug.hits.slice(0, 2).join(", ")})`;
    return { route: "bug-pipeline", reason: `known-defect signal via ${via}` };
  }
  // Breadth dominates the question short-circuit: a HIGH-breadth request
  // (many files / explicit orchestration) routes to workflow even when its
  // only verbs are QUESTION_VERBS (audit/review/compare/...) -- otherwise the
  // question check below fires first and the router emits no route at all
  // for e.g. "Audit and review the entire codebase thoroughly across the
  // repo, compare every module" across 9 files. Checked immediately after
  // the bug-signal check so a bug signal still outranks it.
  if (scores.breadth.level === "HIGH" && (files.length >= 8 || scores.wideOrchestration)) {
    return { route: "workflow", reason: "wide breadth across many files / explicit orchestration" };
  }
  // P4: evaluated AFTER the bug-signal and HIGH-breadth checks above (so a bug
  // reported as a question still reaches bug-pipeline, and a wide-breadth ask
  // still reaches workflow) and BEFORE the light-loop branch below --
  // question-only routing now applies only when breadth is not HIGH.
  if (scores.isQuestion) {
    return { route: null, reason: "question (question-shaped or question-verb, no write-verb signal)" };
  }
  if (scores.bounded.value && scores.breadth.level === "LOW" && scores.risk.level === "LOW") {
    return { route: "light-loop", reason: "bounded change, no breadth/risk signal" };
  }
  const noveltyNote = scores.novelty.novel
    ? "no matching lesson/fix-card"
    : `known pattern (${scores.novelty.matched})`;
  return { route: "dev-pipeline", reason: `non-trivial dev work, ${noveltyNote}` };
}

// ---------------------------------------------------------------------------
// approach routing (Part C 2026-09-12 -- task-loop-rebuild plan, "Part C
// design" §Router): which of the three first-class evaluation arms
// (dev-pipeline / superpowers / raw) a task should run under. Independent of
// decideRoute's engine choice above -- decideRoute picks WHICH ENGINE
// (light-loop/bug-pipeline/dev-pipeline/workflow); decideApproach picks WHICH
// METHODOLOGY (a whole-session switch: the dev-pipeline engine itself, the
// superpowers plugin, or no framework at all). A known-defect task still
// answers "bug-pipeline" here too, since that is dev-pipeline's own bugfix
// mode -- it is not one of the three rotation arms and never rotates.
// ---------------------------------------------------------------------------

const ROTATION_ARMS = ["dev-pipeline", "superpowers", "raw"];
const APPROACH_PIN_REL = [".claude", "approach.json"];
const ROTATION_STATE_REL = [".claude", "pipeline", "approach-rotation.json"];

function readApproachPin(projectDir) {
  return safeReadJson(path.join(projectDir, ...APPROACH_PIN_REL));
}

function readRotationState(projectDir) {
  const parsed = safeReadJson(path.join(projectDir, ...ROTATION_STATE_REL));
  if (parsed && Number.isInteger(parsed.next) && Array.isArray(parsed.log)) return parsed;
  return { next: 0, log: [] };
}

function writeRotationState(projectDir, state) {
  const full = path.join(projectDir, ...ROTATION_STATE_REL);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// Pure function -- no fs, no clock dependency beyond the timestamp it stamps
// onto a NEW log entry. Given the current scores, an approach pin (or null),
// and { sessionId, rotation } state, returns:
//   { approach, profile, why, rotation, deferNote }
// `rotation` is either null (nothing to persist -- pin/bug/HIGH-risk/major/
// ui/trivial paths never touch the rotation file, and a rotation pick made
// with no sessionId is advisory-only and also not persisted) or the new
// { next, log } object the caller should write back to
// .claude/pipeline/approach-rotation.json.
//
// Precedence (deliberately NOT the plan prose's listing order -- matches
// decideRoute's own precedence instead, so a one-line bug fix still reaches
// bug-pipeline rather than misrouting to "trivial -> raw"):
//   1. pin for this session wins (pin.sessionId === state.sessionId, or a
//      not-yet-claimed pin whose sessionId is still null -- orient.mjs's
//      SessionStart hook is what stamps it).
//   2. known-defect signal -> bug-pipeline (never rotates; bug-pipeline is
//      dev-pipeline's own bugfix mode, not a rotation arm).
//   3. HIGH-risk, or major (HIGH breadth / explicit orchestration), or UI
//      work -> dev-pipeline standard (never rotates).
//   4. trivial (bounded, LOW breadth, LOW risk, no orchestration) -> raw.
//   5. everything else ("small LOW") -> the rotation, advanced once per
//      session. NOTE (plan "Part C design" §Router): a superpowers
//      assignment is only actionable at the NEXT launch -- isolation is a
//      per-session plugin-enable switch that cannot flip mid-session (see
//      Rulings 2026-09-12) -- so when the rotation's own turn lands on
//      "superpowers" for an ordinary (non-approach.mjs-driven) live session,
//      this session's own delivered `approach` is bumped to the FOLLOWING
//      arm instead, `deferNote` carries the advisory to print, and the log
//      entry records both `slot` (whose turn it was: "superpowers") and
//      `approach` (what this session actually got) so the rotation history
//      stays honest. `approach.mjs next` (task 39) is the intended way to
//      actually claim a superpowers turn -- it pins BEFORE any hook call has
//      a chance to defer that slot away.
function decideApproach(scores, pin, state) {
  const st = state || {};
  const sessionId = typeof st.sessionId === "string" && st.sessionId ? st.sessionId : null;
  const rotationIn =
    st.rotation && Number.isInteger(st.rotation.next) && Array.isArray(st.rotation.log)
      ? st.rotation
      : { next: 0, log: [] };

  // 1. Pin wins.
  if (pin && typeof pin === "object" && typeof pin.approach === "string") {
    const pinMatches = pin.sessionId == null || pin.sessionId === sessionId;
    if (pinMatches) {
      return {
        approach: pin.approach,
        profile: typeof pin.profile === "string" ? pin.profile : null,
        why: "pinned via approach.mjs",
        rotation: null,
        deferNote: null,
      };
    }
  }

  // 2. Known-defect signal -> bug-pipeline, never rotates.
  if (scores.isBug && scores.isBug.value) {
    return {
      approach: "bug-pipeline",
      profile: null,
      why: "known-defect signal -- bug-pipeline (dev-pipeline bugfix mode)",
      rotation: null,
      deferNote: null,
    };
  }

  // 3. HIGH-risk, or major (HIGH breadth / explicit orchestration), or UI
  //    work -> dev-pipeline standard, never rotates.
  const isMajor = scores.breadth.level === "HIGH" || scores.wideOrchestration;
  const isUi = !!(scores.isUi && scores.isUi.value);
  if (scores.risk.level === "HIGH" || isMajor || isUi) {
    const why = scores.risk.level === "HIGH" ? "HIGH-risk" : isMajor ? "major/wide breadth" : "UI work";
    return {
      approach: "dev-pipeline",
      profile: "standard",
      why: `${why} -- dev-pipeline standard`,
      rotation: null,
      deferNote: null,
    };
  }

  // 4. Trivial (bounded, LOW/LOW, no orchestration) -> raw.
  const isTrivial = scores.bounded && scores.bounded.value && scores.breadth.level === "LOW" && !scores.wideOrchestration;
  if (isTrivial) {
    return {
      approach: "raw",
      profile: null,
      why: "trivial bounded change -- raw (no framework)",
      rotation: null,
      deferNote: null,
    };
  }

  // 5. Small LOW -> rotation, advanced once per session.
  if (sessionId) {
    const already = rotationIn.log.find((e) => e && e.sessionId === sessionId);
    if (already) {
      return {
        approach: already.approach,
        profile: already.approach === "dev-pipeline" ? "lean" : null,
        why: `rotation (already assigned this session: ${already.approach})`,
        rotation: null,
        deferNote: already.slot === "superpowers" ? already.deferNote || null : null,
      };
    }
  }

  const slotIdx = ((rotationIn.next % ROTATION_ARMS.length) + ROTATION_ARMS.length) % ROTATION_ARMS.length;
  const slot = ROTATION_ARMS[slotIdx];
  let deliveredIdx = slotIdx;
  let deferNote = null;
  // allowSuperpowers (Part C task 39, approach.mjs `next`): the ordinary live
  // hook call (state.allowSuperpowers falsy) always defers a superpowers slot
  // forward, since it cannot flip the plugin mid-session -- but
  // `approach.mjs next` IS the mechanism that flips the plugin BEFORE a new
  // session starts, so it opts in via --allow-superpowers to actually claim
  // the slot instead of deferring past it.
  if (slot === "superpowers" && !st.allowSuperpowers) {
    deferNote = "superpowers arm: run `approach.mjs next` and start a new session";
    deliveredIdx = (slotIdx + 1) % ROTATION_ARMS.length;
  }
  const delivered = ROTATION_ARMS[deliveredIdx];

  if (!sessionId) {
    // Advisory-only (e.g. --explain probing, or no hook session id
    // available) -- report the current slot without consuming it.
    return {
      approach: delivered,
      profile: delivered === "dev-pipeline" ? "lean" : null,
      why: `rotation (no session id, not advanced): ${delivered}`,
      rotation: null,
      deferNote,
    };
  }

  const newRotation = {
    next: (deliveredIdx + 1) % ROTATION_ARMS.length,
    log: [
      ...rotationIn.log,
      { sessionId, slot, approach: delivered, deferNote, at: new Date().toISOString() },
    ].slice(-200),
  };
  return {
    approach: delivered,
    profile: delivered === "dev-pipeline" ? "lean" : null,
    why: deferNote ? `rotation (deferred past superpowers): ${delivered}` : `rotation arm ${slotIdx + 1}/${ROTATION_ARMS.length}: ${delivered}`,
    rotation: newRotation,
    deferNote,
  };
}

// G2: ultracode (Fable ultrathink framing) is a BREADTH decision, not a risk
// one. It goes ON only for wide, unbounded work (audit/review/research/
// migrate/design/compare/"all"/"thoroughly"/explicit "workflow"/"ultracode"
// -- see BREADTH_WORDS) that isn't already scoped down to a bounded change.
// A HIGH-risk signal (money/auth/tenancy/schema/PII) never flips this ON by
// itself -- risk already buys an Opus verdict via buildRoles() regardless of
// ultracode, so a bounded, low-breadth risky fix ("fix the invoice total bug
// B123") gets Opus judgment on a small diff instead of ultrathink framing on
// work that was never wide to begin with.
function decideUltracode(scores) {
  const highRisk = scores.risk.level === "HIGH";
  const wideBreadth = scores.breadth.level !== "LOW";
  const on = wideBreadth && !scores.bounded.value;

  if (on) {
    const hits = scores.breadth.hits.slice(0, 3);
    const via = hits.length ? hits.join("/") : "breadth signal";
    const riskNote = highRisk ? " · HIGH-risk verdict routes to Opus regardless" : "";
    return { on: true, reason: `wide breadth (${via}), not bounded${riskNote}` };
  }

  if (highRisk) {
    const why = scores.bounded.value ? "bounded" : "breadth LOW";
    return { on: false, reason: `HIGH-risk: Opus verdicts; ${why} → ultracode OFF` };
  }

  return { on: false, reason: "no wide-breadth signal (or bounded) — ultracode OFF" };
}

// ---------------------------------------------------------------------------
// role/model/effort assignment (ROUTING-PLAN.md §2, §5, §6)
// ---------------------------------------------------------------------------

function buildRoles(route, riskLevel, ultracodeOn) {
  const verdict = riskLevel === "HIGH" ? { model: "opus", effort: "high" } : { model: "sonnet", effort: "high" };
  const fix = riskLevel === "HIGH" ? { model: "opus", effort: "high" } : { model: "sonnet", effort: "medium" };
  const frameEffort = ultracodeOn ? "high(ultrathink)" : "high";

  switch (route) {
    case "light-loop":
      return [
        { role: "build", model: "sonnet", effort: "medium" },
        { role: "gate", model: "haiku", effort: "low" },
        { role: "review", model: verdict.model, effort: verdict.effort },
        { role: "fix", model: fix.model, effort: fix.effort },
      ];
    case "bug-pipeline":
    case "dev-pipeline":
      return [
        { role: "frame", model: "fable", effort: frameEffort },
        { role: "pack", model: "sonnet", effort: "low" },
        { role: "build", model: "sonnet", effort: "medium" },
        { role: "verdict", model: verdict.model, effort: verdict.effort },
        { role: "mech", model: "haiku", effort: "low" },
      ];
    case "workflow":
      return [
        { role: "frame", model: "fable", effort: frameEffort },
        { role: "build", model: "sonnet", effort: "medium" },
        { role: "verdict", model: verdict.model, effort: verdict.effort },
        { role: "fix", model: fix.model, effort: fix.effort },
        { role: "checkpoint", model: "haiku", effort: "low" },
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// scorecard override (best-effort; routingScorecard may not exist yet)
// ---------------------------------------------------------------------------

function tryLoadScorecard(projectDir) {
  if (!fileExists(LEDGER_SCRIPT)) return null;
  try {
    const res = spawnSync(
      process.execPath,
      [LEDGER_SCRIPT, "summary", "--json", "--project", projectDir],
      { encoding: "utf8", timeout: 4000 }
    );
    if (!res || res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout);
    const rows = parsed && Array.isArray(parsed.routingScorecard) ? parsed.routingScorecard : null;
    return rows;
  } catch {
    return null;
  }
}

// A scorecard row is expected to look like:
//   { role or level: "verdict", model: "sonnet", effort: "high", runs: 14, ... }
// Field names are not yet fixed upstream (pipeline-ledger.mjs does not emit
// `routingScorecard` as of this writing) -- so this matches defensively on
// several plausible field names and simply no-ops when the shape is missing
// or `runs` is below 10 (per brief §1: "overridden ... when ... exposes
// routingScorecard rows with >= 10 telemetry runs").
function applyScorecardOverrides(roles, scorecardRows) {
  if (!Array.isArray(scorecardRows) || scorecardRows.length === 0) return roles;
  return roles.map((r) => {
    const match = scorecardRows.find((row) => {
      const label = String(row.role || row.level || row.label || "").toLowerCase();
      const runs = Number(row.runs ?? row.count ?? 0);
      return label === r.role.toLowerCase() && Number.isFinite(runs) && runs >= 10;
    });
    if (!match) return r;
    const model = match.model || match.recommendedModel;
    const effort = match.effort || match.recommendedEffort;
    if (!model && !effort) return r;
    return { ...r, model: model || r.model, effort: effort || r.effort, overridden: true };
  });
}

// ---------------------------------------------------------------------------
// output formatting
// ---------------------------------------------------------------------------

function formatRoles(roles) {
  return roles.map((r) => `${r.role}=${r.model}@${r.effort}${r.overridden ? "*" : ""}`).join(", ");
}

function formatApproachSuffix(approach, reason) {
  if (!approach) return "";
  const label = approach.profile ? `${approach.approach}:${approach.profile}` : approach.approach;
  return ` · Approach: ${label} (${reason})`;
}

function formatAdvise(result) {
  if (!result.route) return "";
  const ultraFlag = result.ultracode.on ? "ON" : "OFF";
  let reason = result.ultracode.on ? result.ultracode.reason : result.route.reason;
  let approachReason = result.approach ? result.approach.why : null;
  let roles = result.roles.slice();

  const build = () =>
    `Route: ${result.route.route} · Ultracode: ${ultraFlag} — ${reason} · Roles: ${formatRoles(roles)}` +
    formatApproachSuffix(result.approach, approachReason);

  let line = build();

  if (byteLen(line) > ADVISE_BYTE_CAP) {
    // Shrink the reason first, then the approach reason, then drop trailing
    // roles, until it fits.
    while (byteLen(line) > ADVISE_BYTE_CAP && reason.length > 20) {
      reason = reason.slice(0, reason.length - 10).trimEnd() + "…";
      line = build();
    }
    while (byteLen(line) > ADVISE_BYTE_CAP && approachReason && approachReason.length > 20) {
      approachReason = approachReason.slice(0, approachReason.length - 10).trimEnd() + "…";
      line = build();
    }
    while (byteLen(line) > ADVISE_BYTE_CAP && roles.length > 1) {
      roles = roles.slice(0, -1);
      line = build();
    }
  }
  return line;
}

function formatExplain(result) {
  const s = result.scores;
  const lines = [
    "-- score breakdown --",
    `breadth: ${s.breadth.level} (${s.breadth.count} hit${s.breadth.count === 1 ? "" : "s"}: ${s.breadth.hits.join(", ") || "none"})`,
    `risk: ${s.risk.level} (words: ${s.risk.wordHits.join(", ") || "none"}; paths: ${s.risk.pathHits.join(", ") || "none"})`,
    `bounded: ${s.bounded.value} (hits: ${s.bounded.hits.join(", ") || "none"}; files: ${s.bounded.fileCount})`,
    `bug signal: ${s.isBug.value} (via id: ${s.isBug.viaId}; words: ${s.isBug.hits.join(", ") || "none"})`,
    `conversational: ${s.isConversational}`,
    `question: ${s.isQuestion}`,
    `novelty: ${s.novelty.novel ? "novel" : `known (${s.novelty.matched})`}`,
    `verifiability: tests=${s.verifiability.hasTestsDir} jest=${s.verifiability.hasJestConfig}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

function routeTask(taskText, files, projectDir, sessionId, allowSuperpowers) {
  const scores = computeScores(taskText, files, projectDir);
  const routeDecision = decideRoute(taskText, files, scores);
  const ultracode = decideUltracode(scores);

  let roles = [];
  if (routeDecision.route) {
    roles = buildRoles(routeDecision.route, scores.risk.level, ultracode.on);
    const scorecardRows = tryLoadScorecard(projectDir);
    roles = applyScorecardOverrides(roles, scorecardRows);
  }

  // Part C 2026-09-12: approach decision only applies to a real (non-null)
  // route -- a conversational ack or a bare question never touches the pin
  // file, the rotation state, or the rotation's once-per-session bookkeeping.
  let approach = null;
  if (routeDecision.route) {
    const pin = readApproachPin(projectDir);
    const rotation = readRotationState(projectDir);
    const decision = decideApproach(scores, pin, { sessionId, rotation, allowSuperpowers: !!allowSuperpowers });
    if (decision.rotation) writeRotationState(projectDir, decision.rotation);
    approach = {
      approach: decision.approach,
      profile: decision.profile,
      why: decision.why,
      deferNote: decision.deferNote,
    };
  }

  return {
    task: taskText,
    project: projectDir,
    files,
    route: routeDecision.route ? { route: routeDecision.route, reason: routeDecision.reason } : null,
    ultracode,
    roles,
    scores,
    approach,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = { files: null, project: null, json: false, explain: false, sessionId: null, allowSuperpowers: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--files") flags.files = argv[++i];
    else if (a.startsWith("--files=")) flags.files = a.slice("--files=".length);
    else if (a === "--project") flags.project = argv[++i];
    else if (a.startsWith("--project=")) flags.project = a.slice("--project=".length);
    else if (a === "--session-id") flags.sessionId = argv[++i];
    else if (a.startsWith("--session-id=")) flags.sessionId = a.slice("--session-id=".length);
    else if (a === "--allow-superpowers") flags.allowSuperpowers = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--explain") flags.explain = true;
    else if (a === "--advise") flags.advise = true; // accepted, it's the default anyway
    else rest.push(a);
  }
  return { flags, rest };
}

function parseFilesFlag(v) {
  if (!v) return null;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function readStdinIfAvailable() {
  try {
    if (process.stdin.isTTY) return null;
    return fs.readFileSync(0, "utf8");
  } catch {
    return null;
  }
}

function printHelp() {
  console.log(`route-task.mjs -- score a task and recommend an engine + model/effort roles

Usage:
  node route-task.mjs "<task text>" [--files a.ts,b.ts] [--project <dir>]
      [--session-id <sid>] [--allow-superpowers] [--json] [--explain]
  echo '{"prompt":"...","session_id":"..."}' | node route-task.mjs
  node route-task.mjs selftest

  --allow-superpowers claims a rotation-superpowers slot directly instead of
  deferring it forward -- used only by approach.mjs next, which is the
  mechanism that actually flips the plugin before a new session starts.`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "selftest") {
    process.exit(runSelftest());
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const { flags, rest } = parseArgs(argv);
  let taskText = rest.join(" ").trim();
  let stdinFiles = null;
  let stdinSessionId = null;

  if (!taskText) {
    const raw = readStdinIfAvailable();
    if (raw && raw.trim()) {
      const trimmed = raw.trim();
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj.prompt === "string") taskText = obj.prompt;
        else if (typeof obj.text === "string") taskText = obj.text;
        if (Array.isArray(obj.files)) stdinFiles = obj.files;
        if (typeof obj.session_id === "string") stdinSessionId = obj.session_id;
      } catch {
        taskText = trimmed;
      }
    }
  }

  const projectDir = path.resolve(flags.project || process.cwd());
  const files = parseFilesFlag(flags.files) || stdinFiles || [];
  const sessionId = flags.sessionId || stdinSessionId || null;

  if (!taskText) {
    if (flags.json) console.log(JSON.stringify({ route: null, reason: "empty task text" }));
    process.exit(0);
  }

  const result = routeTask(taskText, files, projectDir, sessionId, flags.allowSuperpowers);

  if (result.route === null && !flags.json && !flags.explain) {
    process.exit(0); // conversational: stay silent
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const line = formatAdvise(result);
    if (line) console.log(line);
    if (result.approach && result.approach.deferNote) {
      console.log(`Note: ${result.approach.deferNote}`);
    }
  }
  if (flags.explain) {
    console.log(formatExplain(result));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

function assert(cond, label, failures) {
  if (!cond) failures.push(label);
}

function runSelftest() {
  const failures = [];
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "route-task-selftest-"));

  // Project fixture: a lesson digest + a fix-card + a tests dir + jest config,
  // so novelty/verifiability checks have something real to read.
  fs.mkdirSync(path.join(tmpBase, ".claude", "lessons"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpBase, ".claude", "lessons", "LESSONS-DIGEST.md"),
    "- L-001 · tooling · Renaming the checkout button label needs a snapshot update too.\n"
  );
  fs.mkdirSync(path.join(tmpBase, ".claude", "pipeline", "fix-cards"), { recursive: true });
  fs.writeFileSync(path.join(tmpBase, ".claude", "pipeline", "fix-cards", "invoice-rounding-fix.md"), "x");
  fs.mkdirSync(path.join(tmpBase, "tests"), { recursive: true });
  fs.writeFileSync(path.join(tmpBase, "jest.config.js"), "module.exports = {};\n");

  // Bare project fixture (no lessons/fix-cards/tests) for the "novel" case.
  const bareProject = path.join(tmpBase, "bare");
  fs.mkdirSync(bareProject, { recursive: true });

  function route(text, opts = {}) {
    return routeTask(text, opts.files || [], opts.project || bareProject);
  }

  // 1. Conversational -> no route, silent.
  {
    const r = route("is this done?");
    assert(r.route === null, "conversational question yields no route", failures);
  }
  {
    const r = route("what does this do");
    assert(r.route === null, "conversational (no ?) with question starter yields no route", failures);
  }

  // 2. Bug signal via registry id -> bug-pipeline.
  {
    const r = route("Fix B042: the totals column shows a stale value after refresh");
    assert(r.route && r.route.route === "bug-pipeline", "registry id routes to bug-pipeline", failures);
  }

  // 3. Bug signal via wording -> bug-pipeline.
  {
    const r = route("Fix the crash that happens on checkout when the cart is empty");
    assert(r.route && r.route.route === "bug-pipeline", "crash wording routes to bug-pipeline", failures);
  }

  // 4. Bounded, low breadth/risk, non-bug -> light-loop.
  {
    const r = route("Rename the submit button label to Continue in the signup form", { files: ["app/signup/Form.tsx"] });
    assert(r.route && r.route.route === "light-loop", "bounded rename routes to light-loop", failures);
  }

  // 5. High breadth + many files or explicit orchestration -> workflow.
  {
    const r = route("Audit and review the entire codebase thoroughly across the repo, compare every module", {
      files: Array.from({ length: 9 }, (_, i) => `file${i}.ts`),
    });
    assert(r.route && r.route.route === "workflow", "wide breadth + many files routes to workflow", failures);
  }

  // 5b. HIGH-breadth question-only-verbed request (audit/review/compare, no
  // change verb) still routes to workflow -- breadth dominates the question
  // short-circuit (blocker fix, see decideRoute).
  {
    const r = route("Audit and review the entire codebase thoroughly across the repo, compare every module", {
      files: Array.from({ length: 9 }, (_, i) => `file${i}.ts`),
    });
    assert(
      r.route && r.route.route === "workflow",
      "HIGH-breadth question-only-verbed request still routes to workflow",
      failures
    );
  }

  // 5c. A narrow (non-HIGH-breadth) question with no change verb still takes
  // the question route, non-empty.
  {
    const r = route("review why the invoice total is rounded");
    assert(
      r.route === null,
      "narrow question with no change verb takes the question route",
      failures
    );
  }

  // 6. Non-trivial, non-bug, not bounded, not ultra-wide -> dev-pipeline.
  {
    const r = route("Implement a new export feature for the reporting dashboard");
    assert(r.route && r.route.route === "dev-pipeline", "ordinary feature work routes to dev-pipeline", failures);
  }

  // 7. G2: risk keyword ALONE (no breadth signal, not wide) no longer flips
  // ultracode ON -- risk buys an Opus verdict via buildRoles regardless; the
  // reason names the HIGH-risk-but-bounded/low-breadth tradeoff explicitly.
  {
    const r = route("Add a new field to the billing schema for payment reconciliation");
    assert(r.ultracode.on === false, "billing/schema/payment ALONE no longer triggers ultracode ON (G2)", failures);
    assert(/HIGH-risk/.test(r.ultracode.reason), "ultracode-OFF reason still names the HIGH-risk tradeoff", failures);
  }

  // 8. No risk keyword, no breadth -> ultracode OFF.
  {
    const r = route("Add a loading spinner to the profile page");
    assert(r.ultracode.on === false, "no risk/breadth keyword leaves ultracode OFF", failures);
  }

  // 9. G2: risk path (schema.prisma) alone, no breadth signal -> ultracode
  // OFF (was ON pre-G2). Opus verdict still applies via risk.level HIGH.
  {
    const r = route("Add a column for retry count", { files: ["prisma/schema.prisma"] });
    assert(r.ultracode.on === false, "schema.prisma path alone no longer triggers ultracode ON (G2)", failures);
    const roles = r.roles;
    assert(
      roles.some((role) => role.role === "verdict" && role.model === "opus"),
      "HIGH-risk still routes the verdict role to opus even with ultracode OFF",
      failures
    );
  }

  // 9b. G2 probes (breadth AND !bounded is the only ON condition; risk alone
  // never flips it ON):
  //   "fix the invoice total bug B123"          -> OFF (bounded fix, no breadth)
  //   "audit the whole auth module thoroughly"  -> ON  (wide breadth, not bounded)
  //   "add a CSV export to orders"              -> OFF (no breadth signal)
  //   "migrate all tenants to the new schema"   -> ON  (wide breadth, not bounded)
  {
    const r = route("fix the invoice total bug B123");
    assert(r.ultracode.on === false, "G2 probe: bounded invoice bug fix -> ultracode OFF", failures);
  }
  {
    const r = route("audit the whole auth module thoroughly");
    assert(r.ultracode.on === true, "G2 probe: wide unbounded audit -> ultracode ON", failures);
  }
  {
    const r = route("add a CSV export to orders");
    assert(r.ultracode.on === false, "G2 probe: no breadth signal -> ultracode OFF", failures);
  }
  {
    const r = route("migrate all tenants to the new schema");
    assert(r.ultracode.on === true, "G2 probe: wide unbounded migration -> ultracode ON", failures);
  }

  // 10. Roles are non-empty and shaped as role=model@effort for a routed task.
  {
    const r = route("Implement a new export feature for the reporting dashboard");
    assert(r.roles.length > 0, "dev-pipeline route yields non-empty roles", failures);
    assert(
      r.roles.every((role) => role.model && role.effort && role.role),
      "every role has role/model/effort",
      failures
    );
    const advise = formatAdvise(r);
    assert(byteLen(advise) <= ADVISE_BYTE_CAP, `advise line <= ${ADVISE_BYTE_CAP} bytes (was ${byteLen(advise)})`, failures);
    assert(advise.startsWith("Route: dev-pipeline"), "advise line starts with Route: dev-pipeline", failures);
  }

  // 11. Novelty: matches the seeded lesson -> not novel.
  {
    const r = route("Please rename the checkout button label and update the snapshot", { project: tmpBase });
    assert(r.scores.novelty.novel === false, "matching lesson marks task as not novel", failures);
  }

  // 12. Novelty: matches the seeded fix-card filename -> not novel.
  {
    const r = route("We need an invoice rounding fix for the totals", { project: tmpBase });
    assert(r.scores.novelty.novel === false, "matching fix-card filename marks task as not novel", failures);
  }

  // 13. Novelty: nothing matches -> novel.
  {
    const r = route("Build a brand new keyboard shortcut palette for navigation", { project: tmpBase });
    assert(r.scores.novelty.novel === true, "unrelated task is marked novel", failures);
  }

  // 14. Verifiability: seeded project has tests dir + jest config.
  {
    const r = route("Implement a new export feature", { project: tmpBase });
    assert(r.scores.verifiability.verifiable === true, "seeded project is verifiable", failures);
  }

  // 15. Verifiability: bare project has neither.
  {
    const r = route("Implement a new export feature", { project: bareProject });
    assert(r.scores.verifiability.verifiable === false, "bare project is not verifiable", failures);
  }

  // 16. Empty text via CLI (stdin path) yields silence, exit 0 -- exercised
  // via a real subprocess so the stdin-reading branch is covered too.
  {
    const res = spawnSync(process.execPath, [__filename], {
      input: JSON.stringify({ prompt: "is this done?" }),
      encoding: "utf8",
    });
    assert(res.status === 0, "subprocess conversational prompt exits 0", failures);
    assert((res.stdout || "").trim() === "", "subprocess conversational prompt prints nothing", failures);
  }

  // 17. Subprocess non-conversational stdin prompt prints an advise line.
  {
    const res = spawnSync(process.execPath, [__filename], {
      input: JSON.stringify({ prompt: "Fix the login crash reported as B007" }),
      encoding: "utf8",
    });
    assert(res.status === 0, "subprocess bug prompt exits 0", failures);
    assert(/^Route: bug-pipeline/.test((res.stdout || "").trim()), "subprocess bug prompt routes to bug-pipeline", failures);
  }

  // 18. --explain flag prints a score breakdown.
  {
    const r = route("Implement a new export feature");
    const explain = formatExplain(r);
    assert(explain.includes("breadth:"), "--explain output includes breadth line", failures);
    assert(explain.includes("verifiability:"), "--explain output includes verifiability line", failures);
  }

  // 19. G3: bare acknowledgements route to nothing and stay silent -- both
  // via the direct ack-set match and via the wordCount<=3-with-no-verb rule.
  for (const ack of ["yes", "no", "ok", "okay", "continue", "go ahead", "proceed", "looks good", "lgtm", "thanks", "thank you", "hmm", "sure", "next", "done", "y", "n"]) {
    const r = route(ack);
    assert(r.route === null, `G3 ack "${ack}" yields no route`, failures);
  }

  // 20. G3 probes named in the brief: exact-text and punctuation-stripped
  // acks stay silent; a real question also stays silent (pre-existing
  // question-conversational path, still covered post-refactor).
  {
    const r = route("yes");
    assert(r.route === null, 'G3 probe: "yes" -> silent', failures);
  }
  {
    const r = route("ok");
    assert(r.route === null, 'G3 probe: "ok" -> silent', failures);
  }
  {
    const r = route("continue");
    assert(r.route === null, 'G3 probe: "continue" -> silent', failures);
  }
  {
    const r = route("go ahead");
    assert(r.route === null, 'G3 probe: "go ahead" -> silent', failures);
  }
  {
    const r = route("thanks!");
    assert(r.route === null, 'G3 probe: "thanks!" (punctuation-stripped ack) -> silent', failures);
  }
  {
    const r = route("what is a radius pack?");
    assert(r.route === null, 'G3 probe: question "what is a radius pack?" -> silent', failures);
  }

  // 21. G3 guard: an ack-set WORD used inside a real, longer task is NOT
  // silenced -- only an exact (post-trim/lowercase/punctuation-strip) match
  // against the ack set, or a short (<=3 word) verbless phrase, is silent.
  {
    const r = route("Sure, but also rename the checkout button label to Continue");
    assert(r.route !== null, "ack word inside a real task is not silenced", failures);
  }

  // 22-29. questions route as questions -- QUESTION_VERBS split out of
  // VERB_OF_CHANGE, no word-count gate, evaluated after the bug-signal check
  // (brief B/P3, owner ruling 2026-09-11). The "plan/adjust" fixture below --
  // there is no "P4"; the authority for this fix is brief B P3 + lead ruling
  // 2026-09-12 engine-instrument fix round -- keeps VERB_OF_CHANGE's "adjust"
  // (it is the write-verb ground truth) -- the fix is in the question check's
  // ORDER and DEFINITION instead. An interrogative-led or "?"-terminated
  // prompt is quiet unless isRequestForm (a REQUEST_LEAD head, e.g. "can you
  // ...", "can we ...", "let's ...", "whether we should ...", followed
  // anywhere in the sentence by a write verb) or a change verb AT THE HEAD of
  // the sentence makes it a request -- a change verb appearing later in the
  // sentence, with no REQUEST_LEAD head, still does not disqualify it. The
  // question check now runs immediately after the bug-signal check and before
  // light-loop/workflow, so bug ids/words still win, and quiet wins over
  // bounded/breadth scoring. Fixtures, in order:
  //   "retrieve all your skills..."        -> quiet (QUESTION_VERB "retrieve",
  //                                            no write-verb hit anywhere)
  //   "How would you plan ... adjust ..."  -> quiet: interrogative-led ("how"),
  //                                            "adjust" is present but NOT at
  //                                            the head of the sentence, and
  //                                            "how would you" is not a
  //                                            REQUEST_LEAD head (the modal
  //                                            "would" is not itself at the
  //                                            head -- "how" is), so
  //                                            isRequestForm is false and this
  //                                            still reads as a pure question
  //   "Did you miss /bug-hunt ?"           -> quiet. A slash-command token
  //                                            ("/bug-hunt") is stripped
  //                                            before BUG_WORDS is counted
  //                                            (finding fix, 2026-09-11):
  //                                            a bug hunt is discovery, not
  //                                            a known defect, so it must
  //                                            not contribute a "bug" hit.
  //                                            No bug id, no bug words ->
  //                                            the question path is reached
  //                                            and this is interrogative-led
  //                                            ("did"), so it stays quiet.
  //   "audit the ledger and tell me why..."-> quiet (QUESTION_VERB "audit",
  //                                            no write-verb hit anywhere)
  //   "Take actions based on what you planned" -> engine (unchanged)
  //   "review the diff and fix what you find"  -> engine: not interrogative-
  //                                            led/"?"-terminated, so this
  //                                            falls to the QUESTION_VERB
  //                                            clause, which (unchanged from
  //                                            before P4) still requires zero
  //                                            VERB_OF_CHANGE hits anywhere --
  //                                            "fix" disqualifies it
  //   "B263 the scanner shows the wrong price" -> bug-pipeline
  //   "refactor the router"                    -> engine
  {
    const r = route("retrieve all your skills we have installed, and I have created, and frequently used");
    assert(r.route === null, "P3 fixture: retrieve-skills question -> quiet", failures);
  }
  {
    const r = route(
      "How would you plan your next step with the knowledge and experience you have, and how would you adjust our skills and harnesses?"
    );
    assert(
      r.route === null,
      "P4 fixture: plan/adjust question -> quiet (change verb not at head)",
      failures
    );
  }
  {
    const r = route("Did you miss /bug-hunt ?");
    assert(
      r.route === null,
      "P3 fixture: \"/bug-hunt\" question -> quiet (slash-command token stripped, not a bug-word hit)",
      failures
    );
  }
  {
    const r = route("run /bug-hunt on the orders module");
    assert(
      r.route === null || r.route.route !== "bug-pipeline",
      "finding fixture: \"run /bug-hunt on the orders module\" -> not bug-pipeline",
      failures
    );
  }
  {
    const r = route("debug why the build is slow");
    assert(
      r.route === null || r.route.route !== "bug-pipeline",
      "finding fixture: \"debug why the build is slow\" -> not bug-pipeline (debug does not match bug)",
      failures
    );
  }
  {
    const r = route("the invoice total is wrong, see B231");
    assert(
      r.route !== null && r.route.route === "bug-pipeline",
      "finding fixture: registry id B231 -> bug-pipeline",
      failures
    );
  }
  {
    const r = route("fix the regression in rounding");
    assert(
      r.route !== null && r.route.route === "bug-pipeline",
      "finding fixture: \"fix the regression in rounding\" -> bug-pipeline",
      failures
    );
  }
  {
    const r = route("audit the ledger and tell me why no row has true telemetry");
    assert(r.route === null, "P3 fixture: audit-the-ledger question -> quiet", failures);
  }
  {
    const r = route("Take actions based on what you planned");
    assert(r.route !== null, "P3 fixture: imperative statement -> engine (unchanged)", failures);
  }
  {
    const r = route("review the diff and fix what you find");
    assert(
      r.route !== null && r.route.route === "dev-pipeline",
      "P3 fixture: review+fix -> engine (write verb fix)",
      failures
    );
  }
  {
    const r = route("B263 the scanner shows the wrong price");
    assert(r.route && r.route.route === "bug-pipeline", "P3 fixture: registry id -> bug-pipeline", failures);
  }
  {
    const r = route("refactor the router");
    assert(r.route !== null && r.route.route === "dev-pipeline", "P3 fixture: refactor -> engine", failures);
  }

  // P4 fixture: interrogative-led, change verb ("adjusts") not at head -> quiet.
  {
    const r = route("How would you plan a change that adjusts the invoice rounding?");
    assert(
      r.route === null,
      "P4 fixture: plan-a-change/adjusts question -> quiet (change verb not at head)",
      failures
    );
  }
  // P4 fixture: a REQUEST_LEAD prefix ("can you ...") + change verb is a
  // request, never quiet, even though it looks interrogative.
  {
    const r = route("Can you adjust the invoice rounding?");
    assert(
      r.route !== null,
      "P4 fixture: request-lead + adjust -> engine, not quiet",
      failures
    );
  }
  // P4 fixture: a change verb AT THE HEAD is a request, never quiet.
  {
    const r = route("adjust the rounding on invoices");
    assert(
      r.route !== null,
      "P4 fixture: change verb at head (adjust) -> engine, not quiet",
      failures
    );
  }
  // P4 fixture: isBugId still wins over the question check.
  {
    const r = route("What is the status of B231?");
    assert(
      r.route !== null && r.route.route === "bug-pipeline",
      "P4 fixture: bug id in a question -> bug-pipeline (isBugId still wins)",
      failures
    );
  }
  // brief B/execute:4 fixture: a bounded, LOW-breadth/LOW-risk prompt that is
  // an interrogative-led question with no imperative change verb must route
  // to null (quiet), never light-loop -- isQuestion is checked before the
  // bounded/LOW/LOW light-loop branch in decideRoute.
  {
    const r = route("Why does computeLineSubtotal round before proration?", {
      files: ["packages/pricing/src/pricing.ts"],
    });
    assert(
      r.route === null,
      "B/execute:4 fixture: bounded LOW/LOW question, no change verb -> quiet, not light-loop",
      failures
    );
  }
  // Same prompt phrased as a request (change verb at head) still routes to
  // light-loop -- the invariant's other half.
  {
    const r = route("please change computeLineSubtotal to round after proration", {
      files: ["packages/pricing/src/pricing.ts"],
    });
    assert(
      r.route !== null && r.route.route === "light-loop",
      "B/execute:4 fixture: same change phrased as a request -> light-loop",
      failures
    );
  }

  // 30-37. lead ruling 2026-09-12 (brief B P3 + engine-instrument fix round):
  // a REQUEST_LEAD head ("can we", "could we", "should we", "let's", or
  // "whether" + a "we should"-shaped clause) followed anywhere in the
  // sentence by a write verb is a change request, not a question -- fixing
  // the regression where these first-person-plural asks fell through to
  // isQuestion -> route=null even though each carries a write verb. The two
  // "quiet" fixtures below are the invariant's other half: a REQUEST_LEAD
  // head with NO write verb after it (explain/archive are QUESTION_VERB /
  // plain verbs, not VERB_OF_CHANGE) still reads as a question.
  {
    const r = route("Can we add a caching layer to the router?");
    assert(r.route !== null, "lead-ruling fixture: \"Can we add ...\" -> engine", failures);
  }
  {
    const r = route("Could we refactor the invoice service?");
    assert(r.route !== null, "lead-ruling fixture: \"Could we refactor ...\" -> engine", failures);
  }
  {
    const r = route("Should we implement the new export endpoint?");
    assert(r.route !== null, "lead-ruling fixture: \"Should we implement ...\" -> engine", failures);
  }
  {
    const r = route("whether we should rename the field");
    assert(r.route !== null, "lead-ruling fixture: \"whether we should rename ...\" -> engine", failures);
  }
  {
    const r = route("Can you explain how the router works?");
    assert(r.route === null, "lead-ruling fixture: \"Can you explain ...\" -> quiet (explain is not a write verb)", failures);
  }
  {
    const r = route("should we archive the marketing pack");
    assert(r.route === null, "lead-ruling fixture: \"should we archive ...\" -> quiet (archive is not a write verb)", failures);
  }
  {
    const r = route("I have created three skills, list them");
    assert(r.route === null, "lead-ruling fixture: \"I have created ...\" -> quiet (past-tense \"created\" is not a head write-verb hit, and no REQUEST_LEAD head)", failures);
  }
  {
    const r = route("let's migrate the ledger to true telemetry");
    assert(r.route !== null, "lead-ruling fixture: \"let's migrate ...\" -> engine", failures);
  }

  // 38. P3/P4: all pre-existing scenarios above must still be green (this
  // selftest run itself is the proof -- no separate assertion needed here;
  // this line documents the requirement per the brief's Acceptance section).

  // -------------------------------------------------------------------------
  // 39-48. Part C 2026-09-12 (task-loop-rebuild, C2): decideApproach.
  // -------------------------------------------------------------------------

  function smallLowScores(text) {
    return computeScores(text, [], bareProject);
  }

  // 39. Pinned approach wins outright, regardless of the underlying scores.
  {
    const d = decideApproach(
      smallLowScores("fix the crash on checkout"), // would otherwise be a bug signal
      { approach: "superpowers", profile: null, sessionId: "sess-pin-1" },
      { sessionId: "sess-pin-1", rotation: { next: 0, log: [] } }
    );
    assert(d.approach === "superpowers", "39: a matching pin wins over a bug signal", failures);
    assert(d.rotation === null, "39: a pin decision never touches rotation state", failures);
  }

  // 40. A pin with sessionId:null (not yet claimed by orient.mjs) matches
  // ANY current session -- it is the freshly-written, not-yet-stamped pin.
  {
    const d = decideApproach(
      smallLowScores("implement a new export feature"),
      { approach: "dev-pipeline", profile: "standard", sessionId: null },
      { sessionId: "sess-any", rotation: { next: 0, log: [] } }
    );
    assert(d.approach === "dev-pipeline" && d.profile === "standard", "40: an unclaimed pin (sessionId:null) matches any session", failures);
  }

  // 41. A pin stamped for a DIFFERENT session does not win -- falls through
  // to the underlying decision (here, a bug signal -> bug-pipeline).
  {
    const d = decideApproach(
      smallLowScores("fix the crash on checkout"),
      { approach: "superpowers", profile: null, sessionId: "sess-other" },
      { sessionId: "sess-mine", rotation: { next: 0, log: [] } }
    );
    assert(d.approach === "bug-pipeline", "41: a pin stamped for a different session is ignored", failures);
  }

  // 42. Bug signal -> bug-pipeline, never rotates (rotation stays null even
  // when the rotation pointer is mid-cycle).
  {
    const d = decideApproach(smallLowScores("fix the regression in rounding"), null, {
      sessionId: "sess-bug-1",
      rotation: { next: 1, log: [] },
    });
    assert(d.approach === "bug-pipeline", "42: bug signal routes to bug-pipeline", failures);
    assert(d.rotation === null, "42: bug-pipeline decision never touches rotation state", failures);
  }

  // 43. HIGH-risk never rotates -- two different sessions both land on
  // dev-pipeline:standard, and neither call proposes a rotation update.
  {
    const scores = smallLowScores("Add a new field to the billing schema for payment reconciliation");
    const d1 = decideApproach(scores, null, { sessionId: "sess-risk-1", rotation: { next: 0, log: [] } });
    const d2 = decideApproach(scores, null, { sessionId: "sess-risk-2", rotation: { next: 2, log: [] } });
    assert(d1.approach === "dev-pipeline" && d1.profile === "standard", "43a: HIGH-risk -> dev-pipeline standard", failures);
    assert(d1.rotation === null, "43b: HIGH-risk decision never touches rotation state (session 1)", failures);
    assert(d2.approach === "dev-pipeline" && d2.profile === "standard", "43c: HIGH-risk -> dev-pipeline standard (session 2)", failures);
    assert(d2.rotation === null, "43d: HIGH-risk decision never touches rotation state (session 2)", failures);
  }

  // 44. Major (HIGH breadth / explicit orchestration) never rotates either.
  {
    const scores = smallLowScores("Design and orchestrate a full multi-agent workflow migration across the codebase");
    const d = decideApproach(scores, null, { sessionId: "sess-major-1", rotation: { next: 1, log: [] } });
    assert(d.approach === "dev-pipeline" && d.profile === "standard", "44: major/wide breadth -> dev-pipeline standard", failures);
    assert(d.rotation === null, "44: major decision never touches rotation state", failures);
  }

  // 45. UI work never rotates.
  {
    const scores = smallLowScores("Improve the accessibility of the modal dialog component's CSS");
    const d = decideApproach(scores, null, { sessionId: "sess-ui-1", rotation: { next: 1, log: [] } });
    assert(d.approach === "dev-pipeline" && d.profile === "standard", "45: UI work -> dev-pipeline standard", failures);
    assert(d.rotation === null, "45: UI decision never touches rotation state", failures);
  }

  // 46. Trivial (bounded, LOW/LOW, no orchestration) -> raw, never rotates.
  // ("Rename" is a BOUNDED_WORDS hit -> bounded true; no risk/breadth words.)
  {
    const d = decideApproach(smallLowScores("Rename the submit button label to Continue"), null, {
      sessionId: "sess-trivial-1",
      rotation: { next: 0, log: [] },
    });
    assert(d.approach === "raw", "46: trivial bounded change -> raw", failures);
    assert(d.rotation === null, "46: trivial decision never touches rotation state", failures);
  }

  // 47. Rotation: each of the three starting slots produces a sensible,
  // actionable decision -- dev-pipeline and raw are delivered directly; the
  // superpowers slot defers to the following arm (raw) for THIS session
  // (plan "Part C design" §Router NOTE) and carries a deferNote, while the
  // log entry's own `slot` field still names "superpowers" -- so the
  // rotation's bookkeeping visits all three arms even though the live
  // session only ever acts on dev-pipeline/raw.
  {
    const smallLow = smallLowScores("Add a CSV export to orders");
    const d0 = decideApproach(smallLow, null, { sessionId: "sess-rot-0", rotation: { next: 0, log: [] } });
    assert(d0.approach === "dev-pipeline" && d0.profile === "lean", "47a: rotation slot 0 delivers dev-pipeline:lean", failures);
    assert(d0.rotation && d0.rotation.next === 1, "47b: rotation slot 0 advances next to 1", failures);
    assert(d0.deferNote === null, "47c: rotation slot 0 carries no deferNote", failures);

    const d1 = decideApproach(smallLow, null, { sessionId: "sess-rot-1", rotation: { next: 1, log: [] } });
    assert(d1.approach === "raw", "47d: rotation slot 1 (superpowers) defers to raw for this session", failures);
    assert(typeof d1.deferNote === "string" && /approach\.mjs next/.test(d1.deferNote), "47e: deferred slot carries the approach.mjs next advisory", failures);
    assert(d1.rotation && d1.rotation.log.some((e) => e.slot === "superpowers"), "47f: the log's slot field still names superpowers for that turn", failures);
    assert(d1.rotation.next === 0, "47g: deferring past superpowers advances next to the arm after the deferred delivery", failures);

    const d2 = decideApproach(smallLow, null, { sessionId: "sess-rot-2", rotation: { next: 2, log: [] } });
    assert(d2.approach === "raw" && d2.profile === null, "47h: rotation slot 2 delivers raw directly", failures);
    assert(d2.rotation && d2.rotation.next === 0, "47i: rotation slot 2 wraps next back to 0", failures);
  }

  // 47j-47l. allowSuperpowers (Part C task 39: approach.mjs `next` is the
  // mechanism that flips the plugin BEFORE a new session starts, so it opts
  // in to actually claim a superpowers slot instead of deferring it).
  {
    const smallLow = smallLowScores("Add a CSV export to orders");
    const d = decideApproach(smallLow, null, {
      sessionId: "sess-rot-claim",
      rotation: { next: 1, log: [] },
      allowSuperpowers: true,
    });
    assert(d.approach === "superpowers", "47j: allowSuperpowers claims the superpowers slot directly", failures);
    assert(d.deferNote === null, "47k: a claimed superpowers slot carries no deferNote", failures);
    assert(d.rotation && d.rotation.next === 2, "47l: claiming superpowers advances next by exactly one slot", failures);
  }

  // 48. Rotation advances ONCE per session -- a second call with the SAME
  // sessionId (chaining the rotation state the first call proposed) returns
  // the SAME approach again and proposes no further rotation change.
  {
    const smallLow = smallLowScores("Add a CSV export to orders");
    const first = decideApproach(smallLow, null, { sessionId: "sess-once", rotation: { next: 0, log: [] } });
    assert(first.rotation !== null, "48a: first call for a fresh session proposes a rotation update", failures);
    const second = decideApproach(smallLow, null, { sessionId: "sess-once", rotation: first.rotation });
    assert(second.approach === first.approach, "48b: a second call in the same session repeats the same approach", failures);
    assert(second.rotation === null, "48c: a second call in the same session proposes no further rotation change", failures);
  }

  // 49. No session id at all (e.g. --explain probing outside a hook) reports
  // the current slot advisory-only and never proposes a rotation write.
  {
    const smallLow = smallLowScores("Add a CSV export to orders");
    const d = decideApproach(smallLow, null, { sessionId: null, rotation: { next: 0, log: [] } });
    assert(d.rotation === null, "49: no session id -> rotation is never persisted", failures);
    assert(/no session id/.test(d.why), "49: no session id -> reason says so", failures);
  }

  // -------------------------------------------------------------------------
  // 50-52. routeTask()-level integration: pin file + rotation file on disk,
  // and the advise line's Approach segment.
  // -------------------------------------------------------------------------

  const approachProject = path.join(tmpBase, "approach-project");
  fs.mkdirSync(approachProject, { recursive: true });

  // 50. routeTask reads a real .claude/approach.json pin off disk and it wins.
  {
    fs.mkdirSync(path.join(approachProject, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(approachProject, ".claude", "approach.json"),
      JSON.stringify({ approach: "raw", profile: null, sessionId: null })
    );
    const r = routeTask("Add a CSV export to orders", [], approachProject, "sess-pin-disk");
    assert(r.approach && r.approach.approach === "raw", "50: routeTask honors an on-disk approach.json pin", failures);
    fs.rmSync(path.join(approachProject, ".claude", "approach.json"));
  }

  // 51. routeTask persists a rotation advance to disk for a fresh session,
  // and a second routeTask call for the SAME session reads it back and does
  // not advance further.
  {
    const r1 = routeTask("Add a CSV export to orders", [], approachProject, "sess-disk-1");
    const rotationPath = path.join(approachProject, ".claude", "pipeline", "approach-rotation.json");
    assert(fs.existsSync(rotationPath), "51a: routeTask writes approach-rotation.json for a fresh session", failures);
    const onDisk1 = JSON.parse(fs.readFileSync(rotationPath, "utf8"));
    assert(onDisk1.log.some((e) => e.sessionId === "sess-disk-1"), "51b: the persisted rotation log records this session", failures);

    const r2 = routeTask("Add a CSV export to orders", [], approachProject, "sess-disk-1");
    assert(r2.approach.approach === r1.approach.approach, "51c: a repeat call in the same session repeats the same approach", failures);
    const onDisk2 = JSON.parse(fs.readFileSync(rotationPath, "utf8"));
    assert(onDisk2.log.length === onDisk1.log.length, "51d: a repeat call in the same session does not append a second log entry", failures);
  }

  // 52. The advise line carries an "Approach: ..." segment, and a
  // conversational (route === null) prompt carries no approach at all.
  {
    const r = routeTask("Implement a new export feature for the reporting dashboard", [], bareProject, "sess-advise-1");
    const line = formatAdvise(r);
    assert(/ · Approach: /.test(line), "52a: the advise line includes an Approach segment", failures);
    assert(byteLen(line) <= ADVISE_BYTE_CAP, `52b: advise line with Approach segment stays <= ${ADVISE_BYTE_CAP} bytes (was ${byteLen(line)})`, failures);

    const q = routeTask("is this done?", [], bareProject, "sess-advise-2");
    assert(q.approach === null, "52c: a conversational prompt has no approach decision at all", failures);
  }

  fs.rmSync(tmpBase, { recursive: true, force: true });

  if (failures.length) {
    console.error(`route-task.mjs selftest: ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log("route-task.mjs selftest: all checks passed (52 scenarios, including G2 ultracode-breadth, G3 ack-silence, P3 question-routing, P5 breadth-dominates-question, lead-ruling 2026-09-12 first-person-plural request coverage, and Part C 2026-09-12 decideApproach: pin precedence, bug/HIGH-risk/major/UI/trivial never rotating, once-per-session rotation across all three arms with the superpowers defer note, and routeTask's on-disk pin + rotation-file integration).");
  return 0;
}

main();
