#!/usr/bin/env node
// Spec for .claude/hooks/agent-log.mjs (R1-a). Plain node: `node .claude/hooks/agent-log.spec.mjs`.
// Builds a fake session dir in the OS temp dir (a subagent transcript with duplicated message ids, two models and a
// 4-minute span, plus its meta.json), so no real transcript is read.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRow, mainRoot } from "./agent-log.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

const tmp = mkdtempSync(path.join(tmpdir(), "agent-log-spec-"));
const transcript = path.join(tmp, "sess-1.jsonl");
const subDir = path.join(tmp, "sess-1", "subagents");
mkdirSync(subDir, { recursive: true });
writeFileSync(transcript, "");
const usage = (input, output) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});
const line = (id, model, ts, u) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage: u } });
const agentFile = path.join(subDir, "agent-abc123.jsonl");
writeFileSync(
  agentFile,
  [
    JSON.stringify({ type: "user", timestamp: "2026-10-28T05:00:00.000Z", message: { content: "go" } }),
    line("m1", "claude-sonnet-5-5", "2026-10-28T05:00:00.000Z", usage(100, 1000)),
    line("m1", "claude-sonnet-5-5", "2026-10-28T05:00:00.500Z", usage(100, 1000)), // same API call, streamed twice
    line("m2", "claude-haiku-4-5", "2026-10-28T05:02:00.000Z", usage(10, 50)),
    line("m3", "claude-sonnet-5-5", "2026-10-28T05:04:00.000Z", usage(200, 2000)),
  ].join("\n") + "\n",
);
writeFileSync(
  agentFile.replace(/\.jsonl$/, ".meta.json"),
  JSON.stringify({ agentType: "general-purpose", description: "review #3893", effort: "medium" }),
);
const base = { session_id: "sess-1", transcript_path: transcript };

{
  const r = buildRow({ ...base, agent_id: "abc123" });
  check("A1 duration is the usage span", r.durationMs, 240_000);
  check("A1/A4 tokens are deduped by message id", r.tokens, 100 + 1000 + 10 + 50 + 200 + 2000);
  check("A1 cost is priced, not null", typeof r.costUsd === "number" && r.costUsd > 0, true);
  check("A1 the main model is the one with most tokens", r.model, "claude-sonnet-5-5");
  check("A1 meta fills description and effort", [r.description, r.effort, r.agentType], ["review #3893", "medium", "general-purpose"]);
  check("A1 src derived, v2, no nullReason", [r.src, r.v, r.nullReason], ["derived", 2, null]);
}
check("A2 agent_transcript_path wins", buildRow({ agent_transcript_path: agentFile }).src, "payload");
check(
  "A2b no agent_id: the newest transcript within 10 s",
  [buildRow(base).src, buildRow(base).agentId],
  ["newest", "abc123"],
);
check(
  "A2c a stale transcript is not adopted",
  buildRow(base, Date.now() + 60_000).nullReason,
  "no transcript",
);
{
  const r = buildRow({ session_id: "s", transcript_path: path.join(tmp, "none.jsonl"), agent_id: "x" });
  check("A3 no transcript: nulls with a reason", [r.tokens, r.costUsd, r.nullReason], [null, null, "no transcript"]);
}
{
  const src = readFileSync(path.join(HERE, "agent-log.mjs"), "utf8");
  check("A4 one accounting: counts through session-usage.mjs", /from "\.\.\/skills\/model-routing\/scripts\/session-usage\.mjs"/.test(src), true);
}
{
  const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify("file:///" + path.join(HERE, "..", "skills", "model-routing", "scripts", "session-usage.mjs").replace(/\\/g, "/"))}).then(() => console.log("imported"))`], { encoding: "utf8", timeout: 30_000 });
  check("A5 importing session-usage.mjs runs nothing", r.stdout.trim(), "imported");
}
{
  const wt = path.join(tmp, "wt");
  mkdirSync(wt);
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(tmp, "main", ".git", "worktrees", "wt")}\n`);
  check("worktree rows land in the main checkout", mainRoot(wt), path.join(tmp, "main"));
  check("the main checkout is itself", mainRoot(tmp), tmp);
}
{
  const r = spawnSync(process.execPath, [path.join(HERE, "agent-log.mjs")], { input: "not json {{", encoding: "utf8", timeout: 30_000 });
  check("garbage stdin exits 0 silently", [r.status, r.stdout], [0, ""]);
}
{
  const settings = JSON.parse(readFileSync(path.join(HERE, "..", "settings.json"), "utf8"));
  const cmds = (settings.hooks?.SubagentStop ?? []).flatMap((r) => r.hooks.map((h) => h.command));
  check("settings register the repo hook on SubagentStop", cmds.includes("node .claude/hooks/agent-log.mjs"), true);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`agent-log spec: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
