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

  // A bug with no ledger row is invisible to campaign-check and to , so
  // filing must create it. Doing this by hand is how B211 first landed.
  if (bug.batch) {
    const tier = flag(args, "tier", "T1");
    const what = upsertLedgerRow(bug.batch, {
      id: bug.id, batch: bug.batch, tier, state: "queued",
      pr: null, proof: null, evidence: null,
    });
    console.log(`  ledger   : ${bug.batch}.jsonl row ${what} (tier ${tier}, queued)`);
  } else {
    console.log("  ledger   : none — pass --batch F## so campaign-check and `next` can see it.");
  }
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
  const line = `- ${new Date().toISOString().slice(0, 10)} · **${event}** · ${String(detail).replace(/\s+/g, " ").trim()} <!--${key}-->`;
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
    // Function replacement, never a string one: a string replacement expands
    // $1 / $& / $` / $' inside the CALLER's text, and analysis prose in a
    // delivery product says "$100" constantly (proved: it shredded B32).
    const body = rec.body.replace(rx, (_m, heading) => `${heading}${text}\n`);
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

// ── ledger writes ─────────────────────────────────────────────────────────
// The proof ledger is REPLACE-IN-PLACE, one row per bug id across all shards —
// campaign-check rejects a duplicate id, and appending a second row for the same
// bug is the first thing anyone tries (it cost a full redo during the F07/F10
// discharge). Every ledger write in this file goes through upsertLedgerRow, so
// that mistake is unrepresentable rather than merely documented.
const shardPath = (batch) => join(STATUS_DIR, `${batch}.jsonl`);

function readShard(batch) {
  const p = shardPath(batch);
  if (!existsSync(p)) return { rows: [], eol: "\n" };
  const raw = readFileSync(p, "utf8");
  return {
    rows: raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
    eol: raw.includes("\r\n") ? "\r\n" : "\n",
  };
}

function upsertLedgerRow(batch, row) {
  const { rows, eol } = readShard(batch);
  const i = rows.findIndex((r) => r.id === row.id);
  if (i === -1) rows.push(row);
  else rows[i] = { ...rows[i], ...row };
  const ids = rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) fail(`refusing to write ${batch}: duplicate id in shard`);
  mkdirSync(STATUS_DIR, { recursive: true });
  writeFileSync(shardPath(batch), rows.map((r) => JSON.stringify(r)).join(eol) + eol);
  return i === -1 ? "added" : "updated";
}

const findShardOf = (id) => {
  for (const f of readdirSync(STATUS_DIR).filter((n) => n.endsWith(".jsonl"))) {
    const batch = f.replace(/\.jsonl$/, "");
    if (readShard(batch).rows.some((r) => r.id === id)) return batch;
  }
  return null;
};

