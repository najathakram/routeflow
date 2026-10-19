// Snapshot: folds the human events and joins them with the derived-fact sources into the one
// JSON document the UI and generated views consume. Pure given its inputs.
import { DONE_STATUSES } from "./schema.mjs";
import { fold } from "./fold.mjs";
import { pickNext, laneNow } from "./next.mjs";
import { areaDomain, buildAreaTree, fileToArea, guessDomainFromText } from "./areas.mjs";
import { linkItemFor, reconcile } from "./reconcile.mjs";

export { linkItemFor };

const SOURCE_NAMES = ["specs", "github", "branches", "bugs", "areas", "railway"];
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const SEVERITIES = ["critical", "high", "medium", "low"];

const iso = (ms) =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const uniq = (a) => [...new Set(a)];
const isDone = (it) => DONE_STATUSES.includes(it.status);

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

export function buildSnapshot({ sources = {}, config, now, machine = null }) {
  const specsData = sources.specs?.data ?? null;
  const cfg = config ?? specsData?.config;
  const events = specsData?.events ?? [];
  const bugsAll = sources.bugs?.data?.bugs ?? [];
  const bugById = new Map(bugsAll.map((b) => [b.id, b]));
  const bugsMap = new Map(
    bugsAll.map((b) => [b.id, { title: b.title, state: b.state, severity: b.severity }]),
  );
  const state = fold(events, { bugs: bugsMap });

  const gh = sources.github?.data ?? null;
  const openRaw = gh?.open ?? [];
  const mergedRaw = gh?.merged ?? [];
  const branchesRaw = sources.branches?.data?.branches ?? [];
  const areasOf = (files) => uniq((files ?? []).map((f) => fileToArea(f).area));

  const openPrs = openRaw.map((p) => ({
    number: p.number,
    title: p.title,
    draft: Boolean(p.draft),
    branch: p.branch,
    headSha: p.headSha ?? null,
    checks: p.checks ?? null,
    updatedAt: p.updatedAt ?? null,
    url: p.url ?? null,
    areas: areasOf(p.files),
    item: linkItemFor({ number: p.number, branch: p.branch }, state),
  }));
  const mergedPrs = mergedRaw.map((p) => ({
    number: p.number,
    title: p.title,
    branch: p.branch,
    mergedAt: p.mergedAt ?? null,
    mergeSha: p.mergeSha ?? null,
    url: p.url ?? null,
    item: linkItemFor({ number: p.number, branch: p.branch }, state),
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

  // ---- items ----
  const items = [...state.items.values()].map((it) => {
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
    };
  });

  // ---- bugs ----
  const bugs = (sources.bugs?.data?.open ?? []).map((b) => ({
    id: b.id,
    title: b.title,
    severity: b.severity,
    state: b.state,
    area: b.area,
    domain: b.domain,
    sensitive: Boolean(b.sensitive),
  }));

  // ---- trains ----
  const trains = [...state.items.values()]
    .filter((it) => it.type === "release")
    .map((it) => ({
      id: it.id,
      title: it.title,
      status: it.status,
      eta: it.eta,
      members: uniq([
        ...it.members,
        ...[...state.items.values()].filter((x) => x.train === it.id).map((x) => x.id),
      ]),
    }))
    .sort(
      (a, b) =>
        (Number(/\d+/.exec(a.id)?.[0]) || 99) - (Number(/\d+/.exec(b.id)?.[0]) || 99) ||
        compareIds(a.id, b.id),
    );

  // ---- lanes ----
  const laneIds = uniq([...(cfg?.lanes ?? []).map((l) => l.id), ...state.lanes.keys()]);
  const lanes = laneIds.map((id) => {
    const cl = cfg?.lanes?.find((l) => l.id === id);
    const seen = state.lanes.get(id);
    const last = seen?.lastEventAt ?? null;
    const pick = pickNext(state, id, cfg, { now });
    return {
      id,
      title: cl?.title ?? id,
      machine: cl?.machine ?? null,
      lastEventAt: iso(last),
      silentMin: last === null ? null : Math.max(0, Math.round((now - last) / 60000)),
      now: laneNow(state, id),
      next: pick ? { id: pick.item.id, title: pick.item.title, reason: pick.reason } : null,
    };
  });

  // ---- owner queue, decisions, problems ----
  const ownerQueue = [...state.items.values()]
    .filter(
      (it) =>
        !isDone(it) &&
        (it.lane === "owner" || (it.type === "decision" && /owner/i.test(it.gate ?? ""))),
    )
    .sort(byPriorityThenId)
    .map((it) => ({ id: it.id, title: it.title, gate: it.gate, eta: it.eta, status: it.status }));
  const decisions = state.decisions
    .slice(-20)
    .reverse()
    .map((d) => ({ ...d, ts: iso(d.ts) }));
  const problems = [...state.items.values()]
    .filter((it) => !isDone(it) && (it.priority === "P0" || it.type === "incident"))
    .sort(byPriorityThenId)
    .map((it) => it.id);

  // ---- ci ----
  const ci = {
    master: gh?.master ?? null,
    visibility: gh?.visibility ?? null,
    deploys: (sources.railway?.data?.deploys ?? []).map((d) => ({
      service: d.service,
      status: d.status,
      sha: d.sha,
      createdAt: d.createdAt,
      source: d.source ?? "railway",
      ...(d.github ? { github: d.github } : {}),
    })),
  };

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
  for (const b of bugs) {
    if (!b.area) continue;
    const sev = String(b.severity ?? "").toLowerCase();
    if (SEVERITIES.includes(sev)) areaEntry(b.area).bugs[sev] += 1;
  }
  for (const it of items) {
    if (DONE_STATUSES.includes(it.status) || it.type === "release") continue;
    const areas = itemAreas.get(it.id) ?? [];
    if (areas.length) for (const a of areas) areaEntry(a).items += 1;
    else if (domainIndex.has(it.domain)) domainIndex.get(it.domain).items += 1;
    else domainIndex.get("other").items += 1;
  }

  const alarms = reconcile({
    state,
    prs: { open: openPrs, merged: mergedRaw },
    branches,
    sources: outSources,
    config: cfg,
    now,
  });

  return {
    generatedAt: iso(now),
    machine,
    sources: outSources,
    items,
    bugs,
    trains,
    lanes,
    ownerQueue,
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
      openBugs: bugs.length,
      anomalies: state.anomalies.length,
    },
  };
}
