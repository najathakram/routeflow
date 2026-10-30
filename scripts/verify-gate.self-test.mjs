#!/usr/bin/env node
// Self-test for scripts/verify-gate.mjs + scripts/lib/verify-result.mjs (W-1045).
// Wired into `npm run verify`. Exit 0 when every check passes, 1 otherwise.
//
// The bug class: the pre-push hook trusted `npm run verify`'s EXIT CODE as the pass. A verify that is killed,
// crashed or cut short can still surface as exit 0 somewhere in the Windows Git Bash / npm / cmd chain, and the
// hook then wrote the verified-tree marker and let the push through with no tests run. The gate now demands a
// POSITIVE pass token that verify-turbo writes only when every planned turbo call returned the number 0.
//
// Hermetic: stub "verify" commands in a temp dir, no git, no turbo, no heavy slot.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NONCE_ENV,
  RESULT_FILE_ENV,
  TREE_KEY_ENV,
  checkResult,
  isPositiveGreen,
  stageFile,
} from "./lib/verify-result.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "scripts", "verify-gate.mjs");
const LIB = pathToFileURL(path.join(ROOT, "scripts", "lib", "verify-result.mjs")).href;
const NODE = process.execPath;
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) failed += 1;
};

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "verify-gate-")));
const resultFile = path.join(tmp, "rf-verify-result");
const marker = path.join(tmp, "rf-verified");
const evidence = `${marker}.json`;
const stub = path.join(tmp, "stub.mjs");
writeFileSync(
  stub,
  `import { writeFileSync } from "node:fs";
import { writeStage, commitStage } from ${JSON.stringify(LIB)};
const mode = process.argv[2];
if (mode === "pass") {
  writeStage(process.env, { planned: 2, statuses: [0, 0] });
  const r = commitStage(process.env);
  process.exit(r.ok ? 0 : 7);
}
if (mode === "exit0-no-token") process.exit(0); // what a killed verify can look like to its caller
if (mode === "short") { // a turbo call never ran
  writeStage(process.env, { planned: 2, statuses: [0] });
  process.exit(commitStage(process.env).ok ? 0 : 0);
}
if (mode === "stale-token") { // a token from a PREVIOUS run sits in the result file
  process.exit(0);
}
if (mode === "wrong-tree") {
  writeStage({ ...process.env, ${JSON.stringify(TREE_KEY_ENV)}: "some-other-tree" }, { planned: 1, statuses: [0] });
  commitStage(process.env);
  process.exit(0);
}
if (mode === "wait") {
  writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1000);
}
`,
);

function resetFiles() {
  for (const f of [resultFile, stageFile(resultFile), marker, evidence]) rmSync(f, { force: true });
}
const gateArgs = (treeKey, record = true) => [
  GATE,
  "run",
  "--result-file",
  resultFile,
  "--tree-key",
  treeKey,
  "--marker",
  marker,
  ...(record ? ["--record-marker"] : []),
];
const cmdFor = (...args) => [`"${NODE}"`, `"${stub}"`, ...args].join(" ");
const runGate = (treeKey, stubArgs, record = true) =>
  spawnSync(NODE, gateArgs(treeKey, record), {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, RF_VERIFY_CMD: cmdFor(...stubArgs) },
  });

