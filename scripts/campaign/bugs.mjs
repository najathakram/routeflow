#!/usr/bin/env node
// bugs.mjs — the in-repo bug catalogue: intake, selection, and the fix carve-out.
//
// WHY THIS EXISTS
// The campaign already had two of the three things a bug tracker needs. The
// *state machine* lives in `.claude/campaign/status/F##.jsonl` (one row per bug
// ID, guarded by campaign-check). The *board* lives in GitHub Issues, one card
// per batch, with lanes derived from live PR/CI state. What was missing was the
// *catalogue* — the description of what each bug actually IS. That lived only in
// `local-assets/docs/routeflow-bug-register.html`, which is gitignored and can
// only be republished by the owner, so no agent could file a bug or read one
// back. An automated pickup loop cannot be built on a source of truth that
// agents cannot write to; this file is that source of truth.
//
// It deliberately does NOT duplicate the state machine. A row here carries what
// a bug *is* (title, location, severity, symptom); `status/F##.jsonl` still owns
// what a bug *is doing* (queued/proven/done + its proof). `next` joins them.
//
// THE CARVE-OUT
// Owner decision (2026-09-02): agents may auto-take normal bugs unattended, but
// anything touching money math, tenant scoping, or migrations is planned and
// parked for review. Those are precisely where this repo has taken production
// incidents — the three pricing.ts mirrors drifting, unscoped bulk writes, and
// destructive migrations. `classify()` below is that rule, expressed once, so
// the dispatcher cannot forget it and nobody can quietly widen it in passing.
//
// USAGE
//   node scripts/campaign/bugs.mjs import        # seed the catalogue from the register HTML
//   node scripts/campaign/bugs.mjs file "<title>" --location "<where>" --severity high
//   node scripts/campaign/bugs.mjs next          # the next batch an agent may take
//   node scripts/campaign/bugs.mjs list [--open] [--sensitive] [--batch F09]
//   node scripts/campaign/bugs.mjs stats
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = ".claude/campaign";
const CATALOGUE = join(ROOT, "bugs.jsonl");
const STATUS_DIR = join(ROOT, "status");
const REGISTER = "local-assets/docs/routeflow-bug-register.html";
const BOARD = join(ROOT, "board.json");

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

// ── the carve-out ─────────────────────────────────────────────────────────
// Matched against title + location. Deliberately over-broad: a false "sensitive"
// costs one owner glance, a false "safe" costs a production money bug.
const SENSITIVE = {
  money:
    /pricing\.ts|\bprice|\bmoney|invoice|credit[- ]?note|payment|\btax\b|discount|promo|billing|commission|wallet|estimate|vendor[- ]?bill|bookkeeping|\bcost|settle|refund|deposit|ledger/i,
  tenancy:
    /\btenant|\brls\b|impersonat|\bauth\b|\brole\b|permission|\bscoped?\b|\bjwt\b|session|forTenant|platform[- ]admin/i,
  migration: /migration|schema\.prisma|prisma migrate|backfill|\bdrop (table|column)|destructive/i,
};

function classify(bug) {
  const hay = `${bug.title ?? ""} ${bug.location ?? ""}`;
  const reasons = Object.entries(SENSITIVE)
    .filter(([, rx]) => rx.test(hay))
    .map(([k]) => k);
  return { sensitive: reasons.length > 0, reasons };
}

