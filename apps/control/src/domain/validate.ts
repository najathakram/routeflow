import {
  BY_VALUES,
  EMITTERS,
  ENVELOPE_OPTIONAL,
  ENVELOPE_REQUIRED,
  LANE_ID_RE,
  MAX_LINE_BYTES,
  OPTIONAL,
  REQUIRED,
  TS_RE,
  checkField,
  isEventType,
} from "./schema";
import { EVENT_OF, step, stepBugFixed } from "./transitions";
import type { Track } from "./transitions";
import type { ControlEvent, EventType, LaneKind, Status, ValidationError } from "./types";
import { eventOrder } from "./fold";

export type { ValidationError } from "./types";

export interface EventFile {
  file: string;
  text: string;
}

export interface RegisterTask {
  id: string;
  status: Status;
  release: string | null;
}

export interface ValidationContext {
  /** Register tasks with their status; preferred over `taskIds`. */
  tasks?: RegisterTask[];
  /** @deprecated pass `tasks` with status; `taskIds` treats all as planned. */
  taskIds?: string[];
  releaseIds: string[];
  /** Denylist hook (WP3 wires the real one): returns the matched pattern, or null. */
  denylistHit?: (line: string) => string | null;
}

/**
 * What the snapshot already knows (spec §8), so a live segment can be validated alone. The first
 * three members are the documented minimum; a full FoldAcc satisfies every optional one.
 */
export interface ValidationResume {
  lastByLane: Record<string, { seq: number; ts: string }>;
  mintedIds: string[];
  tracks: Record<string, Track>;
  /** Newest event time in the snapshot; defaults to the newest of `lastByLane`. */
  maxTs?: string;
  lanes?: Record<string, { kind: string }>;
  proposedIds?: string[];
  releasesCreated?: Record<string, unknown>;
  alias?: Record<string, string>;
  taskRelease?: Record<string, string | null>;
}

