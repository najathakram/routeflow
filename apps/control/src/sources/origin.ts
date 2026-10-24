/**
 * The state remote (B938): where `ctl` keeps the `ctl/state` branch. It is configured, never
 * guessed: `--origin`, then `CONTROL_STATE_ORIGIN`, then the first line of
 * `<config dir>/origin`, else NONE. Every resolved value is refused when it points at the product
 * repo itself, because that repo goes public during CI windows and the state must stay private.
 * No network here; the only processes spawned are read-only, offline git queries (`ls-remote
 * --get-url`, `config --get-regexp`, `remote`) that resolve the origin the way the git `ctl` spawns
 * would: `url.<base>.insteadOf` / `pushInsteadOf`, and every remote of a LOCAL repo, recursively.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CtlError, assertOrigin, gitAnywhere, gitTry } from "./git";

/** What every verb prints when no state remote is configured. */
export const NO_STATE_REMOTE = "no state remote configured — run `ctl origin set <url>`";

export type OriginSource = "flag" | "env" | "file" | "none";
export interface ResolvedOrigin {
  origin: string | null;
  source: OriginSource;
}

/** The refused repo, as `owner/name`. */
const FORBIDDEN = "najathakram/routeflow";
/** Left boundary: anything that is not part of an owner name, so `ext::ssh ... owner/repo` is caught. */
const BOUNDARY_RE = new RegExp(`(^|[^a-z0-9-])${FORBIDDEN.replace("/", "\\/")}$`);
/** How deep `localRepoPointsAtProduct` follows remotes that are themselves local repos. */
const MAX_LOCAL_DEPTH = 3;

/**
 * Strip credentials and anything after `?`/`#` (a token can ride in a query or fragment):
 * `scheme://user:tok@host/p?x#y` -> `scheme://host/p?<redacted>`, `user:tok@host:path` -> `user@host:path`.
 */
