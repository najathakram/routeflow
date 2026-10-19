// fold(events) -> State. Pure: no IO. See build-plan.md "State".
import { BUG_ID_RE, DONE_STATUSES, validateEvent } from "./schema.mjs";
import { itemIdFromBranch } from "./ids.mjs";

const HISTORY_CAP = 50;
const uniq = (arr) => [...new Set(arr)];

function emptyLinks() {
  return { prs: [], branches: [], urls: [] };
}

function mergeLinks(into, add) {
  if (!add) return;
  into.prs = uniq([...into.prs, ...(add.prs ?? [])]);
  into.branches = uniq([...into.branches, ...(add.branches ?? [])]);
  into.urls = uniq([...into.urls, ...(add.urls ?? [])]);
}

function newItem(id, fields, ts) {
  const links = emptyLinks();
  mergeLinks(links, fields.links);
  return {
    id,
    title: fields.title ?? id,
    type: fields.type ?? "chore",
    priority: fields.priority ?? "P2",
    status: fields.status ?? "planned",
    lane: fields.lane ?? null,
    train: fields.train ?? null,
    area: fields.area ?? null,
    parent: fields.parent ?? null,
    eta: fields.eta ?? null,
    gate: fields.gate ?? null,
    trainLabel: fields.trainLabel ?? null,
    source: fields.source ?? null,
    tags: [...(fields.tags ?? [])],
    members: [...(fields.members ?? [])],
    related: [...(fields.related ?? [])],
    links,
    children: [],
    claimedBy: null,
    claimedAt: null,
    claimConflict: null,
    blocked: null,
    createdAt: ts,
    updatedAt: ts,
    history: [],
    overlay: false,
  };
}