interface Rec {
  fileIdx: number;
  file: string;
  fileLane: string;
  line: number;
  ev: ControlEvent;
  type: EventType;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate every `events/<lane>.jsonl` (spec §1.3, §2). Pure: returns `{file, line, reason}[]`,
 * sorted by file then line. `ctx` carries the register-side ids; RF- tasks, lanes and aliases come
 * from the events themselves.
 */
export function validateEvents(
  files: EventFile[],
  ctx: ValidationContext,
  resume?: ValidationResume,
): ValidationError[] {
  const errors: { fileIdx: number; e: ValidationError }[] = [];
  const push = (fileIdx: number, file: string, line: number, reason: string) =>
    errors.push({ fileIdx, e: { file, line, reason } });
  const recs: Rec[] = [];
  const firstLine = new Map<number, number>();
  let minTs = resume?.maxTs ?? "";
  if (resume && minTs === "") {
    for (const r of Object.values(resume.lastByLane)) if (r.ts > minTs) minTs = r.ts;
  }

  // Pass A: per-line structure.
  files.forEach((f, fileIdx) => {
    const fileLane = f.file.replace(/\.jsonl$/, "");
    const known = resume ? Object.hasOwn(resume.lastByLane, fileLane) : false;
    const was = known && resume ? resume.lastByLane[fileLane] : null;
    let expectedSeq = was ? was.seq + 1 : 1;
    let prevTs = "";
    let seen = 0;
    const rows = f.text.split("\n");
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i].replace(/\r$/, "");
      if (raw.trim() === "") continue;
      const line = i + 1;
      const first = seen === 0;
      seen++;
      if (first) {
        firstLine.set(fileIdx, line);
        if (!LANE_ID_RE.test(fileLane)) push(fileIdx, f.file, line, `bad file name ${f.file}`);
      }
      if (Buffer.byteLength(raw, "utf8") > MAX_LINE_BYTES) {
        push(fileIdx, f.file, line, `line exceeds 1,024 bytes`);
        continue;
      }
      const hit = ctx.denylistHit ? ctx.denylistHit(raw) : null;
      if (hit) {
        push(fileIdx, f.file, line, `denylist hit: ${hit}`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        push(fileIdx, f.file, line, "invalid JSON");
        continue;
      }
      if (!isObj(parsed)) {
        push(fileIdx, f.file, line, "invalid JSON: not an object");
        continue;
      }
      if (parsed.type === "segment") {
        const keys = Object.keys(parsed).filter((k) => !["seq", "type", "from"].includes(k));
        const from = parsed.from;
        if (!first) push(fileIdx, f.file, line, "segment header only allowed on the first line");
        else if (parsed.seq !== 0) push(fileIdx, f.file, line, "segment header seq must be 0");
        else if (keys.length > 0) push(fileIdx, f.file, line, `extra key ${keys.join(", ")}`);
        else if (typeof from !== "number" || !Number.isInteger(from) || from < 1) {
          push(fileIdx, f.file, line, "segment header needs integer from >= 1");
        } else if (was && from !== was.seq + 1) {
          push(
            fileIdx,
            f.file,
            line,
            `segment header from ${from} != expected ${was.seq + 1} (snapshot ends at seq ${was.seq})`,
          );
        } else expectedSeq = from;
        continue;
      }

      const problems: string[] = [];
      const seq = parsed.seq;
      // envelope
      const missingEnv = ENVELOPE_REQUIRED.filter((k) => !(k in parsed));
      const type = parsed.type;
      let ok = true;
      if (typeof seq === "number" && Number.isInteger(seq) && seq >= 1) {
        if (seq !== expectedSeq) problems.push(`seq ${seq} != expected ${expectedSeq}`);
        expectedSeq = seq + 1;
      } else {
        if (!missingEnv.includes("seq")) problems.push("seq must be a positive integer");
        ok = false;
        expectedSeq += 1;
      }
      const ts = parsed.ts;
      if (typeof ts === "string") {
        if (!TS_RE.test(ts) || Number.isNaN(Date.parse(ts))) {
          problems.push("ts must be ISO UTC");
          ok = false;
        } else {
          const ref = prevTs !== "" ? prevTs : minTs;
          if (ref !== "" && ts.length !== ref.length) {
            problems.push("ts precision differs from the previous ts (seconds vs milliseconds)");
            ok = false;
          } else if (minTs !== "" && ts < minTs) {
            problems.push(`ts older than the snapshot's newest event (${ts} < ${minTs})`);
          } else if (ts < prevTs) problems.push(`ts decreases (${ts} < ${prevTs})`);
          else prevTs = ts;
        }
      } else if (!missingEnv.includes("ts")) {
        problems.push("ts must be a string");
        ok = false;
      }
      if (typeof parsed.lane === "string") {
        if (parsed.lane !== fileLane) problems.push(`lane mismatch (${parsed.lane} in ${f.file})`);
      } else if (!missingEnv.includes("lane")) {
        problems.push("lane must be a string");
        ok = false;
      }
      if (typeof parsed.by === "string") {
        if (!(BY_VALUES as readonly string[]).includes(parsed.by)) {
          problems.push(`by must be one of ${BY_VALUES.join("|")}`);
          ok = false;
        }
      } else if (!missingEnv.includes("by")) {
        problems.push("by must be a string");
        ok = false;
      }

      let known: EventType | null = null;
      if (typeof type === "string" && !isEventType(type)) {
        problems.push(`unknown type ${type}`);
        ok = false;
      } else if (isEventType(type)) {
        known = type;
        const required = [...ENVELOPE_REQUIRED, ...REQUIRED[type]];
        const allowed = new Set([...required, ...ENVELOPE_OPTIONAL, ...OPTIONAL[type]]);
        const extra = Object.keys(parsed).filter((k) => !allowed.has(k));
        const missing = required.filter((k) => !(k in parsed));
        if (extra.length > 0) {
          problems.push(`extra key ${extra.join(", ")}`);
          ok = false;
        }
        if (missing.length > 0) {
          problems.push(`missing key ${missing.join(", ")}`);
          ok = false;
        }
        if (extra.length === 0 && missing.length === 0) {
          for (const k of Object.keys(parsed)) {
            if (ENVELOPE_REQUIRED.includes(k) && k !== "lane") continue;
            if (k === "lane") continue;
            const bad = checkField(type, k, parsed[k], fileLane);
            if (bad) {
              problems.push(k === "areas" && bad.startsWith("unsafe") ? bad : `${k} ${bad}`);
              ok = false;
              break;
            }
          }
        }
      } else if (missingEnv.includes("type")) {
        ok = false;
      } else {
        problems.push("type must be a string");
        ok = false;
      }
      if (missingEnv.length > 0 && known === null) {
        problems.push(`missing key ${missingEnv.join(", ")}`);
        ok = false;
      }
      for (const p of problems) push(fileIdx, f.file, line, p);
      if (ok && known) {
        recs.push({
          fileIdx,
          file: f.file,
          fileLane,
          line,
          ev: parsed as unknown as ControlEvent,
          type: known,
        });
      }
    }
  });