// ── io ────────────────────────────────────────────────────────────────────
const readCatalogue = () =>
  existsSync(CATALOGUE)
    ? readFileSync(CATALOGUE, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function writeCatalogue(rows) {
  rows.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(CATALOGUE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// Latest state per bug ID, read from the shards campaign-check already guards.
function readState() {
  const state = new Map();
  if (!existsSync(STATUS_DIR)) return state;
  for (const f of readdirSync(STATUS_DIR).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(STATUS_DIR, f), "utf8").split(/\r?\n/).filter(Boolean)) {
      const o = JSON.parse(line);
      state.set(o.id, o);
    }
  }
  return state;
}

const fail = (m) => {
  console.error(`bugs: ${m}`);
  process.exit(1);
};

function flag(args, name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const stripTags = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

// ── commands ──────────────────────────────────────────────────────────────
const cmds = {};

// One-time seed. Idempotent: never overwrites a row that already exists, so a
// hand-edited symptom survives a re-import.
cmds.import = () => {
  if (!existsSync(REGISTER))
    fail(`register not found at ${REGISTER} (gitignored — this runs on the owner's machine only)`);
  const html = readFileSync(REGISTER, "utf8");
  const rows = [
    ...html.matchAll(
      /<tr><td><a href="#b\d+">(B\d+)<\/a><\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g,
    ),
  ];
  if (!rows.length)
    fail(
      "no bug rows matched — the register markup changed; fix the pattern rather than importing nothing",
    );

  const existing = readCatalogue();
  const known = new Set(existing.map((r) => r.id));
  const state = readState();
  let added = 0;

  for (const [, id, title, location, sevCell, stateCell] of rows) {
    if (known.has(id)) continue;
    const sev = /chip (critical|high|medium|low)/.exec(sevCell);
    const bug = {
      id,
      title: stripTags(title),
      location: stripTags(location),
      severity: sev ? sev[1] : "none",
      register: stripTags(stateCell),
      batch: state.get(id)?.batch ?? null,
      source: "register-import",
      filedAt: null,
    };
    const c = classify(bug);
    bug.sensitive = c.sensitive;
    bug.sensitiveFor = c.reasons;
    existing.push(bug);
    added++;
  }
  writeCatalogue(existing);
  console.log(`imported ${added} new row(s); catalogue now holds ${existing.length}.`);
};

cmds.file = (args) => {
  const title = args[0];
  if (!title || title.startsWith("--"))
    fail(
      'usage: file "<title>" --location "<where>" --severity critical|high|medium|low [--symptom "..."] [--batch F##]',
    );
  const location = flag(args, "location");
  const severity = flag(args, "severity", "medium");
  if (!location) fail("--location is required: an agent cannot route a bug it cannot place");
  if (!(severity in SEVERITY_RANK))
    fail(`--severity must be one of ${Object.keys(SEVERITY_RANK).join("|")}`);

  const rows = readCatalogue();
  // Never infer a free id from a gap — reserved is not abandoned. Always max+1.
  const maxId = rows.reduce((m, r) => Math.max(m, Number(r.id.slice(1))), 0);
  const bug = {
    id: `B${maxId + 1}`,
    title,
    location,
    severity,
    symptom: flag(args, "symptom"),
    register: "open",
    batch: flag(args, "batch"),
    source: "filed",
    filedAt: new Date().toISOString(),
  };
  const c = classify(bug);
  bug.sensitive = c.sensitive;
  bug.sensitiveFor = c.reasons;
  rows.push(bug);
  writeCatalogue(rows);

  console.log(`filed ${bug.id} — ${title}`);
  console.log(`  location : ${location}`);
  console.log(`  severity : ${severity}`);
  if (c.sensitive)
    console.log(
      `  carve-out: touches ${c.reasons.join(", ")} — an agent may PLAN this but must not fix it unattended.`,
    );
  else console.log("  agent-safe: yes");
  if (!bug.batch) console.log("  no batch yet — run @tech-lead to batch it, or pass --batch F##.");

  // Filing a bug and leaving it without a record is exactly the drift this
  // registry exists to prevent, so create it in the same breath. expand is
  // idempotent and never touches an existing narrative.
  cmds.expand();
  console.log(`  record   : ${recordPath(bug.id)}`);
};

// The dispatcher's selector. Returns the next BATCH an agent may take, because a
// batch — not a single bug — is what the board card, the pipeline folder and the
// PR are all scoped to.
cmds.next = (args) => {
  const catalogue = readCatalogue();
  const state = readState();
  const board = existsSync(BOARD) ? JSON.parse(readFileSync(BOARD, "utf8")) : { batches: {} };
  const byId = new Map(catalogue.map((r) => [r.id, r]));

  const batches = new Map();
  for (const [id, row] of state) {
    if (row.state !== "queued") continue;
    const b = batches.get(row.batch) ?? {
      batch: row.batch,
      bugs: [],
      sensitive: [],
      issue: board.batches?.[row.batch] ?? null,
    };
    const bug = byId.get(id) ?? { id, title: "(not in catalogue)", location: "", severity: "none" };
    b.bugs.push(bug);
    if (bug.sensitive ?? classify(bug).sensitive) b.sensitive.push(bug);
    batches.set(row.batch, b);
  }

  const worst = (b) => Math.min(...b.bugs.map((x) => SEVERITY_RANK[x.severity] ?? 4));
  const ranked = [...batches.values()].sort(
    (a, b) => worst(a) - worst(b) || a.batch.localeCompare(b.batch),
  );
  const eligible = ranked.filter((b) => b.sensitive.length === 0);
  const parked = ranked.filter((b) => b.sensitive.length > 0);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ eligible, parked }, null, 2));
    return;
  }

  if (!eligible.length) {
    console.log("No batch is agent-safe right now — every queued batch trips the carve-out.");
  } else {
    const top = eligible[0];
    const worstSev = top.bugs
      .map((b) => b.severity)
      .sort((a, b) => (SEVERITY_RANK[a] ?? 4) - (SEVERITY_RANK[b] ?? 4))[0];
    console.log(`next agent-safe batch: ${top.batch}${top.issue ? ` (issue #${top.issue})` : ""}`);
    console.log(`  ${top.bugs.length} queued bug(s), worst severity ${worstSev}`);
    for (const b of top.bugs)
      console.log(`    ${b.id.padEnd(5)} ${String(b.severity).padEnd(8)} ${b.title.slice(0, 76)}`);
    console.log(`\n  claim it:  node scripts/team/team.mjs claim ${top.issue ?? "<issue#>"}`);
  }

  if (parked.length) {
    console.log(`\nparked for owner review (${parked.length} batch(es) trip the carve-out):`);
    for (const b of parked) {
      const why = [
        ...new Set(b.sensitive.flatMap((x) => x.sensitiveFor ?? classify(x).reasons)),
      ].join(", ");
      console.log(
        `    ${b.batch}  ${String(b.sensitive.length).padStart(2)}/${b.bugs.length} sensitive  (${why})`,
      );
    }
  }
};

cmds.list = (args) => {
  const state = readState();
  let rows = readCatalogue();
  if (args.includes("--open"))
    rows = rows.filter((r) => (state.get(r.id)?.state ?? "queued") === "queued");
  if (args.includes("--sensitive")) rows = rows.filter((r) => r.sensitive ?? classify(r).sensitive);
  const batch = flag(args, "batch");
  if (batch) rows = rows.filter((r) => r.batch === batch);
  rows.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4));
  for (const r of rows) {
    const st = state.get(r.id)?.state ?? "—";
    const mark = r.sensitive ? "!" : " ";
    console.log(
      `${r.id.padEnd(5)} ${String(r.severity).padEnd(8)} ${String(r.batch ?? "—").padEnd(5)} ${st.padEnd(10)} ${mark} ${r.title.slice(0, 70)}`,
    );
  }
  console.log(`\n${rows.length} row(s).`);
};

