#!/usr/bin/env node
/**
 * Ops-monitor brief for the session (monitor -> session). One script, two modes chosen by the
 * hook payload's `hook_event_name`:
 *
 *   SessionStart      prints the brief for this checkout's lane (lane-less sessions get the short
 *                     global part: hurting now + waiting on the owner), saves the "seen" marker
 *                     <opsHome>/seen/<session>.json = { lastEventId, ts }, and starts a detached
 *                     `rf brief --refresh --quiet` so the clone is fresh for next time.
 *   UserPromptSubmit  for the lead lane or any session that has a marker: prints ONE line,
 *                     "[ops monitor] Since you last looked: ...", when other people changed
 *                     something since the marker, then "N new comments for you:" with the text
 *                     of each new comment that mentions, answers or sits on this session's
 *                     work (the team board's only channel); then advances the marker. At most once every
 *                     2 minutes it also starts the detached refresh, so a long session keeps
 *                     seeing other machines' events.
 *
 * FAIL OPEN: any error, missing ops clone, CI, RF_OPS_GATE=off -> exit 0 and print nothing.
 * Synchronous work is file reads + a fold only: no network and no git call. A 1.5 s watchdog
 * ends the process regardless. RF_BRIEF_NO_REFRESH=1 skips the detached refresh (tests).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WATCHDOG_MS = 1500;
const REFRESH_EVERY_MS = 120_000;

const lib = (name) => pathToFileURL(join(ROOT, "tools", "ops-monitor", "lib", name)).href;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  } catch {
    // best effort
  }
}

function startRefresh(home, env) {
  if (env.RF_BRIEF_NO_REFRESH) return;
  try {
    const rf = join(ROOT, "tools", "ops-monitor", "bin", "rf.mjs");
    if (!existsSync(rf)) return;
    const child = spawn(process.execPath, [rf, "brief", "--refresh", "--quiet"], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env, RF_ACTOR: "hook:brief" },
    });
    child.unref();
    const stamp = join(home, "last-refresh");
    mkdirSync(home, { recursive: true });
    writeFileSync(stamp, String(Date.now()));
  } catch {
    // best effort
  }
}

const refreshDue = (home, now) => {
  try {
    return now - statSync(join(home, "last-refresh")).mtimeMs > REFRESH_EVERY_MS;
  } catch {
    return true;
  }
};

/**
 * The hook's synchronous work. Returns the text to print ("" for nothing); writes the seen marker.
 * Exported for the timing test; `deps` are the ops-monitor modules (loaded dynamically by main).
 */
