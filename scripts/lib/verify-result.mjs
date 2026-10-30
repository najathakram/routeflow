// Positive-pass token for `npm run verify` under the pre-push hook (W-1045).
//
// The hook used to read `npm run verify`'s exit code as the pass. A verify that was killed, crashed or cut short can
// still surface as exit 0 through the Windows Git Bash / npm / cmd chain, and the hook then recorded the verified-tree
// marker and let the push through with no tests run. Now the hook (scripts/verify-gate.mjs `run`) hands the chain a
// nonce and a result path, and only a run that WROTE a matching token passes:
//
//   1. verify-turbo.mjs writes the stage file when every planned turbo call returned the number 0 (`writeStage`).
//   2. the last link of the `verify` chain (`verify-gate.mjs commit`) promotes the stage to the result file, so a chain
//      cut short anywhere before it has no result.
//   3. the gate checks nonce + tree key + counts, deletes the one-use result and only then records the marker.
//
// Outside the hook none of the env is set and every function here is a no-op (humans, CI, `npm run verify` by hand).
import { randomBytes } from "node:crypto";
import fs from "node:fs";

export const RESULT_FILE_ENV = "RF_VERIFY_RESULT_FILE";
export const NONCE_ENV = "RF_VERIFY_NONCE";
export const TREE_KEY_ENV = "RF_VERIFY_TREE_KEY";

export const stageFile = (resultFile) => `${resultFile}.turbo`;
export const newNonce = () => randomBytes(12).toString("hex");

/** True only when every planned call ran and returned the NUMBER 0. null (signal), undefined and "0" are not a pass. */
export function isPositiveGreen(statuses, planned) {
  return (
    Number.isInteger(planned) &&
    Array.isArray(statuses) &&
    statuses.length === planned &&
    statuses.every((s) => s === 0)
  );
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** verify-turbo: record a green run. Returns false (writes nothing) when not under the hook or not positively green. */
export function writeStage(env, { planned, statuses }) {
  const file = env[RESULT_FILE_ENV];
  const nonce = env[NONCE_ENV];
  if (!file || !nonce || !isPositiveGreen(statuses, planned)) return false;
  writeJsonAtomic(stageFile(file), {
    v: 1,
    nonce,
    treeKey: env[TREE_KEY_ENV] ?? "",
    planned,
    ran: statuses.length,
    at: new Date().toISOString(),
  });
  return true;
}

/**
 * End of the verify chain: promote the stage to the result. `{ ok: true, skipped: true }` outside a hook run;
 * `{ ok: false }` inside one when the stage is missing or belongs to another run / tree.
 */
export function commitStage(env) {
  const file = env[RESULT_FILE_ENV];
  const nonce = env[NONCE_ENV];
  if (!file || !nonce) return { ok: true, skipped: true };
  const stage = readJson(stageFile(file));
  const verdict = matches(stage, { nonce, treeKey: env[TREE_KEY_ENV] ?? "" });
  if (!verdict.ok) return { ok: false, reason: `turbo stage: ${verdict.reason}` };
  fs.renameSync(stageFile(file), file);
  return { ok: true };
}

function matches(token, { nonce, treeKey }) {
  if (!token || typeof token !== "object") return { ok: false, reason: "no pass token" };
  if (token.nonce !== nonce) return { ok: false, reason: "pass token is from another run" };
  if (token.treeKey !== treeKey) return { ok: false, reason: "pass token is for another tree key" };
  if (!Number.isInteger(token.planned) || token.ran !== token.planned)
    return { ok: false, reason: "pass token does not cover every planned call" };
  return { ok: true, token };
}

/** Gate side: read the result file and judge it against the run's nonce and tree key. */
export function checkResult(file, { nonce, treeKey }) {
  return matches(readJson(file), { nonce, treeKey });
}