cmds.stats = () => {
  const catalogue = readCatalogue();
  const state = readState();
  const bySeverity = {};
  const byState = {};
  let sensitive = 0;
  for (const r of catalogue) {
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1;
    const st = state.get(r.id)?.state ?? "uncampaigned";
    byState[st] = (byState[st] || 0) + 1;
    if (r.sensitive ?? classify(r).sensitive) sensitive++;
  }
  console.log(`catalogue : ${catalogue.length} bug(s)`);
  console.log(`severity  : ${JSON.stringify(bySeverity)}`);
  console.log(`state     : ${JSON.stringify(byState)}`);
  console.log(`carve-out : ${sensitive} sensitive / ${catalogue.length - sensitive} agent-safe`);
};

// ── the per-bug record ────────────────────────────────────────────────────
// One markdown file per bug, at `.claude/campaign/bugs/B###.md`. This is the
// Jira-card equivalent and it is deliberately a FILE, not a row:
//   * an agent tackling B129 reads ~1 KB, not a 200-row catalogue or a 614 KB
//     HTML — the single biggest token lever in the whole loop;
//   * `git log -p` on one file IS that bug's audit trail, for free;
//   * a human can open, read and edit exactly one bug.
// The narrative sections are written by the analysis pass; the front matter and
// the History log are DERIVED and refreshed by `sync`, so the record cannot
// drift from the proof ledger the way the board did.
const RECORD_DIR = join(ROOT, "bugs");
const recordPath = (id) => join(RECORD_DIR, `${id}.md`);
const SECTIONS = [
  "Summary",
  "What this feature is for",
  "Root cause",
  "User impact",
  "Fix approach and UX",
  "Test plan",
];
const UNANALYSED = "_Not yet analysed._";

