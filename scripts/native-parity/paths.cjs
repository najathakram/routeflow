/**
 * #2338: where the native-parity harness writes captures. local-assets/ is gitignored (heavy files
 * policy): nothing captured here is ever committed. Every step of one run shares PARITY_DATE
 * (YYYY-MM-DD, set by scripts/native-parity/run.mjs; defaults to today, UTC) so the web, iPhone and
 * iPad images of a screen land side by side.
 */
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function parityDate(env = process.env) {
  const d = env.PARITY_DATE || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`PARITY_DATE must be YYYY-MM-DD, got "${d}"`);
  return d;
}

/** local-assets/proofs/<date>/native-parity/<role>/ */
function roleDir(role, env = process.env) {
  if (!/^[a-z]+$/.test(role)) throw new Error(`role must be lowercase letters, got "${role}"`);
  return path.join(REPO_ROOT, "local-assets", "proofs", parityDate(env), "native-parity", role);
}

/** <screen>-<state>-<surface>.png, surface = web | ios | ipad */
function captureFile(role, screen, state, surface, env = process.env) {
  return path.join(roleDir(role, env), `${screen}-${state}-${surface}.png`);
}

module.exports = { REPO_ROOT, parityDate, roleDir, captureFile };
