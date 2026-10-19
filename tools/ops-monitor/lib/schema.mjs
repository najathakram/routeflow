// Event + item schema for the ops monitor (decision D-2026-10-19-live-ops-monitor).
// Pure: no IO. Every event the CLI writes, and every line the collector reads back, goes
// through validateEvent(); fold() skips (and reports) anything that fails it.

export const SCHEMA_VERSION = 1;

export const STATUSES = [
  "idea",
  "planned",
  "spec",
  "building",
  "review",
  "ready",
  "shipping",
  "live",
  "verified",
  "parked",
  "dropped",
];
/** Statuses that mean the work is finished or abandoned (claims auto-release, no ETA alarms). */
export const DONE_STATUSES = ["live", "verified", "parked", "dropped"];
/** Statuses `rf next` may hand out. */
export const PICKABLE_STATUSES = ["planned", "spec"];

export const TYPES = [
  "bug",
  "feature",
  "spec",
  "chore",
  "ops",
  "decision",
  "release",
  "epic",
  "audit",
  "incident",
];
export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const PR_ACTIONS = ["create", "ready", "merge", "close", "edit"];

// Numeric register rows (525), registry bugs (B1234), trains (R1), prefixed ids (K11-16, OQ-N1).
export const ITEM_ID_RE = /^(?:\d{1,5}|B\d{1,5}|R\d{1,2}|[A-Z][A-Z0-9]{0,9}-[A-Za-z0-9.]{1,20})$/;
export const BUG_ID_RE = /^B\d{1,5}$/;
export const EVENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}-\d{13}-[a-z0-9]{4}$/;
export const MACHINE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const LANE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Item fields an item.new / item.edit may carry. `id` lives on the event (`item`), never here.
const ITEM_FIELDS = {
  title: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 300,
  type: (v) => TYPES.includes(v),
  priority: (v) => PRIORITIES.includes(v),
  status: (v) => STATUSES.includes(v),
  lane: (v) => v === null || (typeof v === "string" && LANE_RE.test(v)),
  train: (v) => v === null || (typeof v === "string" && /^R\d{1,2}$/.test(v)),
  area: (v) => v === null || (typeof v === "string" && v.length <= 80),
  parent: (v) => v === null || (typeof v === "string" && ITEM_ID_RE.test(v)),
  eta: (v) => v === null || (typeof v === "string" && v.length <= 80),
  gate: (v) => v === null || (typeof v === "string" && v.length <= 400),
  trainLabel: (v) => v === null || (typeof v === "string" && v.length <= 120),
  source: (v) => typeof v === "string" && v.length <= 40,
  tags: (v) =>
    Array.isArray(v) && v.length <= 20 && v.every((t) => typeof t === "string" && t.length <= 60),
  members: (v) =>
    Array.isArray(v) &&
    v.length <= 200 &&
    v.every((t) => typeof t === "string" && ITEM_ID_RE.test(t)),
  related: (v) =>
    Array.isArray(v) &&
    v.length <= 50 &&
    v.every((t) => typeof t === "string" && ITEM_ID_RE.test(t)),
  links: (v) => isLinks(v, false),
  // PR numbers the register merely cites as background (never a fix link, never alarmed on).
  refPrs: (v) => Array.isArray(v) && v.length <= 50 && v.every((n) => Number.isInteger(n) && n > 0),
  // Business view (owner 2026-10-19): plain-language story of the item, in the owner's terms.
  problem: (v) => v === null || (typeof v === "string" && v.length <= 800), // what's wrong
  impact: (v) => v === null || (typeof v === "string" && v.length <= 800), // what it's causing
  solution: (v) => v === null || (typeof v === "string" && v.length <= 800), // how we solve it
  ownerAsk: (v) => v === null || (typeof v === "string" && v.length <= 600), // what we need from the owner
  summaryDraft: (v) => typeof v === "boolean", // true = drafted from the register, not yet confirmed
};

/** Types and priorities whose NEW items must carry problem + impact (owner 2026-10-19). */
export function needsBusinessStory(fields) {
  return (
    ["bug", "feature", "incident"].includes(fields.type) && ["P0", "P1"].includes(fields.priority)
  );
}

function isLinks(v, requireOne) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const k of Object.keys(v)) if (!["prs", "branches", "urls"].includes(k)) return false;
  const prs = v.prs ?? [];
  const branches = v.branches ?? [];
  const urls = v.urls ?? [];
  if (!Array.isArray(prs) || !prs.every((n) => Number.isInteger(n) && n > 0)) return false;
  if (
    !Array.isArray(branches) ||
    !branches.every((b) => typeof b === "string" && b.length > 0 && b.length <= 200)
  )
    return false;
  if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string" && u.length <= 500))
    return false;
  if (requireOne && prs.length + branches.length + urls.length === 0) return false;
  return true;
}

const str = (max) => (v) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const optStr = (max) => (v) =>
  v === undefined || v === null || (typeof v === "string" && v.length <= max);

/**
 * Per kind: needsItem ('required' | 'optional' | 'none'), needsLane, and a data validator map
 * { field: [validator, required] }. Unknown data keys are always an error (strict schema).
 */
