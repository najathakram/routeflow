// Snapshot: folds the human events and joins them with the derived-fact sources into the one
// JSON document the UI and generated views consume. Pure given its inputs.
import { BUG_ID_RE, DONE_STATUSES } from "./schema.mjs";
import { fold } from "./fold.mjs";
import { parseEta } from "./ids.mjs";
import { pickNext, laneNow } from "./next.mjs";
import { areaDomain, buildAreaTree, fileToArea, guessDomainFromText } from "./areas.mjs";
import { fixLinksFor, linkItemFor, reconcile } from "./reconcile.mjs";
import { summarizeChecks } from "./collector.mjs";

export { linkItemFor };

const SOURCE_NAMES = ["specs", "github", "branches", "bugs", "areas", "railway"];
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const SEVERITIES = ["critical", "high", "medium", "low"];

/** Free-text train labels that mean a release (lead extends this in ops/config.json). */
export const DEFAULT_TRAIN_ALIASES = { "window 2": "R1" };
/** Lane id -> handoff file prefix in routeflow-specs handoff/lanes (default: the lane id). */
export const LANE_HANDOFF_PREFIX = { macmini: "macmini-lane", macbook: "macbook-lane" };

/** Owner-facing status words (accuracy round ruling 2). */
export const STATUS_WORDS = {
  live: "Fixed",
  verified: "Fixed",
  spec: "Being specified",
  building: "Being built",
  review: "In review",
  ready: "Ready to ship",
  shipping: "Shipping",
  planned: "Planned",
  idea: "Idea",
  parked: "Parked",
  dropped: "Dropped",
};

/** Word the owner reads for an item. Decisions: done -> Answered, a BOOKED queue row -> Booked. */
export function statusLabelFor(item, { booked = false, answered = false } = {}) {
  if (item.type === "decision") {
    if (answered || item.status === "live" || item.status === "verified") return "Answered";
    if (booked) return "Booked";
  }
  return STATUS_WORDS[item.status] ?? item.status;
}

const iso = (ms) =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const toMs = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const uniq = (a) => [...new Set(a)];
const isDone = (it) => DONE_STATUSES.includes(it.status);
const boardTagged = (it) => (it.tags ?? []).some((t) => t === "problem" || t === "owner-ask");

