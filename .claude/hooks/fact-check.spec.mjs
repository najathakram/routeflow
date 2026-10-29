#!/usr/bin/env node
// Spec for .claude/hooks/fact-check.mjs (R0-a2). Plain node: `node .claude/hooks/fact-check.spec.mjs`.
// runHook is driven with fixture sources from scripts/fixtures/fact-check/cases.json (no gh, git or network); one case
// runs the hook as a child process on garbage stdin, one on a stamp-only message (no network) that must warn; the last
// pins that every SendMessage PreToolUse hook in .claude/settings.json goes through the shared checker.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../../scripts/fact-check.mjs";
import { runHook } from "./fact-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const DATA = JSON.parse(
  readFileSync(path.join(ROOT, "scripts", "fixtures", "fact-check", "cases.json"), "utf8"),
);
const caseOf = (id) => DATA.cases.find((c) => c.id === id);

let failures = 0;
let passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

const drive = (id, input = {}) => {
  const c = caseOf(id);
  const rows = [];
  const out = runHook(
    {
      session_id: "s1",
      tool_name: "SendMessage",
      tool_input: { to: "RouteFlow landing coordinator", message: c.message, ...input },
    },
    {
      core,
      sources: () => core.fixtureSources(DATA, c),
      now: () => Date.parse(c.now),
      append: (r) => rows.push(r),
    },
  );
  return { out: out ? JSON.parse(out) : null, rows };
};

{
  const { out, rows } = drive("T1");
  check("T1 warns through additionalContext", out?.hookSpecificOutput?.hookEventName, "PreToolUse");
  check(
    "T1 context names #3893",
    /MISMATCH ready #3893/.test(out?.hookSpecificOutput?.additionalContext),
    true,
  );
  check(
    "warn mode never sets permissionDecision",
    "permissionDecision" in (out?.hookSpecificOutput ?? {}),
    false,
  );
  check(
    "T1 logs one warned row",
    rows.map((r) => [r.decision, r.to, r.hits.length]),
    [["warned", "RouteFlow landing coordinator", 1]],
  );
}
{
  const { out, rows } = drive("T4");
  check(
    "T4 stamps ahead of date -u warn",
    out?.hookSpecificOutput?.additionalContext.match(/MISMATCH stamp/g)?.length,
    2,
  );
  check(
    "T4 logs the two stamp hits",
    rows[0].hits.map((h) => h.token),
    ["05:08Z", "05:20Z"],
  );
}
{
  const { out, rows } = drive("T8");
  check("T8 stale head warns", /631d718de/.test(out?.hookSpecificOutput?.additionalContext), true);
  check("T8 logged", rows.length, 1);
}
{
  const { out, rows } = drive("T16");
  check("clean message prints nothing", out, null);
  check(
    "clean message logs a clean row",
    rows.map((r) => r.decision),
    ["clean"],
  );
}
{
  const { out, rows } = drive("T1", { message: "thanks, nothing to add" });
  check("no tokens: nothing printed, nothing logged", [out, rows.length], [null, 0]);
}
{
  const { out, rows } = drive("T1", { message: "" });
  check("empty message (notify_when_idle) is skipped", [out, rows.length], [null, 0]);
}
{
  const { rows } = drive("T1", { to: undefined, session_id: "local_abc" });
  check("ccd send_message logs session_id as to", rows[0].to, "local_abc");
}
{
  const r = spawnSync(process.execPath, [path.join(HERE, "fact-check.mjs")], {
    input: "not json {{",
    encoding: "utf8",
    timeout: 30_000,
  });
  check("garbage stdin exits 0 and prints nothing", [r.status, r.stdout], [0, ""]);
}

{
  // A header stamp three hours ahead is a hit on the clock alone: no PR, sha or branch, so no gh or git network call.
  // An HH:MMZ stamp is read as today (over 12 h ahead means yesterday), so "3 h ahead" must not cross UTC
  // midnight: cap it before 23:58 and, in the day's last 4 minutes, wait for the new day first.
  const untilMidnight = () => 86_400_000 - (Date.now() % 86_400_000);
  if (untilMidnight() < 4 * 60_000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, untilMidnight() + 1_000);
  }
  const offset = Math.min(3 * 3600_000, untilMidnight() - 2 * 60_000);
  const ahead = new Date(Date.now() + offset).toISOString().slice(11, 16) + "Z";
  const logDir = mkdtempSync(path.join(os.tmpdir(), "fact-check-spec-"));
  const r = spawnSync(process.execPath, [path.join(HERE, "fact-check.mjs")], {
    input: JSON.stringify({
      session_id: "spec",
      tool_name: "SendMessage",
      cwd: ROOT,
      tool_input: { to: "lead", message: `${ahead} R0-a2 spawned check, ignore` },
    }),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, FACT_CHECK_LOG_DIR: logDir },
  });
  let event = null;
  try {
    event = JSON.parse(r.stdout).hookSpecificOutput?.hookEventName ?? null;
  } catch {
    /* stays null */
  }
  let rows = [];
  try {
    rows = readFileSync(path.join(logDir, "log.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l));
  } catch {
    /* stays empty */
  }
  check(
    "spawned: a future stamp warns, exits 0, logs one warned row to FACT_CHECK_LOG_DIR",
    [r.status, event, rows.length, rows[0]?.decision, typeof rows[0]?.ms === "number"],
    [0, "PreToolUse", 1, "warned", true],
  );
  rmSync(logDir, { recursive: true, force: true });
}

// Inventory pin: every PreToolUse hook whose matcher, read as the harness reads it (a regex; none = every tool),
// covers a send tool runs a file that calls the shared checker, inside the 25 s budget.
{
  const settings = JSON.parse(readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"));
  const covers = (matcher, tool) => {
    try {
      return new RegExp(`^(?:${matcher})$`).test(tool);
    } catch {
      return matcher === tool;
    }
  };
  const SEND_TOOLS = ["SendMessage", "mcp__ccd_session_mgmt__send_message"];
  const sendRows = (settings.hooks?.PreToolUse ?? []).filter(
    (r) => !r.matcher || SEND_TOOLS.some((t) => covers(r.matcher, t)),
  );
  check("a SendMessage PreToolUse row exists", sendRows.length > 0, true);
  const matcher = sendRows.map((r) => r.matcher).join("|");
  check(
    "it covers both send tools",
    /SendMessage/.test(matcher) && /mcp__ccd_session_mgmt__send_message/.test(matcher),
    true,
  );
  for (const r of sendRows)
    for (const h of r.hooks) {
      const file = h.command.match(/node\s+"?([^"\s]+\.mjs)/)?.[1];
      const src = file ? readFileSync(path.join(ROOT, file), "utf8") : "";
      check(`${file} calls checkFacts`, /checkFacts\(/.test(src), true);
      check(`${file} has a timeout`, typeof h.timeout === "number" && h.timeout <= 25, true);
    }
}

console.log(`fact-check hook spec: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