export const KINDS = {
  "item.new": { needsItem: "required", data: null }, // validated by validateItemFields(full)
  "item.edit": { needsItem: "required", data: null }, // data = { fields: {...partial} }
  claim: {
    needsItem: "required",
    needsLane: true,
    data: {
      branch: [optStr(200), false],
      steal: [(v) => v === undefined || typeof v === "boolean", false],
    },
  },
  release: { needsItem: "required", needsLane: true, data: {} },
  status: {
    needsItem: "required",
    data: { status: [(v) => STATUSES.includes(v), true], note: [optStr(500), false] },
  },
  blocked: {
    needsItem: "required",
    data: { by: [str(300), true], unblocker: [optStr(120), false] },
  },
  unblocked: { needsItem: "required", data: { note: [optStr(500), false] } },
  ruling: { needsItem: "optional", data: { ref: [str(80), true], summary: [str(600), true] } },
  "owner-decision": {
    needsItem: "optional",
    data: {
      question: [str(600), true],
      answer: [str(600), true],
      recommended: [optStr(600), false],
    },
  },
  note: { needsItem: "optional", data: { text: [str(1000), true] } },
  // Moves an item to a free id (the monitor's own items yield plain numbers to the register).
  "item.rename": {
    needsItem: "required",
    data: { to: [(v) => typeof v === "string" && ITEM_ID_RE.test(v), true] },
  },
  link: { needsItem: "required", data: null }, // data = links object, at least one entry
  push: {
    needsItem: "optional",
    data: {
      branch: [str(200), true],
      sha: [(v) => typeof v === "string" && SHA_RE.test(v), true],
      repo: [(v) => typeof v === "string" && REPO_RE.test(v), true],
      remote: [optStr(80), false],
    },
  },
  pr: {
    needsItem: "optional",
    data: {
      number: [(v) => Number.isInteger(v) && v > 0, true],
      action: [(v) => PR_ACTIONS.includes(v), true],
      branch: [optStr(200), false],
    },
  },
};

/** Validates item fields. `full` = an item.new payload (title + type required). */
export function validateItemFields(fields, { full }) {
  const errors = [];
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    return ["fields must be an object"];
  for (const [k, v] of Object.entries(fields)) {
    const check = ITEM_FIELDS[k];
    if (!check) errors.push(`unknown item field "${k}"`);
    else if (!check(v)) errors.push(`invalid item field "${k}"`);
  }
  if (full) {
    if (fields.title === undefined) errors.push("item.new needs a title");
    if (fields.type === undefined) errors.push("item.new needs a type");
  } else if (Object.keys(fields).length === 0) {
    errors.push("item.edit needs at least one field");
  }
  return errors;
}

const TOP_KEYS = ["v", "id", "ts", "machine", "actor", "lane", "kind", "item", "data"];

/** Structural validation of one event. Returns { ok, errors }. Never throws. */
export function validateEvent(ev) {
  const errors = [];
  if (!ev || typeof ev !== "object" || Array.isArray(ev))
    return { ok: false, errors: ["event must be an object"] };
  for (const k of Object.keys(ev))
    if (!TOP_KEYS.includes(k)) errors.push(`unknown event key "${k}"`);
  if (ev.v !== SCHEMA_VERSION) errors.push(`v must be ${SCHEMA_VERSION}`);
  if (typeof ev.id !== "string" || !EVENT_ID_RE.test(ev.id)) errors.push("invalid id");
  if (typeof ev.ts !== "string" || !ISO_RE.test(ev.ts) || Number.isNaN(Date.parse(ev.ts)))
    errors.push("invalid ts");
  if (typeof ev.machine !== "string" || !MACHINE_RE.test(ev.machine))
    errors.push("invalid machine");
  if (typeof ev.actor !== "string" || ev.actor.length === 0 || ev.actor.length > 80)
    errors.push("invalid actor");
  if (!(ev.lane === null || (typeof ev.lane === "string" && LANE_RE.test(ev.lane))))
    errors.push("invalid lane");
  const spec = KINDS[ev.kind];
  if (!spec) {
    errors.push(`unknown kind "${ev.kind}"`);
    return { ok: false, errors };
  }
  const hasItem = typeof ev.item === "string";
  if (!(ev.item === null || (hasItem && ITEM_ID_RE.test(ev.item)))) errors.push("invalid item id");
  if (spec.needsItem === "required" && !hasItem) errors.push(`${ev.kind} needs an item`);
  if (spec.needsLane && !(typeof ev.lane === "string")) errors.push(`${ev.kind} needs a lane`);
  const data = ev.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push("data must be an object");
    return { ok: errors.length === 0, errors };
  }
  if (ev.kind === "item.new") {
    errors.push(...validateItemFields(data, { full: true }));
  } else if (ev.kind === "item.edit") {
    const keys = Object.keys(data);
    if (keys.length !== 1 || keys[0] !== "fields") errors.push("item.edit data must be { fields }");
    else errors.push(...validateItemFields(data.fields, { full: false }));
  } else if (ev.kind === "link") {
    if (!isLinks(data, true))
      errors.push("link data must be { prs?, branches?, urls? } with at least one entry");
  } else {
    for (const k of Object.keys(data))
      if (!spec.data[k]) errors.push(`unknown data key "${k}" for ${ev.kind}`);
    for (const [k, [check, required]] of Object.entries(spec.data)) {
      if (data[k] === undefined) {
        if (required) errors.push(`${ev.kind} needs data.${k}`);
      } else if (!check(data[k])) errors.push(`invalid data.${k}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
