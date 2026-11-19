// plane-bridge-codec.mjs — registry row <-> Plane work item. Pure except the read-only registry
// readers. The ONE place a work item is built or read (spec §3.1): the CLI calls only these.
// The bridge owns ONLY the payload block of a description; any other text is a human's.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_SOURCE } from "./plane-client.mjs";
import { PRIORITY_BY_SEVERITY } from "./plane-sync.mjs";

export const NAME_MAX = 255;
export const PAYLOAD_HEADER = "routeflow-bridge/v1";
export const SEVERITY_BY_PRIORITY = {
  urgent: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  none: "none",
};

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// One pass over the text: `&#38;lt;` is the three characters `&lt;`, never `<`.
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|nbsp|amp);/gi;
const NAMED = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", amp: "&" };
function unesc(s) {
  return s.replace(/<br\s*\/?>/gi, "\n").replace(ENTITY_RE, (whole, e) => {
    const low = e.toLowerCase();
    try {
      if (low.startsWith("#x")) return String.fromCodePoint(parseInt(low.slice(2), 16));
      if (low.startsWith("#")) return String.fromCodePoint(Number(low.slice(1)));
    } catch {
      return whole;
    }
    return NAMED[low];
  });
}
const PAYLOAD_RE =
  /<pre[^>]*>\s*<code[^>]*>\s*routeflow-bridge\/v1 sha256=([0-9a-f]{64})\s*(?:<br\s*\/?>)?\s*([\s\S]*?)\s*<\/code>\s*<\/pre>/i;

const idNum = (id) => Number(String(id).slice(1));

// Native-field comparison: Plane may trim or collapse whitespace and renormalise Unicode.
export const norm = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ");

export function sameRecord(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function encodeItem(record, reg) {
  const { catalogue, status } = record;
  const id = catalogue.id;
  const warnings = [];
  let stateName;
  if (status == null) {
    stateName = reg.noStatusState;
  } else {
    stateName = reg.stateByLedger[status.state];
    if (!stateName) {
      warnings.push(`unknown ledger state "${status.state}"`);
      stateName = reg.noStatusState;
    }
  }
  const json = JSON.stringify({ catalogue, status: status ?? null });
  const hash = sha256Hex(json);
  const block = `<pre><code>${PAYLOAD_HEADER} sha256=${hash}\n${esc(json)}</code></pre>`;
  return {
    name: Array.from(`${id} · ${catalogue.title}`).slice(0, NAME_MAX).join(""),
    description_html: block,
    priority: PRIORITY_BY_SEVERITY[catalogue.severity] ?? "medium",
    stateName,
    external_source: EXTERNAL_SOURCE,
    external_id: id,
    warnings,
  };
}

// item: a Plane work item as listed (name, description_html, priority, state id, external_id).
export function decodeItem(item, stateNameById, reg) {
  const id = item.external_id ?? null;
  const fail = (problem) => ({ id, record: null, payload: null, edits: [], warnings: [], problem });
  const m = PAYLOAD_RE.exec(String(item.description_html ?? ""));
  if (!m) return fail("no-payload");
  const json = unesc(m[2]).trim();
  if (sha256Hex(json) !== m[1]) return fail("corrupt");
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return fail("corrupt");
  }
  if (!payload?.catalogue?.id) return fail("corrupt");
  payload.status ??= null;
  if (payload.status && !payload.status.batch) return fail("no-batch");
  const pid = payload.catalogue.id;
  const exp = encodeItem(payload, reg);
  const record = JSON.parse(JSON.stringify(payload));
  const edits = [];
  const warnings = [];

  if (norm(item.name) !== norm(exp.name)) {
    const lead = `${pid} · `;
    const name = String(item.name).trim();
    record.catalogue.title = name.startsWith(lead) ? name.slice(lead.length) : name;
    edits.push("name");
  }
  if (item.priority !== exp.priority && SEVERITY_BY_PRIORITY[item.priority] !== undefined) {
    record.catalogue.severity = SEVERITY_BY_PRIORITY[item.priority];
    edits.push("priority");
  }
  const stateName = stateNameById.get(item.state);
  if (norm(stateName) !== norm(exp.stateName)) {
    if (payload.status === null) {
      warnings.push("state edit not representable (no status row)");
      edits.push("state-ignored");
    } else {
      const to = reg.ledgerByState[stateName];
      if (to === null || to === undefined) {
        edits.push("state-kept");
      } else {
        record.status.state = to;
        edits.push("state");
      }
    }
  }
  return { id: pid, record, payload, edits, warnings, problem: null };
}

// F3 merge rule. local = L, dec = decodeItem(item) (no problem). Returns
// { action: noop|rebaseline|pull-pending|update|conflict, fields: [natives to send], reason }.
export function decideRow(local, item, dec, stateNameById, reg) {
  const eP = encodeItem(dec.payload, reg);
  const eL = encodeItem(local, reg);
  const n = {
    name: item.name,
    stateName: stateNameById.get(item.state),
    priority: item.priority,
  };
  const fields = ["name", "stateName", "priority"];
  const clash = fields.filter((f) => {
    const planeChanged = norm(n[f]) !== norm(eP[f]);
    const localChanged = eL[f] !== eP[f];
    return planeChanged && localChanged && norm(n[f]) !== norm(eL[f]);
  });
  if (clash.length) {
    return { action: "conflict", fields: [], reason: `edited on both sides: ${clash.join(", ")}` };
  }
  const lr = sameRecord(local, dec.record);
  const rp = sameRecord(dec.record, dec.payload);
  if (lr && rp) return { action: "noop", fields: [] };
  if (lr) return { action: "rebaseline", fields: [] };
  if (sameRecord(local, dec.payload)) return { action: "pull-pending", fields: [] };
  return { action: "update", fields: fields.filter((f) => eL[f] !== eP[f]) };
}