  // Global, order-independent facts.
  const lanes = new Map<string, LaneKind>();
  if (resume?.lanes) {
    for (const [id, l] of Object.entries(resume.lanes)) lanes.set(id, l.kind as LaneKind);
  }
  const regTasks: RegisterTask[] = [
    ...(ctx.taskIds ?? []).map((id): RegisterTask => ({ id, status: "planned", release: null })),
    ...(ctx.tasks ?? []),
  ];
  const taskIds = new Set(regTasks.map((t) => t.id));
  const releaseIds = new Set(ctx.releaseIds);
  const minted = new Set<string>(resume?.mintedIds ?? []);
  const proposed = new Set<string>(resume?.proposedIds ?? []);
  const createdReleases = new Set<string>(Object.keys(resume?.releasesCreated ?? {}));
  for (const id of minted) taskIds.add(id);
  for (const id of proposed) taskIds.add(id);
  for (const id of createdReleases) releaseIds.add(id);
  const sorted = [...recs].sort(
    (a, b) => eventOrder(a.ev, b.ev) || a.fileIdx - b.fileIdx || a.line - b.line,
  );
  const s = (r: Rec, k: string): string | null => {
    const v = r.ev[k];
    return typeof v === "string" ? v : null;
  };
  for (const r of sorted) {
    const at = (reason: string) => push(r.fileIdx, r.file, r.line, reason);
    if (r.type === "lane.registered") {
      lanes.set(s(r, "laneId") ?? "", s(r, "kind") as LaneKind);
    } else if (r.type === "task.created") {
      const id = s(r, "id") ?? "";
      if (minted.has(id) || taskIds.has(id)) at(`duplicate mint ${id}`);
      minted.add(id);
      taskIds.add(id);
    } else if (r.type === "task.proposed") {
      const id = s(r, "tmpId") ?? "";
      if (proposed.has(id)) at(`duplicate mint ${id}`);
      proposed.add(id);
      taskIds.add(id);
    } else if (r.type === "release.created") {
      const id = s(r, "id") ?? "";
      if (releaseIds.has(id) || createdReleases.has(id)) at(`duplicate release ${id}`);
      createdReleases.add(id);
      releaseIds.add(id);
    }
  }

  // Lanes must be registered (once per file).
  files.forEach((f, fileIdx) => {
    const line = firstLine.get(fileIdx);
    if (line === undefined) return;
    const fileLane = f.file.replace(/\.jsonl$/, "");
    if (!lanes.has(fileLane)) push(fileIdx, f.file, line, `unregistered lane ${fileLane}`);
  });