export function redactUrl(url: string): string {
  const t = url.trim();
  const body = /^[a-z][a-z0-9+.-]*:\/\//i.test(t)
    ? t.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1")
    : t.replace(/^([^@/:\s]+):[^@/\s]*@/, "$1@");
  return body.replace(/[?#][\s\S]*$/, "?<redacted>");
}

/** Percent-decode every valid `%XX` (up to three layers); malformed escapes are left alone. */
function decodeAll(s: string): string {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    const next = cur.replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * True when the URL string names the product repo. Fails closed: case-insensitive, decoded,
 * query/fragment dropped, `.`/`..`/empty path segments resolved, trailing slashes, dots, control
 * characters and any mix of `.git` / `.wiki` suffixes ignored (the wiki repo goes public with the product repo), any host, any
 * scheme (including scp-like `host-alias:owner/repo`).
 */
export function isRouteflowOrigin(url: string): boolean {
  let s = decodeAll(url).normalize("NFKC").toLowerCase().trim().replace(/\\/g, "/");
  s = s.replace(/[?#][\s\S]*$/, "");
  const segs: string[] = [];
  for (const p of s.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") segs.pop();
    else segs.push(p);
  }
  s = segs.join("/");
  // one loop: `/.git`, `.wiki.git`, `.git/`, a trailing `.` or control character (what a
  // percent-encoded `%2e` / `%00` decodes to) ... in any order or repetition, until stable
  for (;;) {
    const next = stripTail(s);
    if (next === s) break;
    s = next;
  }
  return BOUNDARY_RE.test(s);
}

/** Remove ONE trailing `/`, `.git`, `.wiki`, `.` or control character / space (else return `s` as is). */
function stripTail(s: string): string {
  const last = s.length === 0 ? -1 : s.charCodeAt(s.length - 1);
  if (last === 0x2f || last === 0x2e || last <= 0x20 || last === 0x7f) {
    return s.slice(0, -1); // `/`, `.`, a control character or a space
  }
  return s.replace(/(\.git|\.wiki)$/, "");
}

/** A local directory this origin names (path or file:// URL), else null (remote forms). */
function localDir(url: string, base?: string): string | null {
  if (/^file:/i.test(url)) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  const drive = /^[a-zA-Z]:[\\/]/.test(url);
  if (!drive && colon > 0 && (slash === -1 || colon < slash)) return null; // scp-like
  return base === undefined ? path.resolve(url) : path.resolve(base, url);
}

/** Values of `git config --get-regexp` as `[key, value]` pairs (empty when git fails). */
function gitConfigPairs(cwd: string | undefined, pattern: string): [string, string][] {
  const args = ["config", "--get-regexp", pattern];
  const r = cwd === undefined ? gitAnywhere(args) : gitTry(cwd, args);
  if (!r.ok) return [];
  const out: [string, string][] = [];
  for (const line of r.out.split("\n")) {
    const i = line.indexOf(" ");
    if (i > 0) out.push([line.slice(0, i), line.slice(i + 1)]);
  }
  return out;
}

/** `url.<base>.pushinsteadof = <prefix>`: rewrite the longest matching prefix, like git. */
function applyPushInsteadOf(url: string): string | null {
  let best: { base: string; prefix: string } | null = null;
  for (const [key, prefix] of gitConfigPairs(undefined, "^url\\..*\\.pushinsteadof$")) {
    const base = key.slice("url.".length, key.length - ".pushinsteadof".length);
    if (
      prefix !== "" &&
      url.startsWith(prefix) &&
      (best === null || prefix.length > best.prefix.length)
    ) {
      best = { base, prefix };
    }
  }
  return best === null ? null : best.base + url.slice(best.prefix.length);
}

/**
 * Every URL the git that `ctl` spawns would use for this origin string: itself, itself after
 * `url.<base>.insteadOf` (`git ls-remote --get-url`), and after `pushInsteadOf` (applied by hand,
 * longest prefix wins). A git that cannot run adds nothing: the caller still checks the string.
 * `rewritten` is true when git's URL rewriting changed the string (an alias) or could not be asked,
 * i.e. when the answer depended on git config that can change later.
 */
function resolvedUrls(url: string): { urls: string[]; rewritten: boolean } {
  const urls = [url];
  let rewritten = false;
  const r = gitAnywhere(["ls-remote", "--get-url", "--", url]);
  if (r.ok) {
    const resolved = r.out.trim();
    if (resolved !== "") urls.push(resolved);
    if (resolved !== url) rewritten = true;
  } else {
    rewritten = true;
  }
  const pushed = applyPushInsteadOf(url);
  if (pushed !== null) {
    urls.push(pushed);
    rewritten = true;
  }
  return { urls, rewritten };
}

/** Remote names of a repo: `git remote` plus the legacy `remotes/` and `branches/` files it omits. */
function remoteNames(dir: string): string[] {
  const names = new Set<string>();
  const listed = gitTry(dir, ["remote"]);
  if (listed.ok) for (const n of listed.out.split("\n")) if (n.trim() !== "") names.add(n.trim());
  const common = gitTry(dir, ["rev-parse", "--git-common-dir"]);
  if (common.ok && common.out.trim() !== "") {
    const gitDir = path.resolve(dir, common.out.trim());
    for (const sub of ["remotes", "branches"]) {
      try {
        for (const e of fs.readdirSync(path.join(gitDir, sub), { withFileTypes: true })) {
          if (e.isFile()) names.add(e.name);
        }
      } catch {
        /* no such legacy directory */
      }
    }
  }
  return [...names].filter((n) => !n.startsWith("-"));
}

/** Every URL (fetch and push, insteadOf applied by git itself) of every remote of the repo at `dir`. */
function remoteUrls(dir: string): string[] {
  const urls: string[] = [];
  for (const name of remoteNames(dir)) {
    const first = gitTry(dir, ["ls-remote", "--get-url", "--", name]);
    if (first.ok) urls.push(first.out.trim());
    for (const args of [
      ["remote", "get-url", "--all", "--", name],
      ["remote", "get-url", "--push", "--all", "--", name],
    ]) {
      const r = gitTry(dir, args);
      if (r.ok) urls.push(...r.out.split("\n").map((l) => l.trim()));
    }
  }
  return urls.filter((u) => u !== "");
}

/**
 * A local repo (path or file:// URL) with ANY remote git resolves to the product repo is refused,
 * and so is one whose remotes are local repos that do (a clone of a clone), to `MAX_LOCAL_DEPTH`.
 */
function localRepoPointsAtProduct(
  url: string,
  depth = 0,
  visited: Set<string> = new Set(),
  base?: string,
): boolean {
  const dir = localDir(url, base);
  if (dir === null) return false;
  let real: string;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    real = fs.realpathSync(dir);
  } catch {
    return false;
  }
  if (visited.has(real)) return false;
  visited.add(real);
  for (const remote of remoteUrls(dir)) {
    if (isRouteflowOrigin(remote)) return true;
    if (depth < MAX_LOCAL_DEPTH && localRepoPointsAtProduct(remote, depth + 1, visited, dir)) {
      return true;
    }
  }
  return false;
}

/**
 * Inspect an origin string. `product`: it, or anything git resolves it to, names the product repo.
 * `memoisable`: the verdict came from the string alone, so it cannot change while the process
 * lives: a REMOTE URL (not a local path or `file://`, whose repo can gain a remote) that git did not
 * rewrite (no `insteadOf` alias in play, so no git config the verdict depended on).
 */
function inspectOrigin(url: string): { product: boolean; memoisable: boolean } {
  if (isRouteflowOrigin(url)) return { product: true, memoisable: false }; // no git needed
  const { urls, rewritten } = resolvedUrls(url);
  const local = localDir(url) !== null;
  return {
    product: urls.some(isRouteflowOrigin) || localRepoPointsAtProduct(url),
    memoisable: !local && !rewritten,
  };
}

/** Trim, sanity-check and refuse the product repo; returns the origin to use. Exit 2 on refusal. */
export function assertStateOrigin(url: string): string {
  return checkStateOrigin(url).origin;
}

function checkStateOrigin(url: string): { origin: string; memoisable: boolean } {
  const t = typeof url === "string" ? url.trim() : "";
  assertOrigin(t);
  // `ext::` and `fd::` run arbitrary commands or descriptors as a transport, so no string check
  // can say where they point. They are never a state remote.
  if (/^(ext|fd)::/i.test(t)) {
    throw new CtlError(
      2,
      `refusing state remote ${redactUrl(t)}: the ext:: and fd:: transports are not allowed`,
    );
  }
  const seen = inspectOrigin(t);
  if (seen.product) {
    throw new CtlError(
      2,
      `refusing state remote ${redactUrl(t)}: the state must not live in ${FORBIDDEN} (the repo goes public during CI windows)`,
    );
  }
  return { origin: t, memoisable: seen.memoisable };
}

const verifiedOrigins = new Set<string>();

/**
 * The state-origin refusal for an origin that arrives inside an `Env` (the library's own entry
 * points call it through `checkEnv`), so no caller can skip the CLI/config validation by building
 * an `Env` by hand. It is exactly `assertStateOrigin`, plus: the string must already be the
 * trimmed one (git is handed `env.origin` verbatim). A refusal is never remembered, so every call
 * with a refused origin fails again.
 *
 * A SUCCESS is remembered per origin string for the life of the process, because the check spawns
 * offline git probes and the server calls the entry points constantly, but ONLY for a pure remote
 * URL (`https://...`, `ssh://...`, scp-like) that git did not rewrite: that verdict comes from the
 * string alone. A local path or `file://` origin (the repo behind it can gain a remote that points
 * at the product repo) and any alias that needed git's `insteadOf` resolution (the config can be
 * re-pointed) are re-inspected on every call.
 *
 * What stays unprotected: a remembered remote URL stays allowed even if an `insteadOf` rule that
 * rewrites it to the product repo is added to git config later in the same process (the git `ctl`
 * spawns would then use the rewritten URL). Such a rule needs a config edit on the host while a
 * long-lived server runs; a restart re-checks. Exit 2 on refusal.
 */
export function assertEnvOrigin(origin: string): string {
  if (verifiedOrigins.has(origin)) return origin;
  const checked = checkStateOrigin(origin);
  if (checked.origin !== origin) throw new CtlError(2, "bad origin: surrounding whitespace");
  if (checked.memoisable) verifiedOrigins.add(origin);
  return origin;
}

/** The directory holding the `origin` file: CONTROL_CONFIG_DIR, else `<XDG config>/routeflow-control`. */
export function originConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CONTROL_CONFIG_DIR;
  if (override !== undefined && override.trim() !== "") return override;
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "routeflow-control");
}

export function originConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(originConfigDir(env), "origin");
}

/** First non-empty, non-`#` line of the origin file; null when absent or empty. */
function readOriginFile(env: NodeJS.ProcessEnv): string | null {
  let text: string;
  try {
    text = fs.readFileSync(originConfigFile(env), "utf8");
  } catch {
    return null;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line !== "" && !line.startsWith("#")) return line;
  }
  return null;
}