// Replace only the payload block of the item's current description; keep every other byte.
// No block present: append it. (create: current is empty, so the result is the block alone.)
export function spliceDescription(currentHtml, enc) {
  const cur = String(currentHtml ?? "");
  return PAYLOAD_RE.test(cur)
    ? cur.replace(PAYLOAD_RE, () => enc.description_html)
    : cur + enc.description_html;
}

// The write body for a new item (state is the Plane state id the caller resolved).
export function itemBody(enc, stateId) {
  return {
    name: enc.name,
    description_html: enc.description_html,
    priority: enc.priority,
    state: stateId,
    external_source: enc.external_source,
    external_id: enc.external_id,
  };
}

// PATCH body: the spliced description plus ONLY the natives the local side changed.
export function itemPatch(enc, item, fields, stateId) {
  const body = { description_html: spliceDescription(item.description_html, enc) };
  if (fields.includes("name")) body.name = enc.name;
  if (fields.includes("priority")) body.priority = enc.priority;
  if (fields.includes("stateName")) body.state = stateId;
  return body;
}

// The text the denylist is run over for a row (what the client would scan on the write).
export function scanText(enc) {
  return `${enc.name}\n${enc.description_html}`;
}

// Link key of a listed Plane item: its registry id when it was created by this bridge/registry.
export function linkOf(item) {
  return item?.external_source === EXTERNAL_SOURCE && item?.external_id
    ? String(item.external_id)
    : null;
}

const lines = (rows) => rows.map((r) => JSON.stringify(r) + "\n").join("");
const byId = (a, b) => idNum(a.catalogue.id) - idNum(b.catalogue.id);

export function catalogueText(records) {
  return lines([...records].sort(byId).map((r) => r.catalogue));
}

export function shardTexts(records) {
  const groups = new Map();
  for (const r of [...records].sort(byId)) {
    if (r.status == null) continue;
    const key = r.status.batch;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.status);
  }
  const out = {};
  for (const [k, rows] of groups) out[k] = lines(rows);
  return out;
}

// Read-only: bugs.jsonl + status/*.jsonl (latest row per id wins) -> Map<id, {catalogue, status}>.
export function recordsFromRegistry(dir) {
  const map = new Map();
  const cat = join(dir, "bugs.jsonl");
  if (existsSync(cat)) {
    for (const l of readFileSync(cat, "utf8").split(/\r?\n/).filter(Boolean)) {
      const row = JSON.parse(l);
      map.set(row.id, { catalogue: row, status: null });
    }
  }
  const sdir = join(dir, "status");
  if (existsSync(sdir)) {
    for (const f of readdirSync(sdir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()) {
      for (const l of readFileSync(join(sdir, f), "utf8").split(/\r?\n/).filter(Boolean)) {
        const row = JSON.parse(l);
        const rec = map.get(row.id);
        if (rec) rec.status = row;
      }
    }
  }
  return map;
}

// F4: compare the tracked files' BYTES with what Plane regenerates. `excludeIds` (held rows) are
// dropped from both sides; `onlyIds` (when set) restricts the tracked side (--present-only).
// bugs.jsonl must match exactly; a shard matches as a multiset of lines (a different order is
// reported as order-only, not drift). A missing shard file is "".
export function compareTracked(dir, planeRecords, { excludeIds = new Set(), onlyIds = null } = {}) {
  const keep = (l) => {
    let id;
    try {
      id = JSON.parse(l).id;
    } catch {
      return true; // an unparsable tracked line is never hidden
    }
    return !excludeIds.has(id) && (onlyIds === null || onlyIds.has(id));
  };
  const rows = (text) => {
    const parts = text.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  };
  const planeList = [...planeRecords.values()].filter((r) => !excludeIds.has(r.catalogue.id));
  const catPath = join(dir, "bugs.jsonl");
  const trackedCat = existsSync(catPath) ? rows(readFileSync(catPath, "utf8")).filter(keep) : [];
  const catDiffers = trackedCat.map((l) => l + "\n").join("") !== catalogueText(planeList);
  const expected = shardTexts(planeList);
  const names = new Set(Object.keys(expected));
  const sdir = join(dir, "status");
  const tracked = {};
  if (existsSync(sdir)) {
    for (const f of readdirSync(sdir).filter((n) => n.endsWith(".jsonl"))) {
      const n = f.slice(0, -".jsonl".length);
      names.add(n);
      tracked[n] = rows(readFileSync(join(sdir, f), "utf8")).filter((l) => l !== "" && keep(l));
    }
  }
  let shardsDiffer = 0;
  let orderOnly = 0;
  for (const n of names) {
    const want = rows(expected[n] ?? "");
    const got = tracked[n] ?? [];
    if (want.length === got.length && want.every((l, i) => l === got[i])) continue;
    const a = [...want].sort();
    const b = [...got].sort();
    if (a.length === b.length && a.every((l, i) => l === b[i])) orderOnly++;
    else shardsDiffer++;
  }
  return { catDiffers, shardsDiffer, orderOnly };
}
