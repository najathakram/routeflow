/**
 * Text formatting for the `ctl` CLI: pure functions from state to capped output (R10, R20, R35).
 * Budgets: `next` <= 30 lines / 1,536 B, `show` <= 1,024 B, change verbs <= 200 B, panels <= 40 lines.
 */
import type { NextResult } from "../domain/next";
import type { OverlapPair } from "../domain/overlap";
import type { PiggybackItem } from "../domain/piggyback";
import type { ControlState, TaskState } from "../domain/types";

export const NEXT_MAX_LINES = 30;
export const NEXT_MAX_BYTES = 1536;
export const SHOW_MAX_BYTES = 1024;
export const CHANGE_MAX_BYTES = 200;
export const PANEL_MAX_LINES = 40;
export const TITLE_MAX = 48;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");

/** One line, at most `n` characters; a cut ends with an ellipsis. */
export function trunc(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  const chars = Array.from(one);
  return chars.length <= n ? one : chars.slice(0, Math.max(0, n - 1)).join("") + "…";
}

/** Keep whole lines while both caps hold (drops from the end), newline-terminated. */
export function capOutput(lines: string[], maxLines: number, maxBytes: number): string {
  const kept = lines.slice(0, maxLines);
  while (kept.length > 1 && bytesOf(kept.join("\n") + "\n") > maxBytes) kept.pop();
  let out = kept.join("\n");
  // a single oversize line is cut by characters
  while (bytesOf(out + "\n") > maxBytes && out.length > 1) out = out.slice(0, -1);
  return out + "\n";
}

/** A change verb's confirmation: one line, at most 200 B. */
export function changeLine(text: string): string {
  return capOutput([text], 1, CHANGE_MAX_BYTES);
}

function taskLabel(state: ControlState, id: string | null): string {
  if (id === null) return "none";
  const t = has(state.tasks, id) ? state.tasks[id] : undefined;
  return t ? `${id} ${trunc(t.title, TITLE_MAX)}` : id;
}

export interface NextView {
  lane: string;
  state: ControlState;
  next: NextResult;
  piggybackCount: number;
  overlaps: OverlapPair[];
  /** The last fetch failed; the block shows the last clone state. */
  offline?: boolean;
}

/** The `ctl next` block (R10). Lines are dropped from the tail if a cap would be exceeded. */
export function formatNext(v: NextView): string {
  const { lane, state } = v;
  const l = has(state.lanes, lane) ? state.lanes[lane] : undefined;
  const lines: string[] = [];
  if (v.offline) lines.push("(offline \u2014 last fetch failed)");
  const cur = l?.current.value ?? null;
  if (cur === null) lines.push(`lane ${lane} · no current task`);
  else {
    const t = has(state.tasks, cur) ? state.tasks[cur] : undefined;
    const phase = t?.phase.value ? ` [${trunc(t.phase.value, 24)}]` : "";
    lines.push(`lane ${lane} · current ${taskLabel(state, cur)}${phase}`);
    const pr = t?.pr.value;
    if (typeof pr === "number") lines.push(`  PR #${pr}`);
  }
  for (const b of l?.blockers ?? []) {
    lines.push(`  blocked: ${b.task} ${trunc(b.reason, 80)}`);
    if (lines.length >= 5) break;
  }
  lines.push(`next: ${v.next.items.length === 0 ? "nothing eligible" : ""}`.trimEnd());
  for (const it of v.next.items) {
    const rel = it.release ? ` ·${trunc(it.release, 12)}` : "";
    const mark = it.explicit ? "★" : " ";
    lines.push(`${mark} ${it.id} ${it.priority}${rel} ${trunc(it.title, TITLE_MAX)}`);
  }
  if (v.next.held.length > 0) lines.push(`held by deps: ${v.next.held.length}`);
  lines.push(`piggyback: ${v.piggybackCount}`);
  for (const o of v.overlaps.slice(0, 3)) {
    lines.push(`overlap ${o.level}: ${o.a} ~ ${o.b} (${o.shared} shared)`);
  }
  return capOutput(lines, NEXT_MAX_LINES, NEXT_MAX_BYTES);
}

