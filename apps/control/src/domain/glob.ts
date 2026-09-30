/** Glob to RegExp for declared areas (spec 5.2). Everything except `**`, `*`, `?` is escaped. */
export function globToRegex(glob: string): RegExp {
  if (/(^|\/)\.\.(\/|$)|\\/.test(glob)) throw new Error(`unsafe glob: ${glob}`);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // adjacent wildcards collapse so a hostile glob cannot stack `.*.*.*` (backtracking guard)
      if (!re.endsWith(".*")) re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      if (!re.endsWith(".*")) re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // a bare directory prefix (no wildcard, not a file) matches everything under it
  if (!/[*?]/.test(glob) && !/\.[A-Za-z0-9]+$/.test(glob)) re += "(/.*)?";
  return new RegExp(`^${re}$`);
}

/** The subset of `files` matched by any glob; backslashes in a file path normalise to `/`. */
export const expand = (globs: string[], files: string[]): Set<string> => {
  const res = globs.map(globToRegex);
  const out = new Set<string>();
  for (const raw of files) {
    const f = raw.replace(/\\/g, "/");
    if (res.some((r) => r.test(f))) out.add(f);
  }
  return out;
};