function parseRecord(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text };
  const front = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]] = kv[2] === "" ? null : kv[2];
  }
  return { front, body: m[2] };
}

const renderFront = (front) =>
  "---\n" +
  Object.entries(front)
    .map(([k, v]) => (v === null || v === undefined || v === "" ? `${k}:` : `${k}: ${v}`))
    .join("\n") +
  "\n---\n";

const readRecord = (id) =>
  existsSync(recordPath(id)) ? parseRecord(readFileSync(recordPath(id), "utf8")) : null;

function writeRecord(id, front, body) {
  mkdirSync(RECORD_DIR, { recursive: true });
  writeFileSync(recordPath(id), renderFront(front) + body);
}

// History is append-only and deduped on `key` — so sync is idempotent and can
// run from a hook on every turn without growing the file.
function appendHistory(body, key, event, detail) {
  if (body.includes(`<!--${key}-->`)) return body;
  const line = `- ${new Date().toISOString().slice(0, 10)} · **${event}** · ${detail} <!--${key}-->`;
  return body.includes("## History")
    ? `${body.replace(/\s*$/, "")}\n${line}\n`
    : `${body}\n## History\n\n${line}\n`;
}

const frontFor = (bug, st) => ({
  id: bug.id,
  title: bug.title,
  location: bug.location,
  severity: bug.severity,
  batch: st?.batch ?? bug.batch ?? null,
  tier: st?.tier ?? null,
  state: st?.state ?? "uncampaigned",
  proof: st?.state && st.state !== "queued" ? `REG-${bug.id}` : null,
  sensitive: bug.sensitive ?? classify(bug).sensitive,
  sensitiveFor: (bug.sensitiveFor ?? classify(bug).reasons).join(",") || null,
  closed: st && ["done", "already-fixed"].includes(st.state) ? "yes" : null,
});

// Create records that do not exist yet; refresh derived front matter on ones
// that do. NEVER touches a narrative section — analysis is expensive and a
// refresh must not be able to destroy it.
cmds.expand = () => {
  const catalogue = readCatalogue();
  if (!catalogue.length) fail("catalogue is empty — run `import` first");
  const state = readState();
  let created = 0;
  let refreshed = 0;

  for (const bug of catalogue) {
    const st = state.get(bug.id);
    const front = frontFor(bug, st);
    const existing = readRecord(bug.id);

    if (!existing) {
      let body =
        `\n# ${bug.id} · ${bug.title}\n\n` +
        `**Location** \`${bug.location}\` · **Severity** ${bug.severity}` +
        `${front.batch ? ` · **Batch** ${front.batch}` : ""} · **State** ${front.state}\n\n` +
        SECTIONS.map((s) => `## ${s}\n\n${UNANALYSED}\n`).join("\n") +
        `\n## History\n`;
      body = appendHistory(body, `filed`, "filed", `imported from the register (${bug.register})`);
      if (st) body = appendHistory(body, `batch-${st.batch}`, "batched", `assigned to ${st.batch}`);
      if (st && st.state !== "queued")
        body = appendHistory(
          body,
          `state-${st.state}`,
          st.state,
          st.pr ? `PR #${st.pr}` : "recorded in the proof ledger",
        );
      writeRecord(bug.id, front, body);
      created++;
    } else {
      writeRecord(bug.id, { ...existing.front, ...front }, existing.body);
      refreshed++;
    }
  }
  console.log(`records: ${created} created, ${refreshed} refreshed, in ${RECORD_DIR}/`);
};

