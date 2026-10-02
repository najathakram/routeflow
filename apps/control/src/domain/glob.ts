/** Glob to RegExp for declared areas (spec 5.2). Everything except `**`, `*`, `?` is escaped. */
const MAX_GLOB = 256;
const MAX_PATH = 1024;
const MAX_STARS_PER_SEGMENT = 2;
const MAX_WILDCARD_RUNS = 4;

export function globToRegex(glob: string): RegExp {
  if (/(^|\/)\.\.(\/|$)|\\/.test(glob) || glob.length > MAX_GLOB) {
    throw new Error(`unsafe glob: ${glob.slice(0, 64)}`);
  }
  const g = glob
    .replace(/\/+$/, "")
    .replace(/(?:\*\*\/)+/g, "**/")
    .replace(/\*{3,}/g, "**");
  // ReDoS guard: bound how many wildcards can interact in one match.
  const runs = g.match(/[*?]+/g) ?? [];
  if (
    runs.length > MAX_WILDCARD_RUNS ||
    (g.match(/\*\*/g) ?? []).length > 2 ||
    g.split("/").some((s) => (s.match(/\*/g) ?? []).length > MAX_STARS_PER_SEGMENT)
  ) {
    throw new Error(`unsafe glob: ${glob.slice(0, 64)}`);
  }
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    const segStart = i === 0 || g[i - 1] === "/";
    if (c === "*" && g[i + 1] === "*") {
      i++;
      if (segStart && g[i + 1] === "/") {
        re += "(?:[^/]*/)*";
        i++;
      } else re += segStart && i + 1 === g.length ? ".*" : "[^/]*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // a bare directory prefix (no wildcard, not a file) matches everything under it
  if (!/[*?]/.test(g) && !/\.[A-Za-z0-9]+$/.test(g)) re += "(?:/.*)?";
  return new RegExp(`^${re}$`);
}

/** The subset of `files` matched by any glob; `\` normalises to `/`, a leading `./` is stripped. */
export const expand = (globs: string[], files: string[]): Set<string> => {
  const res = globs.map(globToRegex);
  const out = new Set<string>();
  for (const raw of files) {
    if (raw.length > MAX_PATH) continue;
    const f = raw.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
    if (res.some((r) => r.test(f))) out.add(f);
  }
  return out;
};
