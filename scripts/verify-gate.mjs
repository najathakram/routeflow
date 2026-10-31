#!/usr/bin/env node
// The pre-push hook's verify gate (W-1045): a push passes only on a POSITIVE pass token, never on an exit code alone.
//
//   node scripts/verify-gate.mjs run --result-file <f> --tree-key <k> [--marker <f> --record-marker]
//       runs `npm run verify` (override: RF_VERIFY_CMD, used by the self-test) with a fresh nonce, then requires the
//       token (scripts/lib/verify-result.mjs). A killed, crashed, signalled or empty verify exits 1 and writes nothing.
//       --record-marker: also write the verified-tree marker (+ `<marker>.json` evidence). The hook passes it only
//       for a clean tree, exactly as before.
//   node scripts/verify-gate.mjs commit
//       last link of the `verify` chain: promotes verify-turbo's stage to the result. No-op outside a hook run.
//   node scripts/verify-gate.mjs audit
//       lists every worktree's rf-verified marker and whether it has evidence (markers without it pre-date W-1045).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NONCE_ENV,
  RESULT_FILE_ENV,
  TREE_KEY_ENV,
  checkResult,
  commitStage,
  newNonce,
  stageFile,
} from "./lib/verify-result.mjs";

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--record-marker") o.recordMarker = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[(i += 1)];
    else o._.push(a);
  }
  return o;
}

function refuse(msg) {
  console.error(`\nverify-gate: PUSH REFUSED — ${msg}`);
  return 1;
}

async function run(o) {
  const resultFile = o["result-file"];
  const treeKey = o["tree-key"];
  if (!resultFile || treeKey === undefined)
    return refuse("usage: run --result-file <f> --tree-key <k>");
  for (const f of [resultFile, stageFile(resultFile)]) fs.rmSync(f, { force: true });
  const nonce = newNonce();
  const cmd = process.env.RF_VERIFY_CMD || "npm run verify";
  const { code, signal } = await new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
        [RESULT_FILE_ENV]: resultFile,
        [NONCE_ENV]: nonce,
        [TREE_KEY_ENV]: treeKey,
      },
    });
    child.on("error", () => resolve({ code: null, signal: "spawn-error" }));
    child.on("close", (c, s) => resolve({ code: c, signal: s }));
  });
  if (signal) return refuse(`verify ended by ${signal}, not by finishing.`);
  if (code !== 0) return refuse(`verify exited ${code}.`);
  const verdict = checkResult(resultFile, { nonce, treeKey });
  fs.rmSync(resultFile, { force: true });
  fs.rmSync(stageFile(resultFile), { force: true });
  if (!verdict.ok)
    return refuse(
      `verify exited 0 but there is no pass token (${verdict.reason}). It was killed, crashed or cut short; ` +
        "nothing is proven. Re-run the push.",
    );
  if (o.recordMarker && o.marker) {
    fs.writeFileSync(o.marker, treeKey);
    fs.writeFileSync(
      `${o.marker}.json`,
      JSON.stringify({
        treeKey,
        planned: verdict.token.planned,
        ran: verdict.token.ran,
        at: verdict.token.at,
      }),
    );
  }
  return 0;
}

function audit() {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  const trees = (r.stdout || "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9));
  let unproven = 0;
  for (const t of trees) {
    const g = spawnSync("git", ["-C", t, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" });
    const dir = (g.stdout || "").trim();
    const marker = path.join(dir, "rf-verified");
    if (!dir || !fs.existsSync(marker)) continue;
    const proven = fs.existsSync(`${marker}.json`);
    if (!proven) unproven += 1;
    console.log(`${proven ? "evidence" : "UNPROVEN"}  ${t}  ${fs.readFileSync(marker, "utf8")}`);
  }
  console.log(
    `${unproven} marker(s) without evidence (written before W-1045: delete them and re-push to be sure).`,
  );
  return 0;
}

export async function main(argv) {
  const o = parse(argv);
  const sub = o._[0];
  if (sub === "run") return run(o);
  if (sub === "commit") {
    const r = commitStage(process.env);
    if (!r.ok) return refuse(`verify chain finished but ${r.reason}.`);
    return 0;
  }
  if (sub === "audit") return audit();
  return refuse("usage: verify-gate.mjs run|commit|audit");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