  // Pass B: references, emitters, transitions in total order.
  const tracks = new Map<string, Track>();
  const taskRelease = new Map<string, string | null>();
  for (const t of regTasks) {
    tracks.set(t.id, { status: t.status, prior: null, lane: null });
    taskRelease.set(t.id, t.release ?? null);
  }
  for (const [id, t] of Object.entries(resume?.tracks ?? {})) tracks.set(id, t);
  for (const [id, r] of Object.entries(resume?.taskRelease ?? {})) taskRelease.set(id, r);
  const alias = new Map<string, string>(Object.entries(resume?.alias ?? {}));
  const resolve = (id: string) => alias.get(id) ?? id;
  const trackOf = (id: string): Track =>
    tracks.get(id) ?? {
      status: proposed.has(id) ? "proposed" : "planned",
      prior: null,
      lane: null,
    };

  for (const r of sorted) {
    const at = (reason: string) => push(r.fileIdx, r.file, r.line, reason);
    const { ev, type } = r;
    const kind = lanes.get(r.fileLane);
    if (kind && !EMITTERS[type].includes(kind)) {
      at(`unauthorised emitter: ${type} from lane ${r.fileLane} (${kind})`);
    }
    if (type === "task.next" && ev.targetLane !== undefined && kind && kind !== "owner") {
      at(`unauthorised emitter: task.next targetLane is owner-only (${r.fileLane} is ${kind})`);
    }
    let dangling = false;
    const needTask = (id: unknown): boolean => {
      if (typeof id !== "string" || !taskIds.has(id)) {
        at(`dangling task ${String(id)}`);
        dangling = true;
        return false;
      }
      return true;
    };
    for (const k of ["task"]) {
      const v = ev[k];
      if (v !== undefined && v !== null) needTask(v);
    }
    if (type === "task.adopted") {
      const tmp = s(r, "tmpId");
      if (tmp === null || !proposed.has(tmp)) {
        at(`dangling task ${String(tmp)}`);
        dangling = true;
      }
    }
    if (type === "bug.filed" || type === "bug.fixed") needTask(ev.bug);
    for (const k of ["dependsOn", "related"]) {
      const v = ev[k];
      if (Array.isArray(v)) for (const x of v as unknown[]) needTask(x);
    }
    const rel = ev.release;
    if (type !== "release.created" && typeof rel === "string" && !releaseIds.has(rel)) {
      at(`dangling release ${rel}`);
    }
    for (const k of ["toLane", "targetLane"]) {
      const v = ev[k];
      if (typeof v === "string" && !lanes.has(v)) at(`unregistered lane ${v}`);
    }
    if (dangling) continue;

    // transitions
    if (type === "task.created") {
      const id = s(r, "id") ?? "";
      if (!tracks.has(id)) tracks.set(id, { status: "planned", prior: null, lane: null });
      taskRelease.set(id, s(r, "release"));
    } else if (type === "task.proposed") {
      tracks.set(s(r, "tmpId") ?? "", { status: "proposed", prior: null, lane: null });
    } else if (type === "task.adopted") {
      alias.set(s(r, "tmpId") ?? "", s(r, "task") ?? "");
    } else if (type === "task.lane") {
      const id = resolve(s(r, "task") ?? "");
      tracks.set(id, { ...trackOf(id), lane: s(r, "toLane") });
    } else if (type === "task.release") {
      taskRelease.set(resolve(s(r, "task") ?? ""), s(r, "release"));
    } else if (type === "release.shipped") {
      const shipped = s(r, "release");
      for (const [tid, rel] of taskRelease) {
        const t = trackOf(tid);
        if (rel === shipped && t.status === "code-complete") {
          tracks.set(tid, { ...t, status: "released" });
        }
      }
    } else if (type in EVENT_OF || type === "bug.fixed") {
      const id = resolve(s(r, type === "bug.fixed" ? "bug" : "task") ?? "");
      const t = trackOf(id);
      const res = type === "bug.fixed" ? stepBugFixed(t) : step(t, type, ev.by, r.fileLane);
      if (res.ok) {
        tracks.set(id, res.track);
        if (type === "task.released") taskRelease.set(id, s(r, "release"));
      } else at(res.reason);
    }
  }

  return errors
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => a.fileIdx - b.fileIdx || a.e.line - b.e.line || a.i - b.i)
    .map((x) => x.e);
}