try {
  // ── isPositiveGreen: the only definition of "every planned call finished green" ──────────────
  ok("green: every planned call returned the number 0", isPositiveGreen([0, 0], 2));
  ok("not green: fewer calls ran than were planned", !isPositiveGreen([0], 2));
  ok("not green: nothing ran but something was planned", !isPositiveGreen([], 1));
  ok("not green: a null status (killed by a signal) is not a pass", !isPositiveGreen([0, null], 2));
  ok("not green: a string '0' is not a pass", !isPositiveGreen([0, "0"], 2));
  ok("not green: a non-zero status", !isPositiveGreen([0, 1], 2));
  ok("not green: planned count is not an integer", !isPositiveGreen([0], undefined));

  // ── the gate ─────────────────────────────────────────────────────────────────────────────────
  resetFiles();
  let r = runGate("tree-A", ["pass"]);
  ok("a verify that writes the positive token passes", r.status === 0, r.stderr + r.stdout);
  ok(
    "  ...and the marker holds the tree key",
    existsSync(marker) && readFileSync(marker, "utf8") === "tree-A",
  );
  const ev = existsSync(evidence) ? JSON.parse(readFileSync(evidence, "utf8")) : {};
  ok(
    "  ...and the evidence file records the run",
    ev.treeKey === "tree-A" && ev.planned === 2 && ev.ran === 2,
    JSON.stringify(ev),
  );
  ok("  ...and the one-use result file is consumed", !existsSync(resultFile));

  resetFiles();
  r = runGate("tree-A", ["exit0-no-token"]);
  ok("verify that exits 0 with NO token is refused (the false pass)", r.status !== 0);
  ok("  ...and no marker is written", !existsSync(marker) && !existsSync(evidence));
  ok(
    "  ...and the message says why",
    /no pass token/i.test(r.stderr + r.stdout),
    r.stderr + r.stdout,
  );

  resetFiles();
  r = runGate("tree-A", ["short"]);
  ok("a token for fewer calls than planned is refused", r.status !== 0 && !existsSync(marker));

  resetFiles();
  writeFileSync(
    resultFile,
    JSON.stringify({ v: 1, nonce: "an-old-run", treeKey: "tree-A", planned: 1, ran: 1 }),
  );
  r = runGate("tree-A", ["stale-token"]);
  ok(
    "a stale token from an earlier run does not carry over",
    r.status !== 0 && !existsSync(marker),
  );

  resetFiles();
  r = runGate("tree-A", ["wrong-tree"]);
  ok(
    "a token for a different tree key (e.g. fast vs full) is refused",
    r.status !== 0 && !existsSync(marker),
  );

  resetFiles();
  r = runGate("tree-A", ["pass"], false);
  ok(
    "a pass on a dirty tree succeeds but records no marker",
    r.status === 0 && !existsSync(marker) && !existsSync(evidence),
  );

  // ── the kill: verify killed mid-wait must refuse the push and write nothing ──────────────────
  resetFiles();
  const pidFile = path.join(tmp, "wait.pid");
  rmSync(pidFile, { force: true });
  const child = spawn(NODE, gateArgs("tree-A"), {
    cwd: tmp,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RF_VERIFY_CMD: cmdFor("wait", pidFile) },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  for (let i = 0; i < 100 && !existsSync(pidFile); i += 1)
    await new Promise((t) => setTimeout(t, 100));
  const waitPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
  ok("the stub verify is up and waiting", waitPid > 0);
  if (waitPid > 0) process.kill(waitPid, "SIGKILL");
  const done = await Promise.race([
    exited,
    new Promise((t) => setTimeout(() => t("timeout"), 15000)),
  ]);
  ok(
    "killed mid-wait: the gate exits non-zero",
    done !== "timeout" && done.code !== 0,
    JSON.stringify(done),
  );
  ok("  ...and no marker, no evidence", !existsSync(marker) && !existsSync(evidence));
  if (done === "timeout") child.kill("SIGKILL");

  // ── commit (the last link of the verify chain) ───────────────────────────────────────────────
  resetFiles();
  let c = spawnSync(NODE, [GATE, "commit"], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, [RESULT_FILE_ENV]: "", [NONCE_ENV]: "" },
  });
  ok("commit outside a hook run (no env) is a no-op", c.status === 0, c.stderr);
  c = spawnSync(NODE, [GATE, "commit"], {
    cwd: tmp,
    encoding: "utf8",
    env: {
      ...process.env,
      [RESULT_FILE_ENV]: resultFile,
      [NONCE_ENV]: "n1",
      [TREE_KEY_ENV]: "tree-A",
    },
  });
  ok(
    "commit inside a hook run with no turbo stage fails",
    c.status !== 0 && !existsSync(resultFile),
    c.stderr,
  );
  ok(
    "checkResult refuses a missing file",
    checkResult(path.join(tmp, "nope"), { nonce: "n1", treeKey: "tree-A" }).ok === false,
  );

  // ── the wiring: hook, chain and verify-turbo must all carry it ───────────────────────────────
  const hook = readFileSync(path.join(ROOT, ".husky", "pre-push"), "utf8");
  ok("pre-push runs the gate", /node scripts\/verify-gate\.mjs run\b/.test(hook));
  ok("pre-push no longer trusts a bare exit code", !/npm run verify \|\| exit 1/.test(hook));
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  ok(
    "the verify chain ends with the commit step (nothing after it can be skipped unseen)",
    pkg.scripts.verify.trim().endsWith("node scripts/verify-gate.mjs commit"),
  );
  ok(
    "the verify chain runs this self-test",
    pkg.scripts.verify.includes("node scripts/verify-gate.self-test.mjs"),
  );
  const vt = readFileSync(path.join(ROOT, "scripts", "verify-turbo.mjs"), "utf8");
  ok(
    "verify-turbo writes the stage token",
    /writeStage\(/.test(vt) && /isPositiveGreen|writeStage/.test(vt),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nverify-gate self-test: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\nverify-gate self-test: ok");