export function briefFor(payload, env, now, deps) {
  const { opsHome, specsDir, loadConfig, readAllEvents, fold, brief, turn } = deps;
  const dir = specsDir(env);
  if (!existsSync(join(dir, "events"))) return { text: "", refresh: false };
  const home = opsHome(env);
  const mode = payload.hook_event_name;
  const cwd = payload.cwd ?? process.cwd();
  const config = loadConfig(dir);
  // Live-client names come from <opsHome>/client-names.json (machine-local), never the specs repo.
  const loaded = deps.loadClientNames?.({ env, home }) ?? { names: [], error: null };
  const clientNames = Array.isArray(loaded) ? loaded : (loaded.names ?? []);
  const namesError = Array.isArray(loaded) ? null : (loaded.error ?? null);
  const markerFile = join(home, "seen", `${turn.sanitizeSessionId(payload.session_id)}.json`);
  // Who reads the comments: the ONE rule in lib/identity.mjs, the same one rf writes events under
  // (the lane, the member set by rf whoami --member, and the actor name).
  const me = deps.identity.whoIsHere({ env, machine: deps.machine, config, cwd });
  const { lane, actor, member } = me;
  const events = readAllEvents(dir);
  const newest = brief.lastEventId(events);

  if (namesError) {
    // Fail open but never unmasked: a broken names file prints one note and no item text.
    if (mode === "SessionStart") {
      writeJson(markerFile, { lastEventId: newest, ts: now });
      return { text: "ops brief disabled: client-names.json unreadable", refresh: false };
    }
    return { text: "", refresh: false };
  }

  // Comments for me that are unread in the inbox (by id) and not yet printed in this session.
  // By id, not by position in the log: a comment that reaches this clone late, with an older ts
  // than the last one printed, is still new to this session.
  const ANNOUNCED_KEEP = 500;
  const unreadForMe = (state, inboxSeen, announced) =>
    (deps.inbox?.commentsFor(state, me) ?? []).filter(
      (x) => deps.inbox.isUnread(x.comment, inboxSeen) && !announced.has(x.comment.id),
    );
  const markerOf = (announced) => ({
    lastEventId: newest,
    ts: now,
    count: events.length,
    announced: [...announced].slice(-ANNOUNCED_KEEP),
  });

  if (mode === "SessionStart") {
    const state = fold(events);
    const inboxSeen = deps.inbox?.readInboxSeen?.(home, me) ?? null;
    const snapshot = readJson(join(home, "last-snapshot.json"));
    const text = brief.renderBrief(state, {
      lane,
      now,
      snapshot,
      config,
      clientNames,
      short: !lane,
      maxLines: lane ? 25 : 8,
      utcOffsetMin: -new Date(now).getTimezoneOffset(),
      me,
      inboxSeen,
    });
    // The brief just listed the unread comments, so the next prompt does not print them again.
    const shown = unreadForMe(state, inboxSeen, new Set()).map((x) => x.comment.id);
    writeJson(markerFile, markerOf(shown));
    return { text, refresh: true };
  }

  if (mode === "UserPromptSubmit") {
    const marker = readJson(markerFile);
    if (lane !== "lead" && !marker) return { text: "", refresh: false };
    const refresh = refreshDue(home, now);
    if (!marker) {
      writeJson(markerFile, markerOf([]));
      return { text: "", refresh };
    }
    const announced = new Set(Array.isArray(marker.announced) ? marker.announced : []);
    // Nothing arrived at all (same newest event, same count): quiet, without a fold.
    if (newest === marker.lastEventId && events.length === marker.count)
      return { text: "", refresh };
    const own = (e) => (member || !lane ? e.actor === actor : e.lane === lane);
    const { before, sorted } = brief.splitAtMarker(events, marker, own);
    let text = "";
    const nowState = fold(sorted);
    if (before.length !== sorted.length) {
      const line = brief.renderSince(fold(before), nowState, {
        lane,
        config,
        clientNames, // masked in the since-line too
        nowMs: now,
        utcOffsetMin: -new Date(now).getTimezoneOffset(),
      });
      if (line) text = `[ops monitor] ${line}`;
    }
    const mine = unreadForMe(nowState, deps.inbox?.readInboxSeen?.(home, me) ?? null, announced);
    if (mine.length) {
      const n = mine.length;
      const lines = mine
        .slice(-3)
        .map((x) => deps.inbox.renderComment(x.comment, nowState, { now, clientNames }));
      const more = n > 3 ? [`  (${n - 3} more: rf inbox)`] : [];
      const head = `[ops monitor] ${n} new comment${n === 1 ? "" : "s"} for you:`;
      text = [text, head, ...lines, ...more].filter(Boolean).join("\n");
      for (const x of mine) announced.add(x.comment.id);
    }
    writeJson(markerFile, markerOf(announced));
    return { text, refresh };
  }
  return { text: "", refresh: false };
}

async function main() {
  if (process.env.RF_OPS_GATE === "off" || process.env.CI) return;
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || !payload.session_id) return;
  const config = await import(lib("config.mjs"));
  const store = await import(lib("store.mjs"));
  const foldMod = await import(lib("fold.mjs"));
  const deps = {
    opsHome: config.opsHome,
    specsDir: config.specsDir,
    loadConfig: config.loadConfig,
    loadClientNames: (await import(lib("mask.mjs"))).loadClientNames,
    readAllEvents: store.readAllEvents,
    fold: foldMod.fold,
    lanes: await import(lib("lanes-local.mjs")),
    brief: await import(lib("brief.mjs")),
    turn: await import(lib("turn-actions.mjs")),
    inbox: await import(lib("inbox.mjs")),
    identity: await import(lib("identity.mjs")),
    machine: "",
  };
  deps.machine = config.machineId(config.loadConfig(config.specsDir()), process.env);
  const { text, refresh } = briefFor(payload, process.env, Date.now(), deps);
  if (text) process.stdout.write(`${text}\n`);
  if (refresh && existsSync(join(config.specsDir(), ".git")))
    startRefresh(config.opsHome(), process.env);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Watchdog: whatever happens (a hung import, a slow disk) the session is never held past 1.5 s.
  setTimeout(() => process.exit(0), WATCHDOG_MS).unref();
  try {
    await main();
  } catch {
    // fail open and silent
  }
  process.exitCode = 0; // let stdout drain; the unref'd watchdog never holds the process
}