// The automatic half. Derives history events from the two sources that already
// move on their own — the proof ledger and git — and appends any the record has
// not recorded yet. Idempotent, so it is safe to run from a hook every turn.
cmds.sync = (args) => {
  const catalogue = readCatalogue();
  const state = readState();
  const quiet = args.includes("--quiet");
  const events = [];

  // One git pass for every bug, not one per bug: 210 `git log --grep` calls
  // would dominate the runtime of a hook that fires on every turn.
  const log = execSync("git log --format=%H%x09%s --max-count=400", { encoding: "utf8" });
  const mentions = new Map();
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, subject] = line.split("\t");
    for (const id of new Set(subject.match(/\bB\d{1,3}\b/g) ?? [])) {
      if (!mentions.has(id)) mentions.set(id, []);
      mentions.get(id).push({ sha: sha.slice(0, 8), subject });
    }
  }

  for (const bug of catalogue) {
    const rec = readRecord(bug.id);
    if (!rec) continue;
    const st = state.get(bug.id);
    let body = rec.body;
    const before = body;

    if (st && st.state !== rec.front.state) {
      body = appendHistory(
        body,
        `state-${st.state}`,
        st.state,
        st.pr ? `PR #${st.pr}` : "recorded in the proof ledger",
      );
      events.push(`${bug.id} ${rec.front.state} → ${st.state}`);
    }
    for (const c of mentions.get(bug.id) ?? []) {
      body = appendHistory(body, `commit-${c.sha}`, "commit", `\`${c.sha}\` ${c.subject}`);
      if (body !== before && !events.includes(`${bug.id} commit ${c.sha}`))
        events.push(`${bug.id} commit ${c.sha}`);
    }

    if (body !== before) writeRecord(bug.id, { ...rec.front, ...frontFor(bug, st) }, body);
    else if (st && st.state !== rec.front.state)
      writeRecord(bug.id, { ...rec.front, ...frontFor(bug, st) }, body);
  }

  if (!quiet || events.length) console.log(`sync: recorded ${events.length} new event(s).`);
  for (const e of events.slice(0, 20)) console.log(`  ${e}`);
};

cmds.show = (args) => {
  const id = (args[0] ?? "").toUpperCase();
  if (!/^B\d+$/.test(id)) fail("usage: show <B###>");
  if (!existsSync(recordPath(id))) fail(`no record for ${id} — run \`expand\``);
  process.stdout.write(readFileSync(recordPath(id), "utf8"));
};

// How an analysis agent writes its findings back. `--section` replaces one
// narrative section; without it the text lands as a history note.
cmds.note = (args) => {
  const id = (args[0] ?? "").toUpperCase();
  const text = args[1];
  if (!/^B\d+$/.test(id) || !text || text.startsWith("--"))
    fail('usage: note <B###> "<text>" [--section "Root cause"]');
  const rec = readRecord(id);
  if (!rec) fail(`no record for ${id} — run \`expand\``);
  const section = flag(args, "section");

  if (section) {
    const match = SECTIONS.find((s) => s.toLowerCase() === section.toLowerCase());
    if (!match) fail(`--section must be one of: ${SECTIONS.join(" | ")}`);
    const rx = new RegExp(`(## ${match}\\n\\n)([\\s\\S]*?)(?=\\n## |$)`);
    if (!rx.test(rec.body)) fail(`section "${match}" not found in ${id}`);
    const body = rec.body.replace(rx, `$1${text}\n`);
    writeRecord(id, rec.front, body);
    console.log(`${id}: wrote "${match}".`);
  } else {
    const key = `note-${Date.now()}`;
    writeRecord(id, rec.front, appendHistory(rec.body, key, "note", text));
    console.log(`${id}: history note added.`);
  }
};

// bugs.jsonl is a DERIVED index over the records — regenerate, never hand-edit.
cmds.index = () => {
  if (!existsSync(RECORD_DIR)) fail("no records yet — run `expand`");
  const rows = readdirSync(RECORD_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseRecord(readFileSync(join(RECORD_DIR, f), "utf8")).front)
    .map((fm) => ({
      id: fm.id,
      title: fm.title,
      location: fm.location,
      severity: fm.severity,
      batch: fm.batch,
      register: fm.closed ? "fixed" : "open",
      source: "record",
      sensitive: fm.sensitive === "true",
      sensitiveFor: fm.sensitiveFor ? fm.sensitiveFor.split(",") : [],
    }));
  writeCatalogue(rows);
  console.log(`index: rebuilt bugs.jsonl from ${rows.length} record(s).`);
};

const [, , cmd, ...rest] = process.argv;
if (!cmd || !cmds[cmd])
  fail(`unknown command '${cmd ?? ""}' — try: ${Object.keys(cmds).join(", ")}`);
cmds[cmd](rest);