// ── brief: everything an agent needs to start, in one output ───────────────
// The point of the registry is that an agent picking up work reads ONE thing.
// Before this, starting a batch meant assembling the board card, the ledger,
// four record files and the pipeline discovery by hand — which is how an agent
// ends up fixing the right bug the wrong way.
cmds.brief = (args) => {
  const target = (args[0] ?? "").toUpperCase();
  if (!/^(F\d{2}|B\d+)$/.test(target)) fail("usage: brief <F##|B###>");

  const board = existsSync(BOARD) ? JSON.parse(readFileSync(BOARD, "utf8")) : { batches: {} };
  const ids = /^B/.test(target)
    ? [target]
    : readShard(target).rows.map((r) => r.id);
  if (!ids.length) fail(`no ledger rows for ${target}`);
  const batch = /^B/.test(target) ? findShardOf(target) : target;

  const state = readState();
  const out = [];
  out.push(`# ${batch}${board.batches?.[batch] ? ` · board issue #${board.batches[batch]}` : ""}`);

  const pipelineDir = existsSync(".claude/pipeline")
    ? readdirSync(".claude/pipeline").find((d) => d.toUpperCase().includes(`-${batch}-`))
    : null;
  const discovery = pipelineDir ? join(".claude/pipeline", pipelineDir, "discovery.md") : null;

  const rows = ids.map((id) => ({ id, st: state.get(id), rec: readRecord(id) }));
  const analysed = rows.filter((r) => r.rec && !r.rec.body.includes(UNANALYSED));
  out.push(
    `\n${rows.length} bug(s) · ${rows.filter((r) => r.st?.state === "queued").length} queued · ` +
      `${analysed.length}/${rows.length} analysed` +
      (rows.some((r) => r.rec?.front.sensitive === "true") ? " · ⚠ CONTAINS CARVE-OUT BUGS — plan only, do not fix unattended" : ""),
  );

  if (discovery && existsSync(discovery)) {
    out.push(`\n## Batch plan\n\nRead this FIRST — it carries the ordering, the file conflicts and the risks:\n\n    ${discovery}`);
    const txt = readFileSync(discovery, "utf8");
    const verdict = /## Verdict\n\n([\s\S]*?)(?=\n## )/.exec(txt);
    if (verdict) out.push(`\n${verdict[1].trim()}`);
    const order = /## Ordering\n\n([\s\S]*?)(?=\n## )/.exec(txt);
    if (order) out.push(`\n## Ordering\n\n${order[1].trim()}`);
  } else {
    out.push(`\n## Batch plan\n\n⚠ none yet — run the analysis pass before fixing (see the bug-registry skill).`);
  }

  out.push(`\n## Bugs`);
  for (const { id, st, rec } of rows) {
    const f = rec?.front ?? {};
    out.push(
      `\n### ${id} · ${f.severity ?? "?"} · ${st?.state ?? "—"} · tier ${st?.tier ?? f.tier ?? "?"}` +
        `${f.sensitive === "true" ? ` · ⚠ carve-out (${f.sensitiveFor})` : ""}`,
    );
    out.push(`${f.title ?? ""}`);
    out.push(`\`${f.location ?? ""}\``);
    if (!rec) {
      out.push(`_no record — run \`bugs expand\`_`);
      continue;
    }
    for (const s of ["Summary", "Fix approach and UX", "Test plan"]) {
      const m = new RegExp(`## ${s}\\n\\n([\\s\\S]*?)(?=\\n## |$)`).exec(rec.body);
      if (m) out.push(`\n**${s}**\n\n${m[1].trim()}`);
    }
    out.push(`\nFull record: \`.claude/campaign/bugs/${id}.md\``);
  }

  out.push(`\n## When you finish`);
  out.push(
    `    npm run bugs -- prove <B###> --pr <n> --proof "REG-B### <what the passing test asserts>"\n` +
      `    npm run bugs -- discharge ${batch} --evidence "<post-deploy proof>"   # only AFTER a green deploy`,
  );
  process.stdout.write(out.join("\n") + "\n");
};

// ── prove / discharge: the two ledger transitions ──────────────────────────
// proven = merged with a passing REG-B### test. done = live after a green
// deploy. Keeping them separate is the whole reason campaign-check can be
// trusted, so neither command will invent the other's evidence.
cmds.prove = (args) => {
  const id = (args[0] ?? "").toUpperCase();
  const pr = flag(args, "pr");
  const proof = flag(args, "proof");
  if (!/^B\d+$/.test(id) || !pr || !proof)
    fail('usage: prove <B###> --pr <number> --proof "REG-B### <what the passing test asserts>"');
  if (!new RegExp(`REG-${id}(?![0-9])`).test(proof))
    fail(`--proof must cite the exact token REG-${id} — campaign-check matches that token and nothing else`);

  const batch = findShardOf(id);
  if (!batch) fail(`${id} is in no ledger shard — file it with a --batch first`);
  const row = readShard(batch).rows.find((r) => r.id === id);
  const pending = args.includes("--pending-deploy");
  const state = pending ? "proven-pending-deploy" : "proven";
  if (pending && row.tier !== "T2")
    fail("--pending-deploy is for T2 rows only (their proof cannot run pre-merge)");

  const what = upsertLedgerRow(batch, { ...row, state, pr: Number(pr), proof });
  const rec = readRecord(id);
  if (rec)
    writeRecord(id, { ...rec.front, state, proof: `REG-${id}` }, appendHistory(rec.body, `state-${state}`, state, `PR #${pr}`));
  console.log(`${id}: ${batch} row ${what} → ${state} (PR #${pr})`);
  console.log(`  discharge to done only after a green deploy: npm run bugs -- discharge ${batch} --evidence "..."`);
};

cmds.discharge = (args) => {
  const batch = (args[0] ?? "").toUpperCase();
  const evidence = flag(args, "evidence");
  if (!/^F\d{2}$/.test(batch) || !evidence)
    fail('usage: discharge <F##> --evidence "<post-deploy proof: deploy id + the CI run that exercised it>"');
  if (evidence.length < 40)
    fail("--evidence must actually cite the deploy and the run that proved it — this is the claim campaign-check cannot check for you");

  const { rows } = readShard(batch);
  const ready = rows.filter((r) => r.state === "proven" || r.state === "proven-pending-deploy");
  if (!ready.length) fail(`${batch} has no proven row to discharge (states: ${[...new Set(rows.map((r) => r.state))].join(", ")})`);

  for (const row of ready) {
    upsertLedgerRow(batch, { ...row, state: "done", dischargeEvidence: evidence });
    const rec = readRecord(row.id);
    if (rec)
      writeRecord(
        row.id,
        { ...rec.front, state: "done", closed: "yes" },
        appendHistory(rec.body, "state-done", "done", evidence.slice(0, 200)),
      );
  }
  console.log(`${batch}: discharged ${ready.length} row(s) → done — ${ready.map((r) => r.id).join(", ")}`);
  console.log(`  verify: node scripts/campaign-check.mjs`);
};

cmds.status = (args) => {
  const only = (args[0] ?? "").toUpperCase();
  const board = existsSync(BOARD) ? JSON.parse(readFileSync(BOARD, "utf8")) : { batches: {} };
  const batches = readdirSync(STATUS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""))
    .filter((b) => !only || b === only)
    .sort();
  for (const b of batches) {
    const { rows } = readShard(b);
    if (!rows.length) continue;
    const by = {};
    for (const r of rows) by[r.state] = (by[r.state] || 0) + 1;
    const analysed = rows.filter((r) => {
      const rec = readRecord(r.id);
      return rec && !rec.body.includes(UNANALYSED);
    }).length;
    const done = (by.done || 0) + (by["already-fixed"] || 0);
    console.log(
      `${b.padEnd(4)} ${String(done + "/" + rows.length).padStart(6)} done · ${String(analysed).padStart(2)} analysed · ` +
        `${board.batches?.[b] ? "#" + board.batches[b] : "  —  "}  ${Object.entries(by).map(([k, v]) => `${k}:${v}`).join(" ")}`,
    );
  }
};