/** `ctl show <id>`: status, priority, lane, phase, release, pr, areas, deps, blockers; <= 1 KB. */
export function formatShow(state: ControlState, t: TaskState): string {
  const lines: string[] = [];
  lines.push(`${t.id} ${t.kind} ${trunc(t.title, 140)}`);
  lines.push(
    `status ${t.status.value} (${t.status.source}) · ${t.priority.value} · lane ${t.lane.value ?? "-"}` +
      ` · phase ${t.phase.value ?? "-"}`,
  );
  const pr = t.pr.value;
  lines.push(`release ${t.release.value ?? "-"} · pr ${typeof pr === "number" ? "#" + pr : "-"}`);
  if (t.areas.value.length > 0) {
    lines.push(`areas: ${trunc(t.areas.value.slice(0, 6).join(", "), 160)}`);
  }
  if (t.dependsOn.length > 0) lines.push(`deps: ${trunc(t.dependsOn.slice(0, 8).join(", "), 100)}`);
  for (const l of Object.values(state.lanes)) {
    for (const b of l.blockers) {
      if (b.task === t.id) lines.push(`blocked (${l.id}): ${trunc(b.reason, 100)}`);
    }
  }
  const owner =
    t.lane.value !== null && has(state.lanes, t.lane.value) ? state.lanes[t.lane.value] : null;
  if (owner?.next.value) lines.push(`lane next: ${taskLabel(state, owner.next.value)}`);
  if (t.notes) lines.push(`notes: ${trunc(t.notes, 120)}`);
  return capOutput(lines, 12, SHOW_MAX_BYTES);
}

/** `ctl overlap` panel. */
export function formatOverlap(pairs: OverlapPair[]): string {
  if (pairs.length === 0) return "overlap: none\n";
  const lines = pairs.map(
    (p) =>
      `${p.level} ${p.a} ~ ${p.b} · ${p.shared} shared · ${Math.round(p.coef * 100)}% · ${p.source}: ` +
      trunc(p.paths.slice(0, 3).join(", "), 100),
  );
  return capOutput(lines, PANEL_MAX_LINES, 4096);
}

/** `ctl piggyback` panel. */
export function formatPiggyback(lane: string, items: PiggybackItem[], count: number): string {
  if (items.length === 0) return `piggyback (${lane}): none\n`;
  const lines = [`piggyback (${lane}): ${count}`];
  for (const i of items) {
    lines.push(
      `  ${i.id} ${i.priority} ${Math.round(i.score * 100)}% (${i.shared} shared)` +
        (i.tag ? ` — ${i.tag}` : ""),
    );
  }
  return capOutput(lines, PANEL_MAX_LINES, 4096);
}

/** `ctl waste` panel: whatever the fold derived, one trimmed line per row. */
export function formatWaste(rows: unknown[]): string {
  if (rows.length === 0) return "waste: none\n";
  const lines = rows.map((r) => trunc(typeof r === "string" ? r : JSON.stringify(r), 140));
  return capOutput([`waste: ${rows.length}`, ...lines], PANEL_MAX_LINES, 8192);
}

/** First non-empty line, whitespace collapsed, cut to `n` characters. */
export function oneLine(s: string, n = 200): string {
  const first = s.split("\n").find((l) => l.trim() !== "") ?? "";
  return trunc(first, n);
}

/** The single line `next` prints for a corrupt (INVALID, exit 3) or unreachable (UNAVAILABLE) state. */
export function controlFailure(code: number | undefined, message: string): string {
  const kind = code === 3 ? "INVALID" : "UNAVAILABLE";
  const body = oneLine(message, 400)
    .replace(/\S*[\\/]\S*/g, "<path>")
    .replace(/^(INVALID|UNAVAILABLE)\s*/i, "");
  let line = `control: ${kind} ${body}`.trimEnd();
  while (bytesOf(line) > 120 && line.length > 1) line = line.slice(0, -1);
  return line + "\n";
}
