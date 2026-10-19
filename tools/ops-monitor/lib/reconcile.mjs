// Drift detection: compares human-typed state (events) with derived facts (PRs, branches,
// source freshness) and returns alarms. Pure; never writes anywhere.
import { DONE_STATUSES } from "./schema.mjs";
import { itemIdFromBranch, parseEta } from "./ids.mjs";

const SEV_ORDER = { error: 0, warn: 1, info: 2 };
const HOUR = 3600_000;

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

/**
 * Item id a PR/branch belongs to: an item linking the PR number or the branch, a pr event for
 * the number, or an id carried in the branch name (a B### id counts even if unknown). Else null.
 */
export function linkItemFor({ number = null, branch = null } = {}, state) {
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
  if (branch) {
    const id = itemIdFromBranch(branch, new Set(state.items.keys()));
    if (id) return id;
  }
  return null;
}

export function reconcile({ state, prs, branches, sources, config, now }) {
  const alarms = [];
  const th = { laneSilentMin: 30, sourceStaleFactor: 3, ...(config?.thresholds ?? {}) };
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

  // status-behind-merge
  const mergedByNumber = new Map(merged.map((p) => [String(p.number), p]));
  for (const it of state.items.values()) {
    if (DONE_STATUSES.includes(it.status) || it.status === "idea") continue;
    const nums = new Set((it.links?.prs ?? []).map(String));
    for (const e of state.prEvents ?? []) if (e.item === it.id) nums.add(String(e.number));
    let hit = null;
    for (const n of nums) {
      const p = mergedByNumber.get(n);
      if (!p || (p.base && p.base !== "master")) continue;
      if (!hit || (toMs(p.mergedAt) ?? 0) > (toMs(hit.mergedAt) ?? 0)) hit = p;
    }
    if (hit) {
      const at = toMs(hit.mergedAt);
      add({
        kind: "status-behind-merge",
        severity: "error",
        message: `PR #${hit.number} merged ${at === null ? "earlier" : ago(now - at) + " ago"} but item is ${it.status}`,
        suggest: `rf status ${it.id} live`,
        item: it.id,
        pr: hit.number,
      });
    }
  }

  // untracked-pr
  for (const p of open) {
    if (!linkItemFor({ number: p.number, branch: p.branch }, state)) {
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
    const silentMs = lane.lastEventAt === null ? Infinity : now - lane.lastEventAt;
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

  // anomaly
  for (const a of state.anomalies ?? []) {
    add({
      kind: "anomaly",
      severity: "error",
      message: `Event anomaly (${a.kind}): ${a.detail ?? ""}`.trim(),
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