export function fold(events, { bugs = new Map() } = {}) {
  const state = {
    items: new Map(),
    lanes: new Map(),
    decisions: [],
    rulings: [],
    notes: [],
    pushes: [],
    prEvents: [],
    anomalies: [],
    eventCount: 0,
    lastEventAt: null,
    machines: {},
  };
  const anomaly = (kind, eventId, item, detail) =>
    state.anomalies.push({ kind, eventId: eventId ?? null, item: item ?? null, detail });

  const valid = [];
  for (const ev of events) {
    if (ev && ev.__invalid) {
      anomaly(
        "invalid-event",
        null,
        null,
        `unparseable line ${ev.file ?? "?"}:${ev.line ?? "?"}: ${String(ev.raw ?? "").slice(0, 80)}`,
      );
      continue;
    }
    const r = validateEvent(ev);
    if (!r.ok) {
      anomaly("invalid-event", ev?.id, ev?.item, r.errors.join("; "));
      continue;
    }
    valid.push(ev);
  }
  valid.sort((a, b) => {
    const ta = Date.parse(a.ts);
    const tb = Date.parse(b.ts);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const touchLane = (ev, ts) => {
    if (!ev.lane) return;
    let l = state.lanes.get(ev.lane);
    if (!l) {
      l = { id: ev.lane, lastEventAt: null, lastEventKind: null, claims: [] };
      state.lanes.set(ev.lane, l);
    }
    l.lastEventAt = ts;
    l.lastEventKind = ev.kind;
  };

  /** Returns the item for an id, creating a registry-bug overlay when the id is a bug id. */
  const resolve = (id, ev) => {
    if (!id) return null;
    let it = state.items.get(id);
    if (it) return it;
    if (BUG_ID_RE.test(id)) {
      it = newItem(
        id,
        { title: bugs.get(id)?.title ?? id, type: "bug", status: "planned", source: "registry" },
        Date.parse(ev.ts),
      );
      it.overlay = true;
      state.items.set(id, it);
      return it;
    }
    anomaly("unknown-item", ev.id, id, `${ev.kind} references unknown item ${id}`);
    return null;
  };

  const setStatus = (it, status) => {
    it.status = status;
    if (DONE_STATUSES.includes(status)) {
      it.claimedBy = null;
      it.claimedAt = null;
      it.claimConflict = null;
    }
  };

  const findByBranch = (branch) => {
    if (!branch) return null;
    for (const it of state.items.values()) if (it.links.branches.includes(branch)) return it;
    return null;
  };

  for (const ev of valid) {
    const ts = Date.parse(ev.ts);
    state.eventCount++;
    state.lastEventAt = ts;
    state.machines[ev.machine] = ts;
    touchLane(ev, ts);
    const d = ev.data;
    let it = null;
    let touched = false;

    switch (ev.kind) {
      case "item.new": {
        if (state.items.has(ev.item)) {
          anomaly("duplicate-item", ev.id, ev.item, `item.new for existing item ${ev.item}`);
        } else {
          it = newItem(ev.item, d, ts);
          state.items.set(ev.item, it);
          touched = true;
        }
        break;
      }
      case "item.edit": {
        it = resolve(ev.item, ev);
        if (!it) break;
        for (const [k, v] of Object.entries(d.fields)) {
          if (k === "links") mergeLinks(it.links, v);
          else if (k === "status") setStatus(it, v);
          else if (Array.isArray(v)) it[k] = [...v];
          else it[k] = v;
        }
        touched = true;
        break;
      }
      case "claim": {
        it = resolve(ev.item, ev);
        if (!it) break;
        if (it.claimedBy && it.claimedBy !== ev.lane && !d.steal) {
          it.claimConflict = [it.claimedBy, ev.lane];
          anomaly(
            "claim-conflict",
            ev.id,
            ev.item,
            `${ev.lane} claimed ${ev.item} held by ${it.claimedBy}`,
          );
        } else {
          it.claimedBy = ev.lane;
          it.claimedAt = ts;
          it.claimConflict = null;
          if (d.branch) mergeLinks(it.links, { branches: [d.branch] });
        }
        touched = true;
        break;
      }
      case "release": {
        it = resolve(ev.item, ev);
        if (!it) break;
        if (it.claimedBy === ev.lane) {
          it.claimedBy = null;
          it.claimedAt = null;
          it.claimConflict = null;
        }
        touched = true;
        break;
      }
      case "status": {
        it = resolve(ev.item, ev);
        if (!it) break;
        setStatus(it, d.status);
        touched = true;
        break;
      }
      case "blocked": {
        it = resolve(ev.item, ev);
        if (!it) break;
        it.blocked = { by: d.by, unblocker: d.unblocker ?? null, at: ts };
        touched = true;
        break;
      }
      case "unblocked": {
        it = resolve(ev.item, ev);
        if (!it) break;
        it.blocked = null;
        touched = true;
        break;
      }
      case "link": {
        it = resolve(ev.item, ev);
        if (!it) break;
        mergeLinks(it.links, d);
        touched = true;
        break;
      }
      case "ruling": {
        it = ev.item ? resolve(ev.item, ev) : null;
        if (ev.item && !it) break;
        state.rulings.push({ ts, item: ev.item, ref: d.ref, summary: d.summary, actor: ev.actor });
        touched = !!it;
        break;
      }
      case "owner-decision": {
        it = ev.item ? resolve(ev.item, ev) : null;
        if (ev.item && !it) break;
        state.decisions.push({
          ts,
          item: ev.item,
          question: d.question,
          answer: d.answer,
          recommended: d.recommended ?? null,
          actor: ev.actor,
        });
        touched = !!it;
        break;
      }
      case "note": {
        it = ev.item ? resolve(ev.item, ev) : null;
        if (ev.item && !it) break;
        state.notes.push({ ts, item: ev.item, text: d.text, actor: ev.actor });
        touched = !!it;
        break;
      }
      case "push": {
        if (ev.item) {
          it = resolve(ev.item, ev);
          if (!it) break;
        } else {
          it = findByBranch(d.branch);
          if (!it) {
            const id = itemIdFromBranch(d.branch, new Set(state.items.keys()));
            if (id) it = resolve(id, ev);
          }
        }
        if (it) mergeLinks(it.links, { branches: [d.branch] });
        state.pushes.push({
          ts,
          branch: d.branch,
          sha: d.sha,
          repo: d.repo,
          item: it ? it.id : null,
          lane: ev.lane ?? it?.claimedBy ?? null,
          machine: ev.machine,
          eventId: ev.id,
        });
        touched = !!it;
        break;
      }
      case "pr": {
        if (ev.item) {
          it = resolve(ev.item, ev);
          if (!it) break;
        } else {
          it = findByBranch(d.branch);
          if (!it) {
            for (const cand of state.items.values()) {
              if (cand.links.prs.includes(d.number)) {
                it = cand;
                break;
              }
            }
          }
        }
        if (it) mergeLinks(it.links, { prs: [d.number] });
        state.prEvents.push({
          ts,
          number: d.number,
          action: d.action,
          branch: d.branch ?? null,
          item: it ? it.id : null,
          lane: ev.lane,
          eventId: ev.id,
        });
        touched = !!it;
        break;
      }
      default:
        break;
    }

    if (touched && it) {
      it.updatedAt = ts;
      const h = { ts, kind: ev.kind, actor: ev.actor };
      if (ev.kind === "status") h.status = d.status;
      if (ev.lane) h.lane = ev.lane;
      it.history.push(h);
      if (it.history.length > HISTORY_CAP) it.history.splice(0, it.history.length - HISTORY_CAP);
    }
  }

  for (const l of state.lanes.values()) l.claims = [];
  for (const it of state.items.values()) {
    it.children = [];
  }
  for (const it of state.items.values()) {
    if (it.parent) state.items.get(it.parent)?.children.push(it.id);
    if (it.claimedBy) {
      let l = state.lanes.get(it.claimedBy);
      if (!l) {
        l = { id: it.claimedBy, lastEventAt: null, lastEventKind: null, claims: [] };
        state.lanes.set(it.claimedBy, l);
      }
      l.claims.push(it.id);
    }
  }
  return state;
}
