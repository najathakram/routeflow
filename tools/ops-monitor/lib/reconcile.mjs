// Drift detection: compares human-typed state (events) with derived facts (PRs, branches,
// source freshness) and returns alarms. Pure; never writes anywhere.
import { DONE_STATUSES } from "./schema.mjs";
import { itemIdsFromBranch, parseEta } from "./ids.mjs";
import { DOMAINS, areaDomain } from "./areas.mjs";

const SEV_ORDER = { error: 0, warn: 1, info: 2 };
const HOUR = 3600_000;
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

const BUG_TEXT_RE = /(?<![A-Za-z0-9])b(\d{1,5})(?![A-Za-z0-9])/gi;
const ROWS_RE = /\brows?\s+#?(\d{1,5}(?:\s*(?:,|\/|&|\band\b)\s*#?\d{1,5})*)/gi;
// "Fixes B1234", "Closes row 525", "Resolves rows 555/556" (body only; see fixLinksFor).
const CLOSING_RE =
  /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+((?:b\d{1,5})|(?:rows?\s+#?\d{1,5}(?:\s*(?:,|\/|&|\band\b)\s*#?\d{1,5})*))/gi;

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
  for (const m of String(body ?? "").matchAll(CLOSING_RE)) {
    const ref = m[1];
    if (/^b/i.test(ref)) push(`B${ref.slice(1)}`);
    else for (const n of ref.match(/\d+/g) ?? []) if (known.has(n)) push(n);
  }
  return out;
}

/**
 * Item id a PR/branch belongs to: an item linking the PR number or the branch (register-cited
 * refPrs never count), a pr event for the number, or an id its branch, title or body names
 * (fixLinksFor; a known item wins, else a B-id even if unknown). Else null.
 */
export function linkItemFor({ number = null, branch = null, title = "", body = "" } = {}, state) {
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
  const ids = fixLinksFor({ branch, title, body }, new Set(state.items.keys()));
  return ids.find((id) => state.items.has(id)) ?? ids[0] ?? null;
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
}) {
  const alarms = [];
  const th = {
    laneSilentMin: 30,
    sourceStaleFactor: 3,
    buildingStaleHours: 48,
    bugUnownedHours: 4,
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
  // last 7 days and over 4h old -> one warn per bug. Older (or undated) -> aggregated into one
  // warn per severity x domain (bug-unowned-backlog:<sev>:<domain>) with the B-ids in `items`.
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
  for (const [key, g] of backlog) {
    const label =
      g.dom === "security"
        ? "security hardening (details private)"
        : (DOMAINS.find((d) => d.id === g.dom)?.label ?? "Other");
    add({
      kind: "bug-unowned-backlog",
      severity: "warn",
      message: `${g.ids.length} ${g.sev} ${label} bugs have no owner, branch or PR for more than 7 days → triage`,
      suggest: "rf claim <B-id>",
      items: g.ids,
      _target: key,
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