/** `--origin` flag, then env, then the config file, else none. The result is always validated. */
export function resolveStateOrigin(
  opts: { flag?: string; env?: NodeJS.ProcessEnv } = {},
): ResolvedOrigin {
  const env = opts.env ?? process.env;
  const set = (v: string | undefined): string | null =>
    v !== undefined && v.trim() !== "" ? v.trim() : null;
  const flag = set(opts.flag);
  if (flag !== null) return { origin: assertStateOrigin(flag), source: "flag" };
  const fromEnv = set(env.CONTROL_STATE_ORIGIN);
  if (fromEnv !== null) return { origin: assertStateOrigin(fromEnv), source: "env" };
  const fromFile = readOriginFile(env);
  if (fromFile !== null) return { origin: assertStateOrigin(fromFile), source: "file" };
  return { origin: null, source: "none" };
}

/** Validate then store the origin (dir 0700, file 0600, atomic); returns the file path. */
export function writeOriginFile(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const origin = assertStateOrigin(url);
  const dir = originConfigDir(env);
  const file = originConfigFile(env);
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined) fs.chmodSync(dir, 0o700);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(
    tmp,
    `# routeflow-control: state remote, written by \`ctl origin set\`\n${origin}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

/** Remove the origin file; true when one was removed. */
export function removeOriginFile(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    fs.unlinkSync(originConfigFile(env));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CtlError(5, `cannot remove the state remote file: ${(e as Error).message}`);
  }
}
