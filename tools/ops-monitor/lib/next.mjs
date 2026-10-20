// "What next" ranking for a lane. Pure.
import { DONE_STATUSES, PICKABLE_STATUSES } from "./schema.mjs";
import { parseEta } from "./ids.mjs";
import { areaDomain } from "./areas.mjs";

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

function areaMatches(item, areas) {
  if (!item.area) return areas.includes("*");
  for (const a of areas) {
    if (a === "*") return true;
    if (a === item.area) return true;
    if (a.startsWith("domain:") && areaDomain(item.area) === a.slice(7)) return true;
  }
  return false;
}

const trainRank = (t) => {
  const m = /^R(\d+)/.exec(t ?? "");
  return m ? Number(m[1]) : 99;
};

function compareIds(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ranked list of `{ item, reason }` the lane may take, best first. */
export function rankCandidates(state, laneId, config, { now = Date.now() } = {}) {
  const lane = config?.lanes?.find((l) => l.id === laneId);
  const areas = lane?.areas ?? [];
  const out = [];
  for (const item of state.items.values()) {
    if (!PICKABLE_STATUSES.includes(item.status)) continue;
    if (item.type === "release" || item.type === "epic") continue;
    if (item.blocked || item.claimedBy) continue;
    const openChild = item.children.some((c) => {
      const ch = state.items.get(c);
      return ch && !DONE_STATUSES.includes(ch.status);
    });
    if (openChild) continue;
    const assigned = item.lane === laneId;
    if (!assigned && !(item.lane === null && areaMatches(item, areas))) continue;
    out.push({
      item,
      eta: parseEta(item.eta, now),
      reason: [item.priority, item.train, assigned ? `assigned to ${laneId}` : "area match"]
        .filter(Boolean)
        .join(" · "),
    });
  }
  out.sort((a, b) => {
    const p = (PRIORITY_RANK[a.item.priority] ?? 9) - (PRIORITY_RANK[b.item.priority] ?? 9);
    if (p) return p;
    const t = trainRank(a.item.train) - trainRank(b.item.train);
    if (t) return t;
    if (a.eta !== b.eta) {
      if (a.eta === null) return 1;
      if (b.eta === null) return -1;
      return a.eta - b.eta;
    }
    return compareIds(a.item.id, b.item.id);
  });
  return out.map(({ item, reason }) => ({ item, reason }));
}

export function pickNext(state, laneId, config, opts) {
  return rankCandidates(state, laneId, config, opts)[0] ?? null;
}

const ACTIVE = ["building", "review", "ready", "shipping"];

/** Item ids the lane is working on: its claims plus unclaimed items assigned to it in flight. */
export function laneNow(state, laneId) {
  const out = [];
  for (const item of state.items.values()) {
    if (item.claimedBy === laneId) out.push(item.id);
    else if (!item.claimedBy && item.lane === laneId && ACTIVE.includes(item.status))
      out.push(item.id);
  }
  return out;
}
