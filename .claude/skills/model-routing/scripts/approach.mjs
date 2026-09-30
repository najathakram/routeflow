#!/usr/bin/env node
// approach.mjs
//
// Lifecycle for the Part C 2026-09-12 evaluation-harness approach pin (see
// task-loop-rebuild.md "Part C design" -- Approach lifecycle). `next`
// classifies a task via route-task.mjs's decideApproach and pins an approach
// for the NEXT session (a fresh session is required for a superpowers pin to
// take effect -- isolation is a per-session plugin-enable switch that cannot
// flip mid-session); `status` reports the current pin; `close` records a
// superpowers/raw run's true cost via pipeline-ledger.mjs append-manual (or
// reminds to run closeout.mjs for a dev-pipeline OR bug-pipeline run --
// bug-pipeline is dev-pipeline's own bugfix mode, so it takes the same
// reminder-only path -- closeout.mjs stamps approach/profile itself) and
// then clears the pin; `attribute` forwards to
// pipeline-ledger.mjs attribute to record an escaped defect against a past
// run. See model-routing/references/EVAL-PROTOCOL.md (task 43) for the full
// protocol.
//
// No dependencies beyond Node's stdlib plus shelling out to two sibling
// scripts (route-task.mjs, pipeline-ledger.mjs). Node >= 18. ES module.
//
// Commands:
//   next --task "<head>" [--files a,b] [--project <dir>] [--force]
//   status [--project <dir>]
//   close --run <slug> [--task-ref <id>] [--first-pass-green true|false]
//         [--findings <critical>,<important>,<minor>] [--human-minutes <n>]
//         [--files-touched <n>] [--lines-changed <n>] [--project <dir>]
//   attribute --run <slug> --bug <id> [--project <dir>]
//   --selftest
//
// This script reads/writes, all under <project>/.claude/:
//   - approach.json        (the pin: {approach, profile, taskHead, pinnedAt,
//                            sessionId}) -- created by `next`, stamped with a
//                            real sessionId by orient.mjs's SessionStart
//                            hook, cleared by `close`.
//   - settings.local.json  (only the enabledPlugins[CONFIG.SUPERPOWERS_PLUGIN_KEY]
//                            entry is ever touched -- every other key, and
//                            every other enabledPlugins entry, is read back
//                            and rewritten verbatim)
// and shells out to (siblings of this script, both already built):
//   - route-task.mjs       (`next`'s classification, via --json)
//   - pipeline-ledger.mjs  (`close`'s append-manual, `attribute`'s pass-
//                            through to the `attribute` command)
// and writes nothing else, ever.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const ROUTE_TASK_SCRIPT = path.join(SCRIPT_DIR, "route-task.mjs");
const LEDGER_SCRIPT = path.join(SCRIPT_DIR, "pipeline-ledger.mjs");

// Part C task 41 (C5, owner-facing): the real, confirmed marketplace key for
// this installation -- superpowers was installed on this machine via
// `claude plugin install superpowers@claude-plugins-official --scope user`,
// so this is the actual enabledPlugins key next/status/close toggle, not a
// placeholder.
const CONFIG = {
  SUPERPOWERS_PLUGIN_KEY: "superpowers@claude-plugins-official",
};

class ApproachError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// small fs helpers
// ---------------------------------------------------------------------------

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function pinPath(projectDir) {
  return path.join(projectDir, ".claude", "approach.json");
}

function settingsPath(projectDir) {
  return path.join(projectDir, ".claude", "settings.local.json");
}

function readPin(projectDir) {
  return safeReadJson(pinPath(projectDir));
}

function writePin(projectDir, pin) {
  const p = pinPath(projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(pin, null, 2) + "\n", "utf8");
}

function clearPin(projectDir) {
  try {
    fs.unlinkSync(pinPath(projectDir));
  } catch {
    /* already gone -- close is idempotent */
  }
}

