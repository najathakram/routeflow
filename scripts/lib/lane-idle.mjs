// Which fleet lanes are idle, from the board comments (#4456). Pure: no network, no clock.
//
// A comment's FIRST line is `<KEYWORD> <item> · <lane> ...`. A lane is busy while its newest CLAIM has no
// later VERDICT, PUSHED, DONE or IDLE from the SAME lane; another lane's verdict never releases it.
// A lane that is not busy is idle once its last event is older than `idleMs`.
export const IDLE_MS = 15 * 60_000;
const EVENT = /^(CLAIM|VERDICT|PUSHED|DONE|IDLE)\b[^\n·]*·\s*([A-Za-z0-9][\w-]*)/;

/** `{ kind, lane, at }` for a board comment, or null when its first line is not a lane event. */
export function parseEvent(comment) {
  const m = EVENT.exec(String(comment?.body ?? ""));
  const at = Date.parse(comment?.created_at ?? "");
  return m && Number.isFinite(at) ? { kind: m[1], lane: m[2], at } : null;
}

/**
 * `lanes`: [{ id, machine, kind }]. Returns one row per lane:
 * `{ id, machine, kind, busy, idle, lastEventAt, idleForMs }` (`lastEventAt` null = no event in `comments`).
 */
export function idleLanes(comments, lanes, nowMs, idleMs = IDLE_MS) {
  const events = comments
    .map(parseEvent)
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
  return lanes.map((lane) => {
    const mine = events.filter((e) => e.lane === lane.id);
    const last = mine.at(-1) ?? null;
    const busy = last?.kind === "CLAIM";
    const idle = !busy && (last === null || nowMs - last.at > idleMs);
    return {
      ...lane,
      busy,
      idle,
      lastEventAt: last ? new Date(last.at).toISOString() : null,
      idleForMs: idle && last ? nowMs - last.at : null,
    };
  });
}

/** The sticky comment body. The first line is the marker the CLI looks for. */
export function formatReport(rows, nowMs) {
  const mark = `LANE IDLE (auto) · updated ${new Date(nowMs).toISOString().slice(0, 16)}Z`;
  const idle = rows.filter((r) => r.idle);
  const lines = [
    mark,
    "",
    idle.length ? `Idle now: ${idle.length} of ${rows.length}` : "No idle lane.",
  ];
  for (const r of rows) {
    const state = r.busy ? "busy" : r.idle ? "IDLE" : "recent";
    const since = r.lastEventAt
      ? `last event ${r.lastEventAt.slice(11, 16)}Z`
      : "no event in the window";
    lines.push(`- ${r.id} (${r.machine}, ${r.kind}): ${state}, ${since}`);
  }
  return lines.join("\n");
}
