// Drift detection: compares human-typed state (events) with derived facts (PRs, branches,
// source freshness) and returns alarms. Pure; never writes anywhere.
import { DONE_STATUSES } from "./schema.mjs";
import { resolveLaneId } from "./config.mjs";
import { itemIdsFromBranch, parseEta } from "./ids.mjs";
import { DOMAINS, areaDomain } from "./areas.mjs";
import { isLegacyMonitorItem, isRegisterOwned } from "./sync.mjs";

const SEV_ORDER = { error: 0, warn: 1, info: 2 };
const HOUR = 3600_000;
/** An unconfigured lane with no open work only counts while its activity is this recent. */
export const UNKNOWN_LANE_RECENT_DAYS = 7;
// Events older than the register's last change by more than this mean the register sync is behind.
export const ITEMS_STALE_MS = 15 * 60_000;
const BEHIND_STATUSES = ["idea", "planned", "spec", "building", "review"];

const toMs = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** "5 minutes", "3 hours", "2 days": plain words for the stale-items banner. */
export function agoWords(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const unit = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (m < 60) return unit(m, "minute");
  const h = Math.round(m / 60);
  return h < 48 ? unit(h, "hour") : unit(Math.round(h / 24), "day");
}

const BUG_TEXT_RE = /(?<![A-Za-z0-9])b(\d{1,5})(?![A-Za-z0-9])/gi;
const ROWS_RE = /\brows?\s+#?(\d{1,5}(?:\s*(?:,|\/|&|\band\b)\s*#?\d{1,5})*)/gi;
// "Fixes B1234", "Closes row 525", "Resolves rows 555/556" (body only; see fixLinksFor).
const CLOSING_RE =
  /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+((?:b\d{1,5})|(?:rows?\s+#?\d{1,5}(?:\s*(?:,|\/|&|\band\b)\s*#?\d{1,5})*))/gi;

// The house PR-body label "Register row 651" (also "Register rows 555/556"): the row the PR serves, no closing verb needed.
const REGISTER_ROW_RE =
  /\bregister\s+rows?\s*:?\s*#?(\d{1,5}(?:\s*(?:,|\/|&|\band\b)\s*#?\d{1,5})*)/gi;

/**
 * Item ids a PR (or branch) NAMES, i.e. the items it fixes: the branch's item tokens
 * (itemIdsFromBranch), any B-id in the title or body ("B1234", "fix(b230):"), and register rows
 * written after the word "row" ("row 525", "rows 555/556", "Closes row 525"). A bare number is
 * never an item ("Closes #3202", "follow-ups of #3202", "Fixes 525"), and a row number only counts
 * when it is a known item id. B-ids are returned whether or not the registry knows them.
 */
export function fixLinksFor({ branch = null, title = "", body = "" } = {}, knownIds = new Set()) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? []);
  const out = [];
  const push = (id) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const id of itemIdsFromBranch(branch, known)) push(id);
  // The TITLE names what a PR fixes. The BODY counts only after a closing verb: real bodies
  // mention other items as background ("Supersedes parked row 402", "B1234 ... are not in this
  // PR"), which the lead's 10-19 audit found were false fix links (planner ruling).
  const title_ = String(title ?? "");
  for (const m of title_.matchAll(BUG_TEXT_RE)) push(`B${m[1]}`);
  for (const m of title_.matchAll(ROWS_RE))
    for (const n of m[1].match(/\d+/g) ?? []) if (known.has(n)) push(n);
  for (const m of String(body ?? "").matchAll(REGISTER_ROW_RE))
    for (const n of m[1].match(/\d+/g) ?? []) if (known.has(n)) push(n);
  for (const m of String(body ?? "").matchAll(CLOSING_RE)) {
    const ref = m[1];
    if (/^b/i.test(ref)) push(`B${ref.slice(1)}`);
    else for (const n of ref.match(/\d+/g) ?? []) if (known.has(n)) push(n);
  }
  return out;
}