// Merges ONLY enabledPlugins[key] = value into settings.local.json; every
// other key (and every other enabledPlugins entry) is preserved verbatim.
// Creates the file (and .claude/) if absent.
function setPluginEnabled(projectDir, key, value) {
  const p = settingsPath(projectDir);
  const existing = safeReadJson(p) || {};
  const enabledPlugins = { ...(existing.enabledPlugins || {}), [key]: value };
  const next = { ...existing, enabledPlugins };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

// ---------------------------------------------------------------------------
// sibling-script wrappers
// ---------------------------------------------------------------------------

// Classifies a task via route-task.mjs's decideApproach. Uses a synthetic
// "pending-..." session id -- there is no real session yet (this runs in the
// CURRENT session, pinning for the NEXT one) -- purely so decideApproach's
// once-per-session rotation advances exactly once for this `next` call; the
// pin file itself is written with sessionId:null and is what actually wins
// (pin precedence beats rotation) once orient.mjs stamps the real session id
// on the next session's first turn, so this placeholder id is never looked
// up again.
function classify(taskText, files, projectDir) {
  const pendingSessionId = `pending-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  // --allow-superpowers: `next` IS the mechanism that flips the plugin
  // BEFORE a new session starts, so (unlike an ordinary live hook call) it
  // must be able to actually claim a superpowers rotation slot rather than
  // route-task.mjs's default defer-forward behavior.
  const args = [
    ROUTE_TASK_SCRIPT,
    taskText,
    "--project",
    projectDir,
    "--session-id",
    pendingSessionId,
    "--allow-superpowers",
    "--json",
  ];
  if (files && files.length) args.push("--files", files.join(","));
  let out;
  try {
    out = execFileSync(process.execPath, args, { encoding: "utf8" });
  } catch (err) {
    throw new ApproachError(`next: route-task.mjs failed to classify the task: ${err.message}`, 3);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new ApproachError(`next: route-task.mjs did not return JSON: ${out.slice(0, 200)}`, 3);
  }
  if (!parsed.approach) {
    throw new ApproachError(
      "next: route-task.mjs classified this as conversational/a question -- no approach to pin. Give a real task.",
      2,
    );
  }
  return parsed.approach; // { approach, profile, why, deferNote }
}

function runLedger(args, projectDir) {
  return execFileSync(process.execPath, [LEDGER_SCRIPT, ...args, "--project", projectDir], {
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function cmdNext(flags, projectDir) {
  if (typeof flags.task !== "string" || !flags.task.trim()) {
    throw new ApproachError('next: --task "<head>" is required.');
  }

  // Fix 1 (2026-09-12 review): classify() shells out to route-task.mjs, which
  // reads whatever pin is CURRENTLY on disk BEFORE we overwrite it below --
  // and decideApproach's pin rule matches ANY pin with sessionId == null, not
  // just the one this call is about to write. Left unchecked, a stale
  // unclaimed pin from a previous `next` (nothing ever claimed it via
  // orient.mjs) gets silently reused for an unrelated new task. Refuse
  // instead, unless the caller passes --force.
  const force = flags.force === true || flags.force === "true";
  const stale = readPin(projectDir);
  if (stale && stale.sessionId == null) {
    if (!force) {
      throw new ApproachError(
        `next: an unclaimed pin already exists (taskHead: "${stale.taskHead}", pinnedAt: ${stale.pinnedAt}) -- start the session that will claim it, or run "approach.mjs close"/delete .claude/approach.json, before pinning a new task. Pass --force to overwrite anyway.`,
      );
    }
    // --force ("legitimate re-pinning"): clear the stale pin BEFORE
    // classify() runs, not after. classify() shells out to route-task.mjs,
    // which reads whatever is on disk RIGHT NOW -- leaving the stale pin in
    // place would make decideApproach's pin-precedence rule match it (any
    // sessionId:null pin matches any session) and hand back the abandoned
    // task's approach relabeled with the new taskHead, which is the exact
    // silent-reuse bug this fix exists to prevent. Clearing it here makes
    // --force actually re-classify instead of just renaming the old pin.
    clearPin(projectDir);
  }

  const files =
    typeof flags.files === "string"
      ? flags.files
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const decision = classify(flags.task, files, projectDir);
  const pin = {
    approach: decision.approach,
    profile: decision.profile || null,
    taskHead: flags.task.slice(0, 200),
    pinnedAt: new Date().toISOString(),
    sessionId: null,
  };
  writePin(projectDir, pin);

  const wantsSuperpowers = decision.approach === "superpowers";
  setPluginEnabled(projectDir, CONFIG.SUPERPOWERS_PLUGIN_KEY, wantsSuperpowers);

  const label = pin.profile ? `${pin.approach}:${pin.profile}` : pin.approach;
  console.log(`next: pinned approach ${label} (${decision.why})`);
  console.log(`  enabledPlugins["${CONFIG.SUPERPOWERS_PLUGIN_KEY}"] = ${wantsSuperpowers}`);
  if (decision.deferNote) console.log(`  Note: ${decision.deferNote}`);
  console.log("Start a NEW session for this pin to take effect.");
  return { pin, decision };
}

function cmdStatus(flags, projectDir) {
  const pin = readPin(projectDir);
  if (!pin) {
    console.log("status: no approach pinned.");
    return { pin: null };
  }
  const label = pin.profile ? `${pin.approach}:${pin.profile}` : pin.approach;
  console.log(`status: pinned ${label}`);
  console.log(`  task: ${pin.taskHead}`);
  console.log(`  pinnedAt: ${pin.pinnedAt}`);
  console.log(
    `  sessionId: ${pin.sessionId || "(not yet claimed -- orient.mjs stamps it at SessionStart)"}`,
  );
  return { pin };
}

function cmdClose(flags, projectDir) {
  if (typeof flags.run !== "string" || !flags.run) {
    throw new ApproachError("close: --run <slug> is required.");
  }
  const pin = readPin(projectDir);
  if (!pin) {
    throw new ApproachError("close: no approach pinned -- nothing to close.");
  }

  let result;
  // Fix 2 (2026-09-12 review): bug-pipeline is dev-pipeline's own bugfix mode
  // -- an engine run whose true cost lands via closeout.mjs, same as a plain
  // dev-pipeline run -- so it must take the same reminder-only branch.
  // Falling through to the append-manual branch below is wrong for it:
  // pipeline-ledger.mjs's append-manual only accepts approach
  // superpowers|raw, so a bug-pipeline pin would throw there and leave the
  // pin stuck forever (the throw happens before the plugin-disable/pin-clear
  // cleanup at the bottom of this function ever runs).
  if (pin.approach === "dev-pipeline" || pin.approach === "bug-pipeline") {
    console.log(
      `close: ${pin.approach} runs are closed via closeout.mjs (it stamps approach/profile itself).`,
    );
    console.log(
      `  node ~/.claude/skills/dev-pipeline/scripts/closeout.mjs <runDir> --project "${projectDir}"`,
    );
    result = { reminder: "closeout.mjs" };
  } else {
    if (!pin.sessionId) {
      throw new ApproachError(
        "close: this pin has no sessionId yet -- orient.mjs stamps it at SessionStart; run at least one prompt in the pinned session first.",
      );
    }
    const ledgerArgs = [
      "append-manual",
      "--run",
      flags.run,
      "--approach",
      pin.approach,
      "--session",
      pin.sessionId,
    ];
    if (typeof flags["task-ref"] === "string") ledgerArgs.push("--task-ref", flags["task-ref"]);
    if (typeof flags["first-pass-green"] === "string")
      ledgerArgs.push("--first-pass-green", flags["first-pass-green"]);
    if (typeof flags.findings === "string") ledgerArgs.push("--findings", flags.findings);
    if (typeof flags["human-minutes"] === "string")
      ledgerArgs.push("--human-minutes", flags["human-minutes"]);
    if (typeof flags["files-touched"] === "string")
      ledgerArgs.push("--files-touched", flags["files-touched"]);
    if (typeof flags["lines-changed"] === "string")
      ledgerArgs.push("--lines-changed", flags["lines-changed"]);
    let out;
    try {
      out = runLedger(ledgerArgs, projectDir);
    } catch (err) {
      throw new ApproachError(`close: pipeline-ledger.mjs append-manual failed: ${err.message}`, 3);
    }
    process.stdout.write(out);
    result = { appended: true };
  }

  setPluginEnabled(projectDir, CONFIG.SUPERPOWERS_PLUGIN_KEY, false);
  clearPin(projectDir);
  console.log("close: pin cleared; superpowers plugin disabled.");
  return result;
}

function cmdAttribute(flags, projectDir) {
  if (typeof flags.run !== "string" || !flags.run) {
    throw new ApproachError("attribute: --run <slug> is required.");
  }
  if (typeof flags.bug !== "string" || !flags.bug) {
    throw new ApproachError("attribute: --bug <id> is required.");
  }
  let out;
  try {
    out = runLedger(["attribute", "--run", flags.run, "--bug", flags.bug], projectDir);
  } catch (err) {
    throw new ApproachError(`attribute: pipeline-ledger.mjs attribute failed: ${err.message}`, 3);
  }
  process.stdout.write(out);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[name] = true;
      else {
        flags[name] = next;
        i++;
      }
      continue;
    }
    positional.push(tok);
  }
  return { positional, flags };
}

function printHelp() {
  console.log(`approach.mjs -- pin/status/close/attribute the Part C evaluation-harness approach

Usage:
  node approach.mjs next --task "<head>" [--files a,b] [--project <dir>] [--force]
  node approach.mjs status [--project <dir>]
  node approach.mjs close --run <slug> [--task-ref <id>] [--first-pass-green true|false]
                    [--findings <c,i,m>] [--human-minutes <n>] [--project <dir>]
  node approach.mjs attribute --run <slug> --bug <id> [--project <dir>]
  node approach.mjs --selftest`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--selftest" || argv[0] === "selftest") {
    process.exit(runSelftest());
  }
  if (!argv[0] || argv[0] === "-h" || argv[0] === "--help") {
    printHelp();
    process.exit(argv[0] ? 0 : 1);
  }

  const cmd = argv[0];
  const rest = argv.slice(1);
  const { flags } = parseFlags(rest);
  const projectDir = path.resolve(
    typeof flags.project === "string" ? flags.project : process.cwd(),
  );

  try {
    switch (cmd) {
      case "next":
        cmdNext(flags, projectDir);
        break;
      case "status":
        cmdStatus(flags, projectDir);
        break;
      case "close":
        cmdClose(flags, projectDir);
        break;
      case "attribute":
        cmdAttribute(flags, projectDir);
        break;
      default:
        process.stderr.write(`Unknown command '${cmd}'.\n\n`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ApproachError) {
      process.stderr.write(err.message + "\n");
      process.exitCode = err.code || 2;
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

function assert(cond, label, failures) {
  if (!cond) failures.push(label);
}

function writeFakeUsageScript(dir, costUsd, activeMs) {
  const p = path.join(dir, "fake-session-usage.mjs");
  fs.writeFileSync(
    p,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      `const costUsd = ${JSON.stringify(costUsd)};`,
      `const activeMs = ${JSON.stringify(activeMs)};`,
      "console.log(JSON.stringify({",
      "  v: 1, sessionId: args[0], project: 'fake-project', pricesAsOf: '2026-06-24',",
      "  session: { byModel: {}, total: { input:0,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:0,tokens:0,costUsd }, messages:1, firstAt:'2026-09-12T00:00:00.000Z', lastAt:'2026-09-12T00:20:00.000Z', activeMs, cacheHitRatio:0.5 },",
      "  workflows: {}, warnings: [],",
      "}));",
      "",
    ].join("\n"),
    "utf8",
  );
  return p;
}

function runSelftest() {
  const failures = [];
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "approach-selftest-"));

  try {
    // -----------------------------------------------------------------------
    // 1-3: `next` on a HIGH-risk task -> dev-pipeline:standard pin, plugin
    // disabled (never superpowers for a HIGH-risk task).
    // -----------------------------------------------------------------------
    const projA = path.join(tmpBase, "proj-a");
    fs.mkdirSync(projA, { recursive: true });
    cmdNext({ task: "Add a new field to the billing schema for payment reconciliation" }, projA);
    const pinA = readPin(projA);
    assert(
      pinA && pinA.approach === "dev-pipeline" && pinA.profile === "standard",
      "1: next pins dev-pipeline:standard for a HIGH-risk task",
      failures,
    );
    assert(
      pinA && pinA.sessionId === null,
      "2: a freshly written pin has sessionId:null (unclaimed)",
      failures,
    );
    const settingsA = safeReadJson(settingsPath(projA));
    assert(
      settingsA && settingsA.enabledPlugins[CONFIG.SUPERPOWERS_PLUGIN_KEY] === false,
      "3: next disables the superpowers plugin for a non-superpowers pin",
      failures,
    );

    // -----------------------------------------------------------------------
    // 4: `next` forced onto the rotation's superpowers slot pins superpowers
    // and enables the plugin (the plan's C5 acceptance check: "approach.mjs
    // next --task 'x' forced to superpowers flips it to true"). Force it by
    // seeding the rotation state so its next slot is index 1 (superpowers).
    // -----------------------------------------------------------------------
    const projB = path.join(tmpBase, "proj-b");
    fs.mkdirSync(path.join(projB, ".claude", "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(projB, ".claude", "pipeline", "approach-rotation.json"),
      JSON.stringify({ next: 1, log: [] }),
    );
    cmdNext({ task: "Add a CSV export to orders" }, projB);
    const pinB = readPin(projB);
    assert(
      pinB && pinB.approach === "superpowers",
      "4: next forced to the rotation's superpowers slot pins superpowers",
      failures,
    );
    const settingsB = safeReadJson(settingsPath(projB));
    assert(
      settingsB && settingsB.enabledPlugins[CONFIG.SUPERPOWERS_PLUGIN_KEY] === true,
      "5: next flips the superpowers plugin to true when it pins superpowers",
      failures,
    );

    // -----------------------------------------------------------------------
    // 6: `next` on a conversational/question "task" refuses -- nothing to
    // pin -- and leaves any prior pin untouched.
    // -----------------------------------------------------------------------
    const projC = path.join(tmpBase, "proj-c");
    fs.mkdirSync(projC, { recursive: true });
    let threw = null;
    try {
      cmdNext({ task: "is this done?" }, projC);
    } catch (err) {
      threw = err;
    }
    assert(
      threw instanceof ApproachError,
      "6: next on a conversational prompt refuses (throws ApproachError)",
      failures,
    );
    assert(readPin(projC) === null, "7: a refused next writes no pin", failures);

    // -----------------------------------------------------------------------
    // 8: `status` reports the current pin's fields.
    // -----------------------------------------------------------------------
    const statusA = cmdStatus({}, projA);
    assert(
      statusA.pin && statusA.pin.approach === "dev-pipeline",
      "8: status reports the current pin",
      failures,
    );
    const statusC = cmdStatus({}, projC);
    assert(statusC.pin === null, "9: status reports no pin for a project with none", failures);

    // -----------------------------------------------------------------------
    // 10-14: `close` for a superpowers/raw pin -- append-manual against a
    // scratch ledger via a stubbed session-usage.mjs, then plugin disabled +
    // pin cleared.
    // -----------------------------------------------------------------------
    const projD = path.join(tmpBase, "proj-d");
    fs.mkdirSync(projD, { recursive: true });
    writePin(projD, {
      approach: "raw",
      profile: null,
      taskHead: "Add a CSV export to orders",
      pinnedAt: "2026-09-12T00:00:00.000Z",
      sessionId: "sess-close-1", // simulates orient.mjs's SessionStart stamp
    });
    setPluginEnabled(projD, CONFIG.SUPERPOWERS_PLUGIN_KEY, false);

    const fakeUsagePath = writeFakeUsageScript(tmpBase, 3.25, 900000);
    const priorUsageScript = process.env.PIPELINE_LEDGER_USAGE_SCRIPT;
    process.env.PIPELINE_LEDGER_USAGE_SCRIPT = fakeUsagePath;
    try {
      cmdClose(
        {
          run: "selftest-raw-run-1",
          "task-ref": "B999",
          "first-pass-green": "true",
          findings: "0,1,2",
          "human-minutes": "18",
        },
        projD,
      );
    } finally {
      if (priorUsageScript === undefined) delete process.env.PIPELINE_LEDGER_USAGE_SCRIPT;
      else process.env.PIPELINE_LEDGER_USAGE_SCRIPT = priorUsageScript;
    }

    const ledgerPathD = path.join(projD, ".claude", "pipeline", "cost-ledger.jsonl");
    assert(fs.existsSync(ledgerPathD), "10: close appends a row to the scratch ledger", failures);
    const rowsD = fs
      .readFileSync(ledgerPathD, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const rowD = rowsD.find((r) => r.run === "selftest-raw-run-1");
    assert(
      rowD && rowD.approach === "raw" && rowD.telemetry === "true",
      "11: the appended row carries approach:raw and telemetry:true",
      failures,
    );
    assert(
      rowD && rowD.trueCostUsd === 3.25,
      "12: the appended row's trueCostUsd comes from the stubbed session-usage.mjs",
      failures,
    );
    assert(readPin(projD) === null, "13: close clears the pin", failures);
    const settingsD = safeReadJson(settingsPath(projD));
    assert(
      settingsD.enabledPlugins[CONFIG.SUPERPOWERS_PLUGIN_KEY] === false,
      "14: close disables the superpowers plugin",
      failures,
    );

    // -----------------------------------------------------------------------
    // 15-16: `close` for a dev-pipeline pin -- reminder only (no ledger
    // append attempted), pin still cleared.
    // -----------------------------------------------------------------------
    const projE = path.join(tmpBase, "proj-e");
    fs.mkdirSync(projE, { recursive: true });
    writePin(projE, {
      approach: "dev-pipeline",
      profile: "standard",
      taskHead: "x",
      pinnedAt: "2026-09-12T00:00:00.000Z",
      sessionId: "sess-close-2",
    });
    cmdClose({ run: "selftest-devpipeline-run" }, projE);
    assert(
      !fs.existsSync(path.join(projE, ".claude", "pipeline", "cost-ledger.jsonl")),
      "15: close on a dev-pipeline pin never appends a ledger row itself",
      failures,
    );
    assert(
      readPin(projE) === null,
      "16: close on a dev-pipeline pin still clears the pin",
      failures,
    );

    // -----------------------------------------------------------------------
    // 17: `close` with no pin at all refuses.
    // -----------------------------------------------------------------------
    const projF = path.join(tmpBase, "proj-f");
    fs.mkdirSync(projF, { recursive: true });
    let closeThrew = null;
    try {
      cmdClose({ run: "x" }, projF);
    } catch (err) {
      closeThrew = err;
    }
    assert(closeThrew instanceof ApproachError, "17: close with no pin refuses", failures);

    // -----------------------------------------------------------------------
    // 18-19: `close` for a superpowers/raw pin with NO sessionId yet
    // (unclaimed) refuses -- append-manual needs a real session id.
    // -----------------------------------------------------------------------
    const projG = path.join(tmpBase, "proj-g");
    fs.mkdirSync(projG, { recursive: true });
    writePin(projG, {
      approach: "raw",
      profile: null,
      taskHead: "x",
      pinnedAt: "now",
      sessionId: null,
    });
    let closeUnclaimedThrew = null;
    try {
      cmdClose({ run: "x" }, projG);
    } catch (err) {
      closeUnclaimedThrew = err;
    }
    assert(
      closeUnclaimedThrew instanceof ApproachError,
      "18: close on an unclaimed (sessionId:null) raw/superpowers pin refuses",
      failures,
    );
    assert(
      readPin(projG) !== null,
      "19: a refused close (unclaimed pin) leaves the pin in place",
      failures,
    );

    // -----------------------------------------------------------------------
    // 20-21: `attribute` forwards to pipeline-ledger.mjs attribute and bumps
    // escapedDefects on the row appended above (projD).
    // -----------------------------------------------------------------------
    cmdAttribute({ run: "selftest-raw-run-1", bug: "B123" }, projD);
    const rowsD2 = fs
      .readFileSync(ledgerPathD, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const rowD2 = rowsD2.find((r) => r.run === "selftest-raw-run-1");
    assert(
      rowD2 && rowD2.quality && rowD2.quality.escapedDefects === 1,
      "20: attribute bumps escapedDefects on the target row",
      failures,
    );
    assert(
      rowD2 &&
        Array.isArray(rowD2.quality.escapedBugs) &&
        rowD2.quality.escapedBugs.includes("B123"),
      "21: attribute records the bug id",
      failures,
    );

    // -----------------------------------------------------------------------
    // 22: settings.local.json's OTHER keys survive a plugin toggle untouched
    // (setPluginEnabled must merge, never overwrite the file).
    // -----------------------------------------------------------------------
    const projH = path.join(tmpBase, "proj-h");
    fs.mkdirSync(path.join(projH, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(projH, ".claude", "settings.local.json"),
      JSON.stringify({ someOtherSetting: "keep-me", enabledPlugins: { "other-plugin@mkt": true } }),
    );
    setPluginEnabled(projH, CONFIG.SUPERPOWERS_PLUGIN_KEY, true);
    const settingsH = safeReadJson(settingsPath(projH));
    assert(
      settingsH.someOtherSetting === "keep-me",
      "22a: an unrelated settings.local.json key survives the toggle",
      failures,
    );
    assert(
      settingsH.enabledPlugins["other-plugin@mkt"] === true,
      "22b: an unrelated enabledPlugins entry survives the toggle",
      failures,
    );
    assert(
      settingsH.enabledPlugins[CONFIG.SUPERPOWERS_PLUGIN_KEY] === true,
      "22c: the superpowers key itself is set as requested",
      failures,
    );

    // -----------------------------------------------------------------------
    // 23-24: CLI subprocess contract -- `--selftest` and unknown-command exit
    // codes (smoke test of main()'s dispatch, not just the direct cmd* calls
    // exercised above).
    // -----------------------------------------------------------------------
    {
      const res = spawnSyncSelf(["status", "--project", projA]);
      assert(res.status === 0, "23: CLI `status` subprocess exits 0", failures);
    }
    {
      const res = spawnSyncSelf(["bogus-command"]);
      assert(res.status === 1, "24: CLI unknown command exits 1", failures);
    }

    // -----------------------------------------------------------------------
    // 25-27 (Fix 1, 2026-09-12 review): `next` refuses to reuse a stale
    // unclaimed pin (sessionId:null) left by a previous `next` call, and
    // --force overrides that refusal.
    // -----------------------------------------------------------------------
    const projI = path.join(tmpBase, "proj-i");
    fs.mkdirSync(projI, { recursive: true });
    cmdNext({ task: "Add a CSV export to orders" }, projI);
    const pinI1 = readPin(projI);
    assert(
      pinI1 && pinI1.sessionId === null,
      "25: setup -- first next on proj-i leaves an unclaimed pin",
      failures,
    );
    let staleThrew = null;
    try {
      cmdNext({ task: "Add an unrelated second export feature" }, projI);
    } catch (err) {
      staleThrew = err;
    }
    assert(
      staleThrew instanceof ApproachError,
      "26: next refuses to reclassify over a stale unclaimed pin",
      failures,
    );
    const pinI2 = readPin(projI);
    assert(
      pinI2 && pinI2.taskHead === pinI1.taskHead,
      "27: a refused next leaves the original stale pin untouched",
      failures,
    );
    cmdNext({ task: "Add an unrelated second export feature", force: true }, projI);
    const pinI3 = readPin(projI);
    assert(
      pinI3 && pinI3.taskHead === "Add an unrelated second export feature",
      "28: --force overwrites a stale unclaimed pin",
      failures,
    );
    assert(
      pinI3 && pinI3.approach === "superpowers",
      "28b: --force triggers a genuinely fresh classification (rotation advances to the next arm), not a relabeled copy of the stale pin's approach",
      failures,
    );

    // -----------------------------------------------------------------------
    // 29-30 (Fix 2, 2026-09-12 review): `close` on a bug-pipeline pin takes
    // the same closeout.mjs-reminder path as dev-pipeline -- never
    // append-manual (which would throw on approach:bug-pipeline and leave
    // the pin stuck) -- and still clears the pin.
    // -----------------------------------------------------------------------
    const projJ = path.join(tmpBase, "proj-j");
    fs.mkdirSync(projJ, { recursive: true });
    writePin(projJ, {
      approach: "bug-pipeline",
      profile: null,
      taskHead: "Fix bug B234: checkout crashes on submit",
      pinnedAt: "2026-09-12T00:00:00.000Z",
      sessionId: "sess-close-3",
    });
    cmdClose({ run: "selftest-bugpipeline-run" }, projJ);
    assert(
      !fs.existsSync(path.join(projJ, ".claude", "pipeline", "cost-ledger.jsonl")),
      "29: close on a bug-pipeline pin never appends a ledger row itself (reminder-only, like dev-pipeline)",
      failures,
    );
    assert(readPin(projJ) === null, "30: close on a bug-pipeline pin clears the pin", failures);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`approach.mjs selftest: ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(
    "approach.mjs selftest: all checks passed (31 scenarios: next's dev-pipeline/superpowers/refused-conversational pin paths, status, close for superpowers/raw via a stubbed session-usage.mjs against a scratch ledger, close for dev-pipeline as a reminder-only path, close's no-pin and unclaimed-pin refusals, attribute's escapedDefects pass-through, settings.local.json merge-not-overwrite, the CLI subprocess dispatch, Fix 1 (2026-09-12 review) next's stale-unclaimed-pin refusal + --force override, and Fix 2 (2026-09-12 review) close's bug-pipeline reminder-only path).",
  );
  return 0;
}

function spawnSyncSelf(args) {
  return spawnSync(process.execPath, [__filename, ...args], { encoding: "utf8" });
}

main();