// ── self-test ─────────────────────────────────────────────────────────────
// Three defects shipped from this file in one session — trailing-space churn,
// silent no-op edits, and $-expansion in note() — all the same family: a write
// path that reports success without checking what it wrote. These assert the
// round-trips rather than trusting them.
cmds["self-test"] = () => {
  let failures = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  };

  // front matter must round-trip, and an empty field must NOT gain a trailing
  // space — prettier strips it, so a space makes every refresh dirty the tree.
  const front = { id: "B1", title: "x", batch: null, closed: null };
  const rendered = renderFront(front);
  check("renderFront: no trailing space on empty field", /: $/m.test(rendered), false);
  check("renderFront/parseRecord round-trip", parseRecord(rendered + "body").front, {
    id: "B1",
    title: "x",
    batch: null,
    closed: null,
  });

  // note() text must survive $-patterns verbatim.
  const body = "## Summary\n\nOLD\n\n## Root cause\n\nx\n";
  const text = "Driver loses $100; also $& and $` and $'.";
  const rx = new RegExp(`(## Summary\\n\\n)([\\s\\S]*?)(?=\\n## |$)`);
  check("note: $-patterns survive verbatim", rx.test(body) && body.replace(rx, (_m, h) => `${h}${text}\n`).includes(text), true);

  // history must dedupe on its marker, or Gate 4 grows the file every turn.
  const once = appendHistory("## History\n", "k1", "e", "d");
  check("appendHistory: idempotent on the same key", appendHistory(once, "k1", "e", "d"), once);

  // the ledger must hold exactly one row per id, repo-wide.
  const seen = new Map();
  let dupes = 0;
  for (const f of readdirSync(STATUS_DIR).filter((n) => n.endsWith(".jsonl")))
    for (const r of readShard(f.replace(/\.jsonl$/, "")).rows) {
      if (seen.has(r.id)) dupes++;
      seen.set(r.id, true);
    }
  check("ledger: one row per bug id across all shards", dupes, 0);

  // every catalogue row should have a record, or `brief` renders holes.
  const missing = readCatalogue().filter((b) => !existsSync(recordPath(b.id))).map((b) => b.id);
  check("every catalogue row has a record", missing, []);

  // Every history entry must be exactly ONE line. A detail containing a newline
  // used to split the entry and leave loose prose floating in the section
  // (B32/B34/B129/B146 all carried one), which reads as a corrupted record.
  const strays = [];
  for (const f of readdirSync(RECORD_DIR).filter((n) => n.endsWith(".md"))) {
    const t = readFileSync(join(RECORD_DIR, f), "utf8");
    const i = t.indexOf("## History");
    if (i < 0) continue;
    for (const l of t.slice(i).split("\n"))
      if (l.trim() && !l.startsWith("- ") && !l.startsWith("#")) strays.push(`${f}: ${l.slice(0, 40)}`);
  }
  check("history: every entry is a single line", strays, []);

  // Exactly one History heading per record. A second one means a $-pattern in
  // caller text was expanded into the body by a string replacement — enrich hit
  // this on B109, whose evidence says "$235.00 vs PERCENT's $181.05", so `$1`
  // became the captured heading. Cheaper to diagnose than the stray-line check.
  const multiHistory = readdirSync(RECORD_DIR)
    .filter((n) => n.endsWith(".md"))
    .filter((n) => (readFileSync(join(RECORD_DIR, n), "utf8").match(/^## History$/gm) || []).length !== 1);
  check("exactly one '## History' heading per record", multiHistory, []);

  console.log(failures ? `\nself-test: ${failures} FAILURE(S)` : "\nself-test: all checks passed");
  if (failures) process.exit(1);
};

// Re-batching is a first-class registry operation, not a hand edit. The analysis
// pass routinely concludes a bug is in the wrong batch (F11's synthesis said
// exactly that about B32), and doing it by hand means editing two shards, the
// record front matter and the catalogue — four places, each an opportunity to
// leave the ledger holding two rows for one id.
cmds.move = (args) => {
  const id = (args[0] ?? "").toUpperCase();
  const to = (flag(args, "to") ?? "").toUpperCase();
  const why = flag(args, "why");
  if (!/^B\d+$/.test(id) || !/^F\d{2}$/.test(to))
    fail('usage: move <B###> --to <F##> [--why "<reason>"]');

  const from = findShardOf(id);
  if (!from) fail(`${id} is in no ledger shard — nothing to move`);
  if (from === to) fail(`${id} is already in ${to}`);

  const row = readShard(from).rows.find((r) => r.id === id);
  if (row.state !== "queued")
    fail(`${id} is ${row.state}, not queued — moving a bug that already carries a proof would orphan it from its batch's evidence`);

  // Drop from the old shard first: two rows for one id is the duplicate
  // campaign-check rejects, so never let both exist even momentarily.
  const old = readShard(from);
  const kept = old.rows.filter((r) => r.id !== id);
  writeFileSync(shardPath(from), kept.map((r) => JSON.stringify(r)).join(old.eol) + (kept.length ? old.eol : ""));
  upsertLedgerRow(to, { ...row, batch: to });

  const rows = readCatalogue();
  const cat = rows.find((r) => r.id === id);
  if (cat) {
    cat.batch = to;
    writeCatalogue(rows);
  }

  const rec = readRecord(id);
  if (rec) {
    const body = appendHistory(
      rec.body,
      `move-${from}-${to}`,
      "re-batched",
      `${from} → ${to}${why ? ` — ${why}` : ""}`,
    );
    writeRecord(id, { ...rec.front, batch: to }, body);
  }

  console.log(`${id}: ${from} → ${to}${why ? ` (${why})` : ""}`);
  console.log(`  ${from} now holds ${kept.length} row(s); verify with: node scripts/campaign-check.mjs`);
};

// ── enrich: pull the register's DETAIL into every record ──────────────────
// `import` only ever read the register's summary TABLE — id, title, area,
// severity, status — so 207 of 211 records carried a one-line title and nothing
// else. The register's detail blocks hold what an agent actually needs (what the
// feature was meant to do, what it does instead, the gap, file:line evidence, a
// suggested fix and the verifier's note) AND, in 209 of 210 cases, the file
// paths that make a dependency graph computable at all. Leaving that in a
// gitignored HTML file was the same mistake the catalogue was built to fix.
//
// Writes ONLY the front-matter `files` list and a `## Reported evidence`
// section. The six analysis sections stay reserved for the analysis pass, so
// "analysed" keeps meaning "a model reasoned about this", not "we have prose".
const FILE_RX =
  /(?:apps|packages|scripts)\/[A-Za-z0-9_.\/()\[\]@-]*\.(?:tsx|jsx|mjs|cjs|prisma|ts|js)/g;

function registerDetail(html, id) {
  const i = html.indexOf(`<span class="bug-id">${id}</span>`);
  if (i < 0) return null;
  const j = html.indexOf('<span class="bug-id">', i + 10);
  const block = html.slice(i, j > 0 ? j : html.length);
  const pick = (rx) => {
    const m = rx.exec(block);
    return m ? stripTags(m[1]) : null;
  };
  return {
    meant: pick(/<dt>Meant to do<\/dt>\s*<dd>([\s\S]*?)<\/dd>/),
    actual: pick(/<dt>Actually does<\/dt>\s*<dd>([\s\S]*?)<\/dd>/),
    gap: pick(/<dt[^>]*>The gap<\/dt>\s*<dd>([\s\S]*?)<\/dd>/),
    evidence: pick(/<div class="evidence">([\s\S]*?)<\/div>/),
    suggested: pick(/<strong>Suggested fix:<\/strong>([\s\S]*?)<\/p>/),
    verifier: pick(/<strong>Verifier's note:<\/strong>([\s\S]*?)<\/p>/),
    provenance: pick(/<p class="verinote">([\s\S]*?)<\/p>/),
    files: [...new Set(block.match(FILE_RX) || [])].sort(),
  };
}

cmds.enrich = () => {
  if (!existsSync(REGISTER))
    fail(`register not found at ${REGISTER} (gitignored — this runs on the owner's machine only)`);
  const html = readFileSync(REGISTER, "utf8");
  let enriched = 0;
  let noDetail = 0;
  let files = 0;

  for (const bug of readCatalogue()) {
    const rec = readRecord(bug.id);
    if (!rec) continue;
    const d = registerDetail(html, bug.id);
    if (!d || (!d.actual && !d.evidence)) {
      noDetail++;
      continue;
    }

    const parts = ["_Imported verbatim from the bug register — this is the ORIGINAL report, not analysis._", ""];
    if (d.meant) parts.push(`**Meant to do.** ${d.meant}`, "");
    if (d.actual) parts.push(`**Actually does.** ${d.actual}`, "");
    if (d.gap) parts.push(`**The gap.** ${d.gap}`, "");
    if (d.evidence) parts.push(`**Evidence.** ${d.evidence}`, "");
    if (d.suggested)
      parts.push(
        `**Suggested fix (register).** ${d.suggested}`,
        "",
        "> ⚠️ Treat this as a hypothesis, not a plan. On F11 the adversarial pass refuted the",
        "> suggested fix for every one of the four bugs while confirming every diagnosis.",
        "",
      );
    if (d.verifier) parts.push(`**Verifier's note.** ${d.verifier}`, "");
    if (d.provenance) parts.push(`_${d.provenance}_`, "");
    if (d.files.length) parts.push(`**Files implicated (${d.files.length}):**`, ...d.files.map((f) => `- \`${f}\``), "");

    const section = `## Reported evidence\n\n${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
    const body = rec.body.includes("## Reported evidence")
      ? rec.body.replace(/## Reported evidence\n[\s\S]*?(?=\n## History)/, () => section)
      : rec.body.replace(/(\n## History)/, (_m, h) => `\n${section}${h}`);

    writeRecord(bug.id, { ...rec.front, files: d.files.join(" ") || null }, body);
    enriched++;
    files += d.files.length;
  }
  console.log(`enriched ${enriched} record(s) with the register detail; ${files} file references captured.`);
  if (noDetail) console.log(`  ${noDetail} record(s) had no detail block in the register.`);
};

// ── deps: the dependency graph, computed not maintained ───────────────────
// Two bugs conflict when they touch the same file: they must land in one batch
// or be serialised, never worked in parallel. That is set intersection over the
// `files` list enrich captured, so waves can be COMPUTED rather than argued
// about. Every hand-maintained index here has drifted (the board by three cards,
// the ledger by thirteen rows); a derived graph cannot.
//
// ⚠️ HUB FILES ARE THE WHOLE DIFFICULTY. A naive "shares a file ⇒ conflicts"
// rule reported that NO batch was ever parallel-safe, which is useless. The
// cause: six god-files dominate the repo — orders.service.ts is touched by 39
// bugs, invoices.service.ts by 31, routes.service.ts by 29, schema.prisma by 27.
// Two bugs in a 5,000-line service almost always touch different methods, so a
// hub overlap is a REVIEW signal, not a conflict. Only a shared NON-hub file is
// treated as hard. The threshold is data, not a constant, and `--hub-threshold`
// exposes it because the right cut-off is a judgement the repo may change.
const HUB_DEFAULT = 10;

const fileSet = (id) => {
  const raw = readRecord(id)?.front?.files;
  return new Set(raw ? raw.split(" ").filter(Boolean) : []);
};

function buildGraph(hubThreshold) {
  const state = readState();
  const bugs = [...state.keys()].filter((id) => existsSync(recordPath(id)));
  const files = new Map(bugs.map((id) => [id, fileSet(id)]));

  const freq = new Map();
  for (const set of files.values()) for (const f of set) freq.set(f, (freq.get(f) || 0) + 1);
  const hubs = new Set([...freq].filter(([, n]) => n >= hubThreshold).map(([f]) => f));

  const batchOf = new Map(bugs.map((id) => [id, state.get(id).batch]));
  const edges = new Map(bugs.map((id) => [id, new Map()]));
  for (let a = 0; a < bugs.length; a++)
    for (let b = a + 1; b < bugs.length; b++) {
      const shared = [...files.get(bugs[a])].filter((f) => files.get(bugs[b]).has(f));
      if (!shared.length) continue;
      const hard = shared.filter((f) => !hubs.has(f));
      const edge = { shared, hard };
      edges.get(bugs[a]).set(bugs[b], edge);
      edges.get(bugs[b]).set(bugs[a], edge);
    }
  return { bugs, files, batchOf, edges, state, hubs, freq };
}

cmds.deps = (args) => {
  const hubThreshold = Number(flag(args, "hub-threshold", HUB_DEFAULT));
  const g = buildGraph(hubThreshold);
  const one = (flag(args, "bug") ?? "").toUpperCase();
  const openOnly = !args.includes("--all");
  const isOpen = (id) => g.state.get(id)?.state === "queued";

  if (one) {
    if (!g.edges.has(one)) fail(`${one} has no record or no ledger row`);
    console.log(`${one} — ${g.files.get(one).size} file(s), batch ${g.batchOf.get(one)}`);
    const conflicts = [...g.edges.get(one)].sort((x, y) => y[1].hard.length - x[1].hard.length);
    const hard = conflicts.filter(([, e]) => e.hard.length);
    if (!hard.length) console.log("  no HARD conflict with any other bug — only god-file overlap, safe to fix alone.");
    for (const [other, e] of hard)
      console.log(
        `    ${other.padEnd(5)} ${g.batchOf.get(other) === g.batchOf.get(one) ? "same batch" : "BATCH " + String(g.batchOf.get(other)).padEnd(4)} ` +
          `${e.hard.length} shared: ${e.hard.slice(0, 2).join(", ")}${e.hard.length > 2 ? " …" : ""}`,
      );
    const soft = conflicts.filter(([, e]) => !e.hard.length).length;
    if (soft) console.log(`  (+ ${soft} bug(s) sharing only god-files — review, not conflict)`);
    return;
  }

  console.log(`Hub files (touched by >= ${hubThreshold} bugs, treated as shared surface not conflict):`);
  for (const f of [...g.hubs].sort((a, b) => g.freq.get(b) - g.freq.get(a)))
    console.log(`  ${String(g.freq.get(f)).padStart(3)}  ${f}`);

  const batches = new Map();
  for (const id of g.bugs) {
    if (openOnly && !isOpen(id)) continue;
    const b = g.batchOf.get(id);
    if (!batches.has(b)) batches.set(b, []);
    batches.get(b).push(id);
  }

  console.log("\nBATCH COHESION — a bug sharing no NON-hub file with its batch-mates is an outlier\n");
  const outliers = [];
  for (const b of [...batches.keys()].sort()) {
    const ids = batches.get(b);
    const inner = ids.filter((id) => ids.some((o) => o !== id && (g.edges.get(id).get(o)?.hard.length ?? 0) > 0));
    const out = ids.filter((id) => !inner.includes(id));
    outliers.push(...out.map((id) => ({ id, batch: b })));
    console.log(
      `${b.padEnd(4)} ${String(inner.length + "/" + ids.length).padStart(6)} cohesive` +
        (out.length ? `   outliers: ${out.join(", ")}` : ""),
    );
  }

  console.log("\nCROSS-BATCH HARD CONFLICTS — these share a non-hub file and MUST NOT run in parallel\n");
  const pairs = new Map();
  for (const id of g.bugs) {
    if (openOnly && !isOpen(id)) continue;
    for (const [other, e] of g.edges.get(id)) {
      if (openOnly && !isOpen(other)) continue;
      if (!e.hard.length) continue;
      const a = g.batchOf.get(id);
      const b = g.batchOf.get(other);
      if (a === b || !a || !b) continue;
      const key = [a, b].sort().join(" <-> ");
      if (!pairs.has(key)) pairs.set(key, new Set());
      e.hard.forEach((f) => pairs.get(key).add(f));
    }
  }
  const ranked = [...pairs].sort((x, y) => y[1].size - x[1].size);
  for (const [key, fs2] of ranked)
    console.log(`  ${key.padEnd(15)} ${String(fs2.size).padStart(2)}: ${[...fs2].slice(0, 2).join(", ")}${fs2.size > 2 ? " …" : ""}`);
  if (!ranked.length) console.log("  none.");

  const conflicted = new Set(ranked.flatMap(([k]) => k.split(" <-> ")));
  const free = [...batches.keys()].filter((b) => !conflicted.has(b)).sort();
  console.log(`\nPARALLEL-SAFE BATCHES (no hard conflict with any other open batch):\n  ${free.length ? free.join(" ") : "none"}`);
  if (outliers.length)
    console.log(`\nOUTLIERS worth re-batching:\n  ${outliers.map((o) => `${o.id}(${o.batch})`).join(" ")}`);
};

const [, , cmd, ...rest] = process.argv;
if (!cmd || !cmds[cmd])
  fail(`unknown command '${cmd ?? ""}' — try: ${Object.keys(cmds).join(", ")}`);
cmds[cmd](rest);