// Looser, link-only references (never a fix claim): "row 688" / "rows 688/689" anywhere in the
// body, and a "Row: 688" / "Item: 688" commit-style trailer line (the PR body is the only text
// fetched; no extra API calls).
const TRAILER_RE = /^\s*(?:row|item)s?\s*:\s*#?(\d{1,5}(?:\s*(?:,|\/|&)\s*#?\d{1,5})*)\s*$/gim;
export function bodyRefsFor(body, known, { mentions = true } = {}) {
  const out = [];
  const text = String(body ?? "");
  for (const re of mentions ? [ROWS_RE, TRAILER_RE] : [TRAILER_RE]) {
    for (const m of text.matchAll(re))
      for (const n of m[1].match(/\d+/g) ?? []) if (known.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** GitHub's revert PR: title `Revert "..."` or branch `revert-<N>-...`. */
export const isRevertPr = (p) =>
  /^Revert "/.test(String(p?.title ?? "")) || /^revert-/.test(String(p?.branch ?? ""));

/** PR numbers a revert PR undoes: body "Reverts owner/repo#N", branch `revert-<N>-...`. */
export function revertedNumbers(p) {
  const out = new Set();
  for (const m of String(p?.body ?? "").matchAll(/\breverts\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi))
    out.add(Number(m[1]));
  const b = /^revert-(\d+)-/.exec(String(p?.branch ?? ""));
  if (b) out.add(Number(b[1]));
  return out;
}

/** Merged PRs that need no work item: trains, docs, dependabot and bookkeeping follow-ups. */
export const isNoiseMergedPr = (p) =>
  /^(?:train|docs|dependabot)\//.test(String(p?.branch ?? "")) ||
  /^(?:docs|chore)\/bookkeeping-/.test(String(p?.branch ?? "")) ||
  /^docs: bookkeeping/i.test(String(p?.title ?? ""));

/**
 * Item id a PR/branch belongs to: an item linking the PR number or the branch (register-cited
 * refPrs never count), a pr event for the number, or an id its branch, title or body names
 * (fixLinksFor; a known item wins, else a B-id even if unknown), else a known row the body merely
 * mentions ("row 688", "Row: 688" trailer; link only, never a fix claim). With
 * `bodyMentions: false` a bare body mention does not count (an explicit trailer still does).
 * Else null.
 */
export function linkItemFor(
  { number = null, branch = null, title = "", body = "" } = {},
  state,
  { bodyMentions = true } = {},
) {
  const n = number === null || number === undefined ? null : String(number);
  for (const it of state.items.values()) {
    if (n !== null && (it.links?.prs ?? []).some((p) => String(p) === n)) return it.id;
    if (branch && (it.links?.branches ?? []).includes(branch)) return it.id;
  }
  if (n !== null) {
    for (const e of state.prEvents ?? []) {
      if (String(e.number) === n && e.item && state.items.has(e.item)) return e.item;
    }
  }
  const known = new Set(state.items.keys());
  const ids = fixLinksFor({ branch, title, body }, known);
  return (
    ids.find((id) => state.items.has(id)) ??
    ids[0] ??
    bodyRefsFor(body, known, { mentions: bodyMentions })[0] ??
    null
  );
}

/**
 * When a merged PR reached master. A PR based on master merged at its own mergedAt. RouteFlow lands
 * work through merge-commit trains: a member PR targets `train/<x>` and the train PR (head
 * `train/<x>`, base master) merges later, so a member whose base is a merged master PR's head
 * branch counts as merged at THAT PR's mergedAt (the earliest train PR merged at or after the
 * member). Returns { at (ms | null), via (train PR number | null) }; at is null while the base is
 * not master and no such train PR has merged.
 */
export function landedAt(p, merged) {
  const own = toMs(p?.mergedAt);
  if (!p?.base || p.base === "master") return { at: own, via: null };
  let hit = null;
  for (const t of merged ?? []) {
    if (t === p || t.branch !== p.base || (t.base && t.base !== "master")) continue;
    const at = toMs(t.mergedAt);
    if (at === null || (own !== null && at < own)) continue;
    if (!hit || at < hit.at) hit = { at, via: t.number };
  }
  return hit ?? { at: null, via: null };
}

/** An open incident file counts as current only when it changed within this many days. */
export const INCIDENT_FRESH_DAYS = 7;
const DAY = 24 * HOUR;

/** When an incident file last changed (git commit time), else its filename date; ms or null. */
export function incidentChangedMs(inc) {
  const c = toMs(inc?.changedAt);
  if (c !== null) return c;
  return inc?.date ? toMs(`${inc.date}T00:00:00Z`) : null;
}

/**
 * Where an incident file belongs on the page (lead ruling 10-19): `hurting` = status open and
 * the file changed within INCIDENT_FRESH_DAYS; `stale` = open but older, or no Status line at all
 * (a drift alarm either way); `mitigated`; `unverified` (suspected / unverified); `hidden`
 * (closed / resolved). Pure.
 */
export function incidentBucket(inc, now) {
  const s = String(inc?.status ?? "unknown").toLowerCase();
  if (s === "closed" || s === "resolved") return "hidden";
  if (s === "mitigated") return "mitigated";
  if (s === "suspected" || s === "unverified") return "unverified";
  if (s !== "open") return "stale";
  const at = incidentChangedMs(inc);
  return at !== null && now - at <= INCIDENT_FRESH_DAYS * DAY ? "hurting" : "stale";
}

const CLOSED_BUG_STATES = new Set([
  "done",
  "proven",
  "proven-pending-deploy",
  "already-fixed",
  "refuted",
  "closed",
  "fixed",
  "duplicate",
  "wontfix",
  "verified",
  "live",
]);

/** The registry still lists the bug as open: the ledger state wins over the front-matter state. */
export function isBugOpen(b) {
  const first = String(b.ledgerState ?? b.state ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
  return !CLOSED_BUG_STATES.has(first);
}

/**
 * laneActivity: Map<lane id, ms>, the lane's newest event, commit or handoff (lane-silent falls back
 * to the lane's last event).
 * Inputs beyond state/prs/branches/sources (all shapes built by the collector/snapshot):
 *  - prs.open / prs.merged: { number, title, branch, body?, mergedAt?, base? }
 *  - branches: { branch, date, item? }
 *  - bugs: the registry's open bugs { id, severity, state, ledgerState?, pending, filedAt (ms |
 *    ISO | null = older than the git-log window), items? (register items naming it), fix ("none" |
 *    "branch" | "pr-open" | "in-release" | "merged" | "deployed", or { state, ... }) }
 *  - register: { duplicateIds: row ids the register repeats, rowIds: every register row id | null }
 *    (collector.readSpecsExtras); raises register-duplicate-rows and register-id-collision.
 *  - bugIds: every B-id the registry knows (open, closed and pending); enables bug-no-registry.
 */
export function reconcile({
  state,
  prs,
  branches,
  sources,
  config,
  now,
  bugs,
  bugIds,
  laneActivity,
  register,
  incidents,
}) {
  const alarms = [];
  const th = {
    laneSilentMin: 30,
    sourceStaleFactor: 3,
    buildingStaleHours: 48,
    bugUnownedHours: 4,
    registerSyncSilentMin: 30,
    ...(config?.thresholds ?? {}),
  };
  const open = prs?.open ?? [];
  const merged = prs?.merged ?? [];
  const add = (a) =>
    alarms.push({
      suggest: null,
      item: null,
      lane: null,
      pr: null,
      branch: null,
      source: null,
      ...a,
    });

  // status-behind-merge: work in flight whose every linked PR is done, the newest merge being
  // old enough that the lane had time to record it. ready/shipping never fire.
  // A PR is an item's FIX only when it was linked by a non-register event (links.prs, pr events)
  // or its branch, title or body names the item. Register-cited PRs (item.refPrs) never count.
  const knownIds = new Set(state.items.keys());
  const namedPrs = new Map(); // item id -> Set of PR numbers that name it
  for (const p of [...open, ...merged]) {
    for (const id of fixLinksFor(p, knownIds)) {
      if (!namedPrs.has(id)) namedPrs.set(id, new Set());
      namedPrs.get(id).add(String(p.number));
    }
  }
  const mergedByNumber = new Map(merged.map((p) => [String(p.number), p]));
  const openNumbers = new Set(open.map((p) => String(p.number)));
  for (const it of state.items.values()) {
    if (!BEHIND_STATUSES.includes(it.status)) continue;
    const nums = new Set((it.links?.prs ?? []).map(String));
    for (const n of namedPrs.get(it.id) ?? []) nums.add(n);
    for (const e of state.prEvents ?? []) if (e.item === it.id) nums.add(String(e.number));
    if ([...nums].some((n) => openNumbers.has(n))) continue;
    let hit = null;
    for (const n of nums) {
      const p = mergedByNumber.get(n);
      if (!p) continue;
      const l = landedAt(p, merged);
      if (l.at === null) continue;
      if (!hit || l.at > hit.at) hit = { p, at: l.at, via: l.via };
    }
    if (!hit || now - hit.at <= 2 * HOUR) continue;
    const at = hit.at;
    add({
      kind: "status-behind-merge",
      severity: now - at >= 24 * HOUR ? "error" : "warn",
      message:
        hit.via === null
          ? `PR #${hit.p.number} merged ${ago(now - at)} ago but item is ${it.status}`
          : `PR #${hit.p.number} landed ${ago(now - at)} ago via train PR #${hit.via} but item is ${it.status}`,
      suggest: `rf status ${it.id} shipping`,
      item: it.id,
      pr: hit.p.number,
    });
  }

  // untracked-pr
  for (const p of open) {
    if (!linkItemFor({ number: p.number, branch: p.branch, title: p.title, body: p.body }, state)) {
      add({
        kind: "untracked-pr",
        severity: "warn",
        message: `Open PR #${p.number} (${p.branch}) is not linked to any item`,
        suggest: `rf event link <id> --pr ${p.number}`,
        pr: p.number,
        branch: p.branch ?? null,
      });
    }
  }

  // untracked-merged-pr: a PR merged in the last 7 days that no item claims.
  for (const p of merged) {
    const at = toMs(p.mergedAt);
    if (at === null || now - at > 7 * DAY || isNoiseMergedPr(p)) continue;
    if (linkItemFor({ number: p.number, branch: p.branch, title: p.title, body: p.body }, state))
      continue;
    add({
      kind: "untracked-merged-pr",
      severity: "warn",
      message: `merged PR #${p.number} has no work item (${p.branch ?? "no branch"}, merged ${ago(now - at)} ago)`,
      suggest: `rf event link <id> --pr ${p.number}`,
      pr: p.number,
      branch: p.branch ?? null,
    });
  }

  // untracked-branch
  const openBranches = new Set(open.map((p) => p.branch));
  for (const b of branches ?? []) {
    const at = toMs(b.date);
    if (at === null || now - at > 48 * HOUR) continue;
    if (b.pr || openBranches.has(b.branch)) continue;
    if (b.item || linkItemFor({ branch: b.branch }, state)) continue;
    add({
      kind: "untracked-branch",
      severity: "info",
      message: `Branch ${b.branch} (${ago(now - at)} old) has no PR and no item`,
      suggest: `rf event link <id> --branch ${b.branch}`,
      branch: b.branch,
    });
  }

  // building-stale: building/review with no activity (linked branch commit, item event) for 48h.
  const staleMs = th.buildingStaleHours * HOUR;
  for (const it of state.items.values()) {
    if (it.status !== "building" && it.status !== "review") continue;
    if (it.blocked) continue; // idle on purpose, recorded
    let last = typeof it.updatedAt === "number" ? it.updatedAt : (toMs(it.updatedAt) ?? 0);
    for (const b of branches ?? []) {
      const at = toMs(b.date);
      if (at === null) continue;
      const linked =
        (it.links?.branches ?? []).includes(b.branch) ||
        b.item === it.id ||
        fixLinksFor({ branch: b.branch }, knownIds).includes(it.id);
      if (linked && at > last) last = at;
    }
    if (now - last <= staleMs) continue;
    add({
      kind: "building-stale",
      severity: "warn",
      message: `Item ${it.id} is ${it.status} but nothing has moved for ${ago(now - last)}`,
      suggest: `rf note ${it.id} "<status>" or rf status ${it.id} <status>`,
      item: it.id,
    });
  }

  // Bug alarms. A bug is "named" by a PR/branch via fixLinksFor (B-id anywhere).
  const openBugs = (bugs ?? []).filter((b) => !b.pending && isBugOpen(b));
  const bugKnown = new Set((bugs ?? []).map((b) => b.id));
  // Merged PRs naming a bug, with their landing time on master (a train member lands when its
  // train PR merges: landedAt). `mergedAt` is that landing time in ms; `via` the train PR number.
  const mergedNaming = (id) =>
    merged
      .filter((p) => fixLinksFor(p, knownIds).includes(id))
      .map((p) => ({ p, ...landedAt(p, merged) }))
      .filter((x) => x.at !== null)
      .map((x) => ({ ...x.p, mergedAt: x.at, via: x.via }))
      .sort((a, b) => b.mergedAt - a.mergedAt);

  // bug-fixed-still-open: a PR merged to master names an open bug (after the bug was filed).
  for (const b of openBugs) {
    const filed = toMs(b.filedAt);
    const hit = mergedNaming(b.id).find(
      (p) => filed === null || toMs(p.mergedAt) > filed + 10 * 60000,
    );
    if (!hit) continue;
    const at = toMs(hit.mergedAt);
    const regState = String(b.ledgerState ?? b.state ?? "").trim() || "open";
    add({
      kind: "bug-fixed-still-open",
      severity: now - at >= 24 * HOUR ? "error" : "warn",
      message: `PR #${hit.number} ${
        hit.via
          ? `landed ${ago(now - at)} ago via train PR #${hit.via}`
          : `merged ${ago(now - at)} ago`
      } names ${b.id} but the registry still says ${regState}`,
      suggest: `close ${b.id} in the bug registry (PR #${hit.number})`,
      item: b.id,
      pr: hit.number,
    });
  }

  // bug-unowned: critical/high, open, no claim, no branch, no PR. Filed (or re-opened) in the
  // last 7 days and over 4h old -> one warn per bug. Older (or undated) -> aggregated into ONE
  // summary warn (bug-unowned-backlog:all) with every B-id in `items`.
  const backlog = new Map();
  for (const b of openBugs) {
    const sev = String(b.severity ?? "").toLowerCase();
    if (sev !== "critical" && sev !== "high") continue;
    const ledger = String(b.ledgerState ?? "");
    if (ledger.toLowerCase() === "in-flight") continue;
    const fixState = typeof b.fix === "string" ? b.fix : b.fix?.state;
    if (fixState && fixState !== "none") continue;
    const claimedBy = (id) => state.items.get(id)?.claimedBy ?? null;
    if (claimedBy(b.id) || (b.claimedBy ?? null) || (b.items ?? []).some((id) => claimedBy(id)))
      continue;
    const named =
      [...open, ...merged].some((p) => fixLinksFor(p, knownIds).includes(b.id)) ||
      (branches ?? []).some((br) => fixLinksFor({ branch: br.branch }, knownIds).includes(b.id));
    if (named) continue;
    const filed = toMs(b.filedAt);
    const reopened = /reopen|regress/i.test(ledger);
    const recent = reopened || (filed !== null && now - filed <= 7 * 24 * HOUR);
    if (recent) {
      if (!reopened && now - filed <= th.bugUnownedHours * HOUR) continue;
      add({
        kind: "bug-unowned",
        severity: "warn",
        message: `${b.id} (${sev}) has no owner, branch or PR (${
          filed === null ? "re-opened" : `filed ${ago(now - filed)} ago`
        })`,
        suggest: `rf claim ${b.id}`,
        item: b.id,
      });
      continue;
    }
    // Security-sensitive bugs are masked (no area), so they get their own group instead of
    // swelling "Other".
    const dom = b.sensitive
      ? "security"
      : DOMAINS.some((d) => d.id === b.domain)
        ? b.domain
        : b.area
          ? areaDomain(b.area)
          : "other";
    const key = `${sev}:${dom}`;
    if (!backlog.has(key)) backlog.set(key, { sev, dom, ids: [] });
    backlog.get(key).ids.push(b.id);
  }
  if (backlog.size) {
    const ids = [...backlog.values()].flatMap((g) => g.ids);
    const bySev = {};
    for (const g of backlog.values()) bySev[g.sev] = (bySev[g.sev] ?? 0) + g.ids.length;
    const breakdown = ["critical", "high"]
      .filter((s) => bySev[s])
      .map((s) => `${bySev[s]} ${s}`)
      .join(", ");
    add({
      kind: "bug-unowned-backlog",
      severity: "warn",
      message: `${ids.length} unowned bugs (${breakdown}) have no owner, branch or PR for more than 7 days → triage`,
      suggest: "rf claim <B-id>",
      items: ids,
      _target: "all",
    });
  }

  // bug-no-registry: a B-id named by an open PR or a recent branch that the registry lacks.
  if (bugIds) {
    const registry = new Set([...bugIds, ...bugKnown]);
    const seenIds = new Set();
    const flag = (id, extra, where) => {
      if (registry.has(id) || seenIds.has(id)) return;
      seenIds.add(id);
      add({
        kind: "bug-no-registry",
        severity: "warn",
        message: `${where} names ${id}, which is not in the bug registry`,
        suggest: `rf bug file --id ${id} ...`,
        _target: id,
        ...extra,
      });
    };
    for (const p of open)
      for (const id of fixLinksFor(p, knownIds).filter((x) => /^B\d/.test(x)))
        flag(id, { pr: p.number, branch: p.branch ?? null }, `PR #${p.number}`);
    for (const b of branches ?? []) {
      const at = toMs(b.date);
      if (at === null || now - at > 7 * 24 * HOUR) continue;
      for (const id of fixLinksFor({ branch: b.branch }, knownIds).filter((x) => /^B\d/.test(x)))
        flag(id, { branch: b.branch }, `Branch ${b.branch}`);
    }
  }

  // unknown-status: the register said a status word the monitor does not know (item reads planned).
  for (const it of state.items.values()) {
    // Only while the item still reads "planned": a later status, or a done item, settles it.
    if (!it.statusText || it.status !== "planned" || DONE_STATUSES.includes(it.status)) continue;
    add({
      kind: "unknown-status",
      severity: "info",
      message: `Row ${it.id} has status '${it.statusText}' the monitor does not know`,
      item: it.id,
    });
  }

  // incident-stale: incident files are snapshots, so an open one with no recent change (or no
  // Status line) cannot be trusted as a live problem. The team sets the Status: line.
  for (const inc of incidents ?? []) {
    if (incidentBucket(inc, now) !== "stale") continue;
    const at = incidentChangedMs(inc);
    add({
      kind: "incident-stale",
      severity: "warn",
      message:
        at === null
          ? `Incident '${inc.title}' has no status update; set its **Status:** line`
          : `Incident '${inc.title}' has no status update for ${Math.max(0, Math.floor((now - at) / DAY))} days; set its **Status:** line`,
      _target: inc.id,
    });
  }

  // claim-conflict
  for (const it of state.items.values()) {
    if (it.claimConflict && it.claimConflict.length) {
      add({
        kind: "claim-conflict",
        severity: "error",
        message: `Claim conflict on ${it.id}: ${it.claimConflict.join(" vs ")}`,
        suggest: `rf release ${it.id} --lane <loser>`,
        item: it.id,
      });
    }
  }

  // lane-silent
  for (const lane of state.lanes.values()) {
    if (!lane.claims || lane.claims.length < 1) continue;
    // The lane's activity (events, commits on its branches, handoffs) when the snapshot knows it.
    const last = laneActivity?.get(lane.id) ?? lane.lastEventAt ?? null;
    const silentMs = last === null ? Infinity : now - last;
    if (silentMs > th.laneSilentMin * 60000) {
      add({
        kind: "lane-silent",
        severity: "warn",
        message: `Lane ${lane.id} holds ${lane.claims.length} claim(s) but has been silent ${
          Number.isFinite(silentMs) ? ago(silentMs) : "forever"
        }`,
        lane: lane.id,
      });
    }
  }

  // unknown-lane: work or events naming a lane that ops/config.json does not list (a retired or
  // misspelt lane id). One alarm per lane id.
  if (Array.isArray(config?.lanes) && config.lanes.length) {
    const byLane = new Map(); // unknown lane id -> open item ids naming it
    const note = (laneId, itemId) => {
      if (!laneId || resolveLaneId(laneId, config)) return;
      if (!byLane.has(laneId)) byLane.set(laneId, []);
      if (itemId && !byLane.get(laneId).includes(itemId)) byLane.get(laneId).push(itemId);
    };
    for (const it of state.items.values()) {
      if (DONE_STATUSES.includes(it.status)) continue;
      note(it.lane, it.id);
      note(it.claimedBy, it.id);
    }
    // Bounded: a retired lane id seen only in old events must not warn forever.
    for (const [id, l] of state.lanes) {
      const last = l.lastEventAt ?? null; // heartbeats advance lastEventAt too: the latest of both
      if (last !== null && now - last <= UNKNOWN_LANE_RECENT_DAYS * 24 * HOUR) note(id, null);
    }
    for (const [laneId, ids] of byLane) {
      const named = ids.slice(0, 3).join(", ");
      add({
        kind: "unknown-lane",
        severity: "warn",
        message: ids.length
          ? `Lane ${laneId} is not in ops/config.json but ${ids.length} open item(s) name it (${named}${
              ids.length > 3 ? ", ..." : ""
            })`
          : `Lane ${laneId} has sent heartbeats/events but is not in ops/config.json`,
        suggest: ids.length
          ? `rf item edit ${ids[0]} --lane <known lane>, or add ${laneId} to ops/config.json lanes`
          : `add ${laneId} to ops/config.json lanes`,
        lane: laneId,
      });
    }
  }

  // past-eta
  for (const it of state.items.values()) {
    if (DONE_STATUSES.includes(it.status) || !it.eta) continue;
    const eta = parseEta(it.eta, now);
    if (eta !== null && eta < now) {
      add({
        kind: "past-eta",
        severity: "warn",
        message: `Item ${it.id} ETA "${it.eta}" passed ${ago(now - eta)} ago (status ${it.status})`,
        item: it.id,
      });
    }
  }

  // stale-source
  for (const [name, s] of Object.entries(sources ?? {})) {
    if (!s) continue;
    const at = toMs(s.at);
    const limit = (s.intervalSec ?? 60) * th.sourceStaleFactor * 1000;
    const never = at === null;
    if (never || now - at > limit) {
      add({
        kind: "stale-source",
        severity: name === "specs" || name === "github" ? "error" : "warn",
        message: never
          ? `Source ${name} has never succeeded${s.error ? `: ${s.error}` : ""}`
          : `Source ${name} last succeeded ${ago(now - at)} ago${s.error ? `: ${s.error}` : ""}`,
        source: name,
      });
    }
  }

  // register-duplicate-rows: the hand-kept register repeats a row id, so sync ignores the register.
  const dupIds = register?.duplicateIds ?? [];
  if (dupIds.length) {
    add({
      kind: "register-duplicate-rows",
      severity: "error",
      message: `The register has duplicate row ids (${dupIds.join(", ")}); the monitor ignores register changes until it is repaired`,
      source: "register",
    });
  }

  // register-sync-silent: the register sync (one writer, the local --views monitor) has written no event for a while, or
  // never. Only when the register exists and this state tracks the sync (fold does; a bare test state does not).
  if (register?.rowIds && state.lastRegisterSyncAt !== undefined) {
    const at = state.lastRegisterSyncAt;
    const silentMs = at === null ? Infinity : now - at;
    if (silentMs > th.registerSyncSilentMin * 60000) {
      add({
        kind: "register-sync-silent",
        severity: "warn",
        message: Number.isFinite(silentMs)
          ? `No register sync for ${Math.round(silentMs / 60000)} min; register edits are not reaching the board`
          : "No register sync has ever run; register edits are not reaching the board",
        suggest:
          "run `rf sync`, or start the monitor with --views on the machine that keeps the register",
        source: "register",
      });
    }
  }

  // items-stale: a dry register sync would still append events (rows or edits the board lacks) and
  // the register's last commit is older than ITEMS_STALE_MS, so the PC register sync has stalled.
  // A register commit that syncs to nothing never fires it; other lanes' events never hide it.
  const regAt = register?.changedAt;
  const pending = register?.pending;
  if (
    Number.isFinite(regAt) &&
    Number.isFinite(pending) &&
    pending >= 1 &&
    now - regAt > ITEMS_STALE_MS
  ) {
    add({
      kind: "items-stale",
      severity: now - regAt >= 24 * HOUR ? "error" : "warn",
      message: `Work items are behind the register: ${pending} change${pending === 1 ? "" : "s"} from ${agoWords(now - regAt)} ago ${pending === 1 ? "has" : "have"} not reached the board (the register sync on the PC monitor is behind)`,
      source: "register",
    });
  }

  // register-id-collision: a register row shares its number with an item sync will not move (not
  // the legacy case that sync renames), so the row is refused and nothing is merged.
  for (const id of new Set(register?.rowIds ?? [])) {
    const it = state.items.get(id);
    if (!it || it.overlay || isRegisterOwned(it) || isLegacyMonitorItem(it)) continue;
    add({
      kind: "register-id-collision",
      severity: "error",
      message: `Register row ${id} and a monitor item share the number; nothing merged`,
      item: id,
    });
  }

  // anomaly (claim conflicts are reported once, by claim-conflict, only while live)
  for (const a of state.anomalies ?? []) {
    if (a.kind === "claim-conflict") continue;
    const historical = Number.isFinite(a.ts) && now - a.ts >= 24 * HOUR;
    add({
      kind: "anomaly",
      severity: historical ? "info" : "error",
      message:
        `${historical ? "historical: " : ""}Event anomaly (${a.kind}): ${a.detail ?? ""}`.trim(),
      item: a.item ?? null,
      // eventId stands in for the target when the anomaly has no item.
      _target: a.item ?? a.eventId ?? a.kind,
    });
  }

  const seen = new Map();
  for (const a of alarms) {
    const target = a._target ?? a.item ?? a.pr ?? a.branch ?? a.lane ?? a.source;
    delete a._target;
    let id = `${a.kind}:${target}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `#${n}`;
    a.id = id;
  }
  alarms.sort(
    (x, y) =>
      SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  return alarms;
}
