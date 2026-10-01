/**
 * B923: finds every literal `apiClient.post|patch|put|delete("<path>")` call site in apps/mobile (non-test
 * sources) so the offline allow-list guard can require that each one is CLASSIFIED (allow-listed or
 * explicitly online-only). A template literal's `${...}` becomes `:p`; a query string is dropped.
 * Shared by the static guard and by `node __tests__/_mutation-scan.cjs` (prints the current inventory).
 */
const fs = require("fs");
const path = require("path");

const MOBILE_ROOT = path.resolve(__dirname, "..");
const ROOTS = ["lib", "app", "components", "hooks", "store"];
const CALL =
  /apiClient\s*\.\s*(post|patch|put|delete)\s*(?:<[^>()]*>)?\s*\(\s*([`"'])((?:(?!\2)[\s\S])*)\2/g;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) {
      out.push(full);
    }
  }
}

/** Map<"METHOD /normalized/path", string[] files> */
function scanMutationCallSites() {
  const files = [];
  for (const r of ROOTS) {
    const d = path.join(MOBILE_ROOT, r);
    if (fs.existsSync(d)) walk(d, files);
  }
  const sites = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    CALL.lastIndex = 0;
    let m;
    while ((m = CALL.exec(text))) {
      const p = m[3].replace(/\$\{[^}]*\}/g, ":p").split("?")[0];
      const key = `${m[1].toUpperCase()} ${p}`;
      if (!sites.has(key)) sites.set(key, []);
      sites.get(key).push(path.relative(MOBILE_ROOT, f).split(path.sep).join("/"));
    }
  }
  return sites;
}

module.exports = { scanMutationCallSites };

if (require.main === module) {
  const sites = scanMutationCallSites();
  const keys = [...sites.keys()].sort();
  console.log(keys.length);
  for (const k of keys) console.log(k);
}