function compareIds(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
const byPriorityThenId = (a, b) =>
  (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || compareIds(a.id, b.id);

function itemDomain(item, bugById) {
  const a = item.area;
  if (typeof a === "string" && a.startsWith("domain:")) return a.slice(7);
  if (typeof a === "string" && a.includes(":")) return areaDomain(a);
  const bug = bugById.get(item.id);
  if (bug?.domain) return bug.domain;
  return guessDomainFromText(item.title) ?? "other";
}

const sameSha = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length >= 7 &&
  b.length >= 7 &&
  (a.startsWith(b) || b.startsWith(a));

/**
 * Cut-off time for "deployed": a PR merged at or before it is in the latest SUCCESS deploy of the
 * api or web service. The deploy's sha is mapped to a merged PR's merge commit (that PR's merge
 * time is the cut); a deploy of master's head covers everything; otherwise the deploy's own
 * creation time. No successful deploy -> -Infinity (nothing is deployed).
 */
function deployCut(deploys, mergedRaw, master) {
  const ok = (deploys ?? []).filter(
    (d) =>
      String(d.status ?? "").toUpperCase() === "SUCCESS" &&
      /(?:^|[^a-z0-9])(?:api|web)(?:[^a-z0-9]|$)/i.test(d.service ?? "") &&
      toMs(d.createdAt) !== null,
  );
  if (!ok.length) return -Infinity;
  const latest = ok.reduce((a, b) => (toMs(b.createdAt) > toMs(a.createdAt) ? b : a));
  if (latest.sha) {
    if (master?.sha && sameSha(latest.sha, master.sha)) return Infinity;
    const pr = mergedRaw.find((p) => p.mergeSha && sameSha(p.mergeSha, latest.sha));
    if (pr && toMs(pr.mergedAt) !== null) return toMs(pr.mergedAt);
  }
  return toMs(latest.createdAt);
}

function trainIdsOf(item, aliases) {
  const out = new Set();
  for (const text of [item.train, item.trainLabel]) {
    if (typeof text !== "string" || !text) continue;
    for (const m of text.matchAll(/\bR(\d+)\b/g)) out.add(`R${m[1]}`);
    for (const [phrase, id] of Object.entries(aliases)) {
      const p = String(phrase)
        .toLowerCase()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (p && new RegExp(`(?<![a-z0-9])${p}(?![a-z0-9])`, "i").test(text)) out.add(id);
    }
  }
  return out;
}

const bugItemStatus = (row) => {
  const w = String(row?.ledgerState ?? row?.state ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
  if (["done", "fixed", "already-fixed", "proven", "closed", "verified", "live"].includes(w))
    return "live";
  if (w === "proven-pending-deploy") return "shipping";
  if (["refuted", "duplicate", "wontfix"].includes(w)) return "dropped";
  return "planned";
};
const sevPriority = (s) =>
  ({ critical: "P0", high: "P1", medium: "P2", low: "P3" })[String(s ?? "").toLowerCase()] ?? "P2";

function derivedItem(base) {
  return {
    parent: null,
    eta: null,
    etaAt: null,
    gate: null,
    train: null,
    trainLabel: null,
    lane: null,
    area: null,
    tags: [],
    members: [],
    related: [],
    links: { prs: [], branches: [], urls: [] },
    refPrs: [],
    registerFields: {},
    problem: null,
    impact: null,
    solution: null,
    ownerAsk: null,
    summaryDraft: false,
    answeredAt: null,
    children: [],
    claimedBy: null,
    claimedAt: null,
    claimConflict: null,
    blocked: null,
    overlay: false,
    derived: true,
    ...base,
  };
}

const QUEUE_ANSWER_WORDS = new Set(["ANSWERED", "DONE", "STANDING YES", "DEFAULT IN EFFECT"]);
const QUEUE_HOLD_WORDS = new Set(["BOOKED", "OPEN", "CHECK"]);

/** Epoch ms for an owner-queue row's answer date: the decision file date, else its `M-D`. */
function queueRowDate(row, now) {
  const f = /^D-(\d{4})-(\d{2})-(\d{2})-/.exec(row?.decisionFile ?? "");
  if (f) return Date.UTC(Number(f[1]), Number(f[2]) - 1, Number(f[3]));
  const d = /^(\d{1,2})-(\d{1,2})$/.exec(row?.asOf ?? "");
  if (!d) return null;
  const year = new Date(now).getUTCFullYear();
  let ms = Date.UTC(year, Number(d[1]) - 1, Number(d[2]));
  if (ms > now + 2 * 86400_000) ms = Date.UTC(year - 1, Number(d[1]) - 1, Number(d[2]));
  return ms;
}

export function buildSnapshot({ sources = {}, config, now, machine = null, authEnabled }) {
  const specsData = sources.specs?.data ?? null;
  const cfg = config ?? specsData?.config;
  const events = specsData?.events ?? [];
  const bugsAll = sources.bugs?.data?.bugs ?? [];
  const bugById = new Map(bugsAll.map((b) => [b.id, b]));
  const bugsMap = new Map(
    bugsAll.map((b) => [b.id, { title: b.title, state: b.state, severity: b.severity }]),
  );
  const state = fold(events, { bugs: bugsMap });
  const knownIds = new Set(state.items.keys());

  const gh = sources.github?.data ?? null;
  const openRaw = gh?.open ?? [];
  const mergedRaw = gh?.merged ?? [];
  const branchesRaw = sources.branches?.data?.branches ?? [];
  const areasOf = (files) => uniq((files ?? []).map((f) => fileToArea(f).area));

  // ---- CI: gate vs probes (config.ciGates) ----
  const checkOf = (runs) => {
    const s = summarizeChecks(runs ?? [], cfg);
    return { gate: s.gate, probesFailing: s.probesFailing, runs: s.runs };
  };
  const checkGateOf = (runs) => {
    const { gate, probesFailing } = checkOf(runs);
    return { gate, probesFailing };
  };

  const openPrs = openRaw.map((p) => ({
    number: p.number,
    title: p.title,
    draft: Boolean(p.draft),
    branch: p.branch,
    headSha: p.headSha ?? null,
    checks: p.checks ?? null,
    ...checkGateOf(p.runs),
    updatedAt: p.updatedAt ?? null,
    url: p.url ?? null,
    areas: areasOf(p.files),
    item: linkItemFor({ number: p.number, branch: p.branch, title: p.title, body: p.body }, state),
  }));
  const mergedPrs = mergedRaw.map((p) => ({
    number: p.number,
    title: p.title,
    branch: p.branch,
    mergedAt: p.mergedAt ?? null,
    mergeSha: p.mergeSha ?? null,
    url: p.url ?? null,
    item: linkItemFor({ number: p.number, branch: p.branch, title: p.title, body: p.body }, state),
  }));
  const openByBranch = new Map(openPrs.map((p) => [p.branch, p]));
  const branches = branchesRaw.map((b) => {
    const pr = openByBranch.get(b.branch) ?? null;
    return {
      branch: b.branch,
      sha: b.sha,
      date: b.date,
      areas: areasOf(b.files),
      item: pr?.item ?? linkItemFor({ branch: b.branch }, state),
      pr: pr ? pr.number : null,
    };
  });

  // ---- sources ----
  const factor = cfg?.thresholds?.sourceStaleFactor ?? 3;
  const outSources = {};
  for (const name of SOURCE_NAMES) {
    const s = sources[name];
    const at = s?.at ?? null;
    const intervalSec = s?.intervalSec ?? null;
    const ageSec = at === null ? null : Math.max(0, Math.round((now - at) / 1000));
    outSources[name] = {
      ok: Boolean(s?.ok),
      at: iso(at),
      ageSec,
      stale: at === null || (intervalSec !== null && ageSec > intervalSec * factor),
      error: s?.error ?? (s ? null : "not started"),
      intervalSec,
    };
  }

  // ---- ci (deploys are needed by the bug fix states, so this comes early) ----
  const deploys = (sources.railway?.data?.deploys ?? []).map((d) => ({
    service: d.service,
    status: d.status,
    sha: d.sha,
    createdAt: d.createdAt,
    source: d.source ?? "railway",
    ...(d.github ? { github: d.github } : {}),
  }));
  const ci = {
    master: gh?.master
      ? {
          sha: gh.master.sha,
          date: gh.master.date,
          headline: gh.master.headline,
          checks: gh.master.checks,
          ...checkOf(gh.master.runs),
        }
      : null,
    visibility: gh?.visibility ?? null,
    deploys,
  };

  // ---- trains (R tokens in train / trainLabel + config.trainAliases) ----
  const aliases = { ...DEFAULT_TRAIN_ALIASES, ...(cfg?.trainAliases ?? {}) };
  const stateItems = [...state.items.values()];
  const trainIdsByItem = new Map(stateItems.map((x) => [x.id, trainIdsOf(x, aliases)]));
  const releases = stateItems.filter((it) => it.type === "release");
  const trains = releases
    .map((it) => ({
      id: it.id,
      title: it.title,
      status: it.status,
      eta: it.eta,
      etaAt: iso(parseEta(it.eta, now)),
      members: uniq([
        ...it.members,
        ...stateItems
          .filter((x) => x.train === it.id || trainIdsByItem.get(x.id)?.has(it.id))
          .map((x) => x.id),
      ]),
    }))
    .sort(
      (a, b) =>
        (Number(/\d+/.exec(a.id)?.[0]) || 99) - (Number(/\d+/.exec(b.id)?.[0]) || 99) ||
        compareIds(a.id, b.id),
    );
  const releaseOf = new Map();
  for (const t of trains) for (const m of t.members) if (!releaseOf.has(m)) releaseOf.set(m, t.id);

  // ---- bugs: fix state per bug, from the PRs / branches that NAME it ----
  const named = new Map(); // B-id -> { open, merged, branches }
  const slot = (id) => {
    if (!named.has(id)) named.set(id, { open: [], merged: [], branches: [] });
    return named.get(id);
  };
  for (const p of openRaw)
    for (const id of fixLinksFor(p, knownIds)) if (BUG_ID_RE.test(id)) slot(id).open.push(p);
  for (const p of mergedRaw)
    for (const id of fixLinksFor(p, knownIds)) if (BUG_ID_RE.test(id)) slot(id).merged.push(p);
  for (const b of branchesRaw)
    for (const id of fixLinksFor({ branch: b.branch }, knownIds))
      if (BUG_ID_RE.test(id)) slot(id).branches.push(b);
  const openHeads = new Set(openRaw.map((p) => p.branch));
  const cut = deployCut(deploys, mergedRaw, gh?.master);
  const newest = (a, key) => [...a].sort((x, y) => (toMs(y[key]) ?? 0) - (toMs(x[key]) ?? 0));

  function fixFor(bug) {
    const n = named.get(bug.id) ?? { open: [], merged: [], branches: [] };
    const filed = toMs(bug.filedAt);
    const fixOf = (state_, p, branch = p.branch) => ({
      state: state_,
      pr: p.number,
      prUrl: p.url ?? null,
      branch: branch ?? null,
    });
    const hit = newest(
      n.merged.filter(
        (p) =>
          (!p.base || p.base === "master") &&
          toMs(p.mergedAt) !== null &&
          (filed === null || toMs(p.mergedAt) > filed + 10 * 60000),
      ),
      "mergedAt",
    )[0];
    if (hit) return fixOf(toMs(hit.mergedAt) <= cut ? "deployed" : "merged", hit);
    const train = newest(
      n.open.filter((p) => /^train\//.test(p.branch ?? "")),
      "updatedAt",
    )[0];
    if (train) return fixOf("in-release", train);
    const member = newest(
      n.merged.filter((p) => p.base && p.base !== "master" && openHeads.has(p.base)),
      "mergedAt",
    )[0];
    if (member) return fixOf("in-release", member, member.base);
    const pr = newest(n.open, "updatedAt")[0];
    if (pr) return fixOf("pr-open", pr);
    const br = newest(n.branches, "date")[0];
    if (br) return { state: "branch", pr: null, prUrl: null, branch: br.branch };
    return { state: "none", pr: null, prUrl: null, branch: null };
  }

  // Register items that name a bug (title, members, related or tags carry its B-id).
  const itemsNaming = new Map();
  for (const it of stateItems) {
    if (it.overlay) continue;
    const ids = new Set(String(it.title ?? "").match(/\bB\d{1,5}\b/g) ?? []);
    for (const x of [...(it.members ?? []), ...(it.related ?? []), ...(it.tags ?? [])])
      if (BUG_ID_RE.test(x)) ids.add(x);
    for (const id of ids) {
      if (id === it.id) continue;
      if (!itemsNaming.has(id)) itemsNaming.set(id, []);
      itemsNaming.get(id).push(it.id);
    }
  }
  const outBug = (b, pending) => {
    const fix = fixFor(b);
    return {
      id: b.id,
      title: b.title,
      severity: b.severity,
      state: b.state,
      area: b.area ?? null,
      domain: b.domain ?? null,
      sensitive: Boolean(b.sensitive),
      ledgerState: b.ledgerState ?? null,
      batch: b.batch ?? null,
      tier: b.tier ?? null,
      filedAt: b.filedAt ?? null,
      pending,
      fix,
      items: itemsNaming.get(b.id) ?? [],
      release: releaseOf.get(b.id) ?? null,
    };
  };
  const registryBugs = (sources.bugs?.data?.open ?? []).map((b) => outBug(b, false));
  const pendingBugs = [];
  for (const p of sources.branches?.data?.pendingBugs ?? []) {
    if (!p?.id || bugById.has(p.id) || p.open === false) continue;
    if (pendingBugs.some((x) => x.id === p.id)) continue;
    pendingBugs.push(outBug({ ...p, filedAt: null }, true));
  }
  const bugs = [...registryBugs, ...pendingBugs];

  // ---- items ----
  const items = stateItems.map((it) => {
    const { history: _history, ...rest } = it;
    return {
      ...rest,
      domain: itemDomain(it, bugById),
      claimedBy: it.claimedBy,
      blocked: it.blocked
        ? {
            ...it.blocked,
            at: typeof it.blocked.at === "number" ? iso(it.blocked.at) : it.blocked.at,
          }
        : null,
      createdAt: iso(it.createdAt),
      updatedAt: iso(it.updatedAt),
      claimedAt: iso(it.claimedAt),
      answeredAt: iso(it.answeredAt),
      etaAt: iso(parseEta(it.eta, now)),
    };
  });

  // ---- owner queue + answered decisions (OWNER-QUEUE.md rows, owner-decision events) ----
  const rowsByKey = Array.isArray(specsData?.ownerQueueRows)
    ? new Map(specsData.ownerQueueRows.map((r) => [String(r.key).toLowerCase(), r]))
    : null;
  const queueRowFor = (it) => {
    if (!rowsByKey || !(it.tags ?? []).includes("owner-queue")) return null;
    for (const t of it.tags) {
      if (t === "owner-queue") continue;
      const k = String(t)
        .split(/\s*·\s*/)[0]
        .trim()
        .toLowerCase();
      if (rowsByKey.has(k)) return rowsByKey.get(k);
    }
    return null;
  };
  const decisionByItem = new Map();
  for (const d of state.decisions) decisionByItem.set(d.item, d); // last one wins
  const answerInfo = new Map(); // item id -> { answered, booked, at, answer }
  for (const it of stateItems) {
    if (boardTagged(it) || (it.type !== "decision" && it.lane !== "owner")) continue;
    const row = queueRowFor(it);
    const ev = decisionByItem.get(it.id);
    const byEvent = it.answeredAt !== null && it.answeredAt !== undefined ? true : Boolean(ev);
    const byRow =
      Boolean(row) &&
      (QUEUE_ANSWER_WORDS.has(row.statusWord) ||
        (!QUEUE_HOLD_WORDS.has(row.statusWord) && Boolean(row.decisionFile)));
    const answered = byEvent || byRow;
    answerInfo.set(it.id, {
      answered,
      booked: !answered && row?.statusWord === "BOOKED",
      at: byEvent ? (it.answeredAt ?? toMs(ev?.ts)) : byRow ? queueRowDate(row, now) : null,
      answer: ev?.answer ?? [row?.statusWord, row?.decisionFile].filter(Boolean).join(" → "),
    });
  }
  for (const out of items) {
    const info = answerInfo.get(out.id);
    out.statusLabel = statusLabelFor(out, {
      answered: Boolean(info?.answered),
      booked: Boolean(info?.booked),
    });
    if (info?.answered && out.answeredAt === null) out.answeredAt = iso(info.at);
  }
  const ownerQueue = stateItems
    .filter(
      (it) =>
        !isDone(it) &&
        !boardTagged(it) &&
        (it.lane === "owner" || (it.type === "decision" && /owner/i.test(it.gate ?? ""))) &&
        !answerInfo.get(it.id)?.answered,
    )
    .sort(byPriorityThenId)
    .map((it) => ({
      id: it.id,
      title: it.title,
      gate: it.gate,
      eta: it.eta,
      etaAt: iso(parseEta(it.eta, now)),
      status: it.status,
      state: answerInfo.get(it.id)?.booked ? "booked" : "open",
    }));
  const answeredRecently = stateItems
    .filter((it) => answerInfo.get(it.id)?.answered)
    .map((it) => ({
      id: it.id,
      title: it.title,
      answer: answerInfo.get(it.id).answer,
      at: answerInfo.get(it.id).at,
    }))
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || compareIds(a.id, b.id))
    .slice(0, 10)
    .map(({ at, ...rest }) => ({ ...rest, answeredAt: iso(at) }));
  const decisions = state.decisions
    .slice(-20)
    .reverse()
    .map((d) => ({ ...d, ts: iso(d.ts) }));

  // ---- derived items: incidents (incidents/*.md) and B-ids that releases/items reference ----
  const incidents = (specsData?.incidents ?? []).filter(
    (i) => i.status === "open" || i.status === "mitigated",
  );
  const incidentItems = incidents.map((i) =>
    derivedItem({
      id: i.id,
      title: i.title,
      type: "incident",
      priority: i.status === "open" ? "P0" : "P1",
      status: "planned",
      statusLabel: i.status === "open" ? "Open" : "Mitigated",
      source: "incident",
      domain: guessDomainFromText(i.title) ?? "other",
      createdAt: i.date ? `${i.date}T00:00:00.000Z` : null,
      updatedAt: i.date ? `${i.date}T00:00:00.000Z` : null,
    }),
  );
  const wantedBugIds = new Set();
  for (const it of stateItems)
    for (const x of [...(it.members ?? []), ...(it.related ?? [])])
      if (BUG_ID_RE.test(x) && !state.items.has(x)) wantedBugIds.add(x);
  for (const t of trains)
    for (const m of t.members) if (BUG_ID_RE.test(m) && !state.items.has(m)) wantedBugIds.add(m);
  const bugItems = [...wantedBugIds].sort(compareIds).map((id) => {
    const row = bugById.get(id) ?? null;
    const status = bugItemStatus(row);
    return derivedItem({
      id,
      title: row?.title ?? id,
      type: "bug",
      priority: sevPriority(row?.severity),
      status,
      statusLabel: STATUS_WORDS[status],
      source: "registry",
      area: row?.area ?? null,
      domain: row?.domain ?? guessDomainFromText(row?.title ?? "") ?? "other",
    });
  });
  // The page reads times as ISO strings.
  for (const d of [...incidentItems, ...bugItems]) items.push(d);

  // ---- problems: open P0/P1 bugs and incidents + open/mitigated incident files (never features, ops or the board) ----
  const problems = [
    ...stateItems.filter(
      (it) =>
        !isDone(it) &&
        !boardTagged(it) &&
        (it.type === "bug" || it.type === "incident") &&
        (it.priority === "P0" || it.priority === "P1"),
    ),
    ...incidentItems,
  ]
    .sort(byPriorityThenId)
    .map((it) => it.id);

  // ---- lanes ----
  const handoffs = specsData?.laneHandoffs ?? [];
  const prefixes = { ...LANE_HANDOFF_PREFIX, ...(cfg?.laneHandoffPrefixes ?? {}) };
  const branchDate = new Map();
  for (const b of branchesRaw) if (toMs(b.date) !== null) branchDate.set(b.branch, toMs(b.date));
  const branchesOfItem = (it) => {
    const set = new Set(it.links?.branches ?? []);
    for (const b of branches) if (b.item === it.id) set.add(b.branch);
    return set;
  };
  const laneIds = uniq([...(cfg?.lanes ?? []).map((l) => l.id), ...state.lanes.keys()]);
  const lanes = laneIds.map((id) => {
    const cl = cfg?.lanes?.find((l) => l.id === id);
    const seen = state.lanes.get(id);
    const lastEvent = seen?.lastEventAt ?? null;
    let commit = null;
    for (const it of stateItems) {
      if (isDone(it) || (it.claimedBy !== id && it.lane !== id)) continue;
      for (const br of branchesOfItem(it)) {
        const d = branchDate.get(br);
        if (d !== undefined && (commit === null || d > commit)) commit = d;
      }
    }
    const prefix = String(prefixes[id] ?? id).toLowerCase();
    let handoff = null;
    for (const h of handoffs) {
      const f = String(h.file ?? "").toLowerCase();
      if (
        f !== prefix &&
        !new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[-_.]`).test(f)
      )
        continue;
      const t = toMs(h.at);
      if (t !== null && (handoff === null || t > handoff)) handoff = t;
    }
    const cands = [
      ["event", lastEvent],
      ["commit", commit],
      ["handoff", handoff],
    ].filter(([, t]) => t !== null);
    let act = null;
    for (const c of cands) if (act === null || c[1] > act[1]) act = c;
    const pick = pickNext(state, id, cfg, { now });
    return {
      id,
      title: cl?.title ?? id,
      machine: cl?.machine ?? null,
      lastEventAt: iso(lastEvent),
      lastActivityAt: act ? iso(act[1]) : null,
      lastActivitySource: act ? act[0] : null,
      silentMin: act === null ? null : Math.max(0, Math.round((now - act[1]) / 60000)),
      now: laneNow(state, id),
      next: pick ? { id: pick.item.id, title: pick.item.title, reason: pick.reason } : null,
    };
  });

  // ---- map ----
  const tree = sources.areas?.data?.tree ?? buildAreaTree([]);
  const domains = tree.domains.map((d) => ({
    id: d.id,
    label: d.label,
    areas: d.areas.map((a) => ({
      ...a,
      items: 0,
      prs: 0,
      branches: 0,
      bugs: { critical: 0, high: 0, medium: 0, low: 0 },
    })),
    items: 0,
  }));
  const areaIndex = new Map();
  for (const d of domains) for (const a of d.areas) areaIndex.set(a.area, a);
  const domainIndex = new Map(domains.map((d) => [d.id, d]));
  const areaEntry = (area) => {
    let e = areaIndex.get(area);
    if (!e) {
      const [layer, name] = area.split(":");
      e = {
        area,
        layer,
        name,
        files: 0,
        items: 0,
        prs: 0,
        branches: 0,
        bugs: { critical: 0, high: 0, medium: 0, low: 0 },
      };
      (domainIndex.get(areaDomain(area)) ?? domainIndex.get("other"))?.areas.push(e);
      areaIndex.set(area, e);
    }
    return e;
  };
  const itemAreas = new Map();
  const addItemArea = (id, areas) => {
    if (!id) return;
    itemAreas.set(id, uniq([...(itemAreas.get(id) ?? []), ...areas]));
  };
  for (const p of openPrs) {
    for (const a of p.areas) areaEntry(a).prs += 1;
    addItemArea(p.item, p.areas);
  }
  for (const b of branches) {
    for (const a of b.areas) areaEntry(a).branches += 1;
    addItemArea(b.item, b.areas);
  }
  for (const b of registryBugs) {
    if (!b.area) continue;
    const sev = String(b.severity ?? "").toLowerCase();
    if (SEVERITIES.includes(sev)) areaEntry(b.area).bugs[sev] += 1;
  }
  for (const it of items) {
    if (it.derived || DONE_STATUSES.includes(it.status) || it.type === "release") continue;
    const areas = itemAreas.get(it.id) ?? [];
    if (areas.length) for (const a of areas) areaEntry(a).items += 1;
    else if (domainIndex.has(it.domain)) domainIndex.get(it.domain).items += 1;
    else domainIndex.get("other").items += 1;
  }

  // ---- alarms (reconcile reads PR bodies from the raw lists; the page never gets them) ----
  const hasRegistry = Boolean(sources.bugs?.data);
  const bugIds = hasRegistry
    ? new Set([...bugsAll.map((b) => b.id), ...pendingBugs.map((b) => b.id)])
    : undefined;
  const alarms = reconcile({
    state,
    prs: { open: openRaw, merged: mergedRaw },
    branches,
    sources: outSources,
    config: cfg,
    now,
    bugs: hasRegistry ? bugs : undefined,
    bugIds,
  });

  return {
    generatedAt: iso(now),
    machine,
    ...(typeof authEnabled === "boolean" ? { authEnabled } : {}),
    sources: outSources,
    items,
    bugs,
    trains,
    lanes,
    ownerQueue,
    answeredRecently,
    decisions,
    problems,
    prs: { open: openPrs, merged: mergedPrs },
    branches,
    ci,
    map: { domains },
    alarms,
    stats: {
      events: state.eventCount,
      items: state.items.size,
      openBugs: registryBugs.length,
      anomalies: state.anomalies.length,
    },
  };
}
