/**
 * A `git` shim for specs: a sh script first on PATH that logs every invocation, then runs the
 * real git. It proves "no git call happened" (empty log) and "no force push" (argv inspection),
 * and can create `ctl/state` on a bare origin the moment a `push` starts (a lost race).
 * Everything stays under the world's temp root; nothing here touches the network.
 */
import * as fs from "fs";
import * as path from "path";
import { IS_WIN, realGitPath } from "./platform";
import type { World } from "./temp-repo";

export interface GitShim {
  /** Env to pass to `runCli` (PATH first, plus the log and race switches). */
  env: Record<string, string>;
  /** Every git argv line the CLI ran, in order. */
  calls(): string[];
}

/**
 * The read-only, offline git calls `ctl` makes to resolve an origin (insteadOf / pushInsteadOf and
 * the remotes of a local repo). They never touch a network, so "no git call" specs filter them.
 */
const OFFLINE_PROBE_RE =
  /^(ls-remote --get-url |config (--local )?--get-regexp |remote$|remote get-url |rev-parse --git-common-dir$)/;

/** Every recorded git call except the offline origin-resolution probes. */
export const withoutOriginProbes = (calls: string[]): string[] =>
  calls.filter((c) => !OFFLINE_PROBE_RE.test(c));

export function makeGitShim(world: World, opts: { raceOriginDir?: string } = {}): GitShim {
  const dir = path.join(world.root, "shim-bin");
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(world.root, "shim.log");
  fs.writeFileSync(log, "");
  const realGit = realGitPath();
  const script = [
    "#!/bin/sh",
    'printf \'%s\\n\' "$*" >> "$SHIM_LOG"',
    'if [ -n "$SHIM_RACE_DIR" ]; then',
    '  for a in "$@"; do',
    '    if [ "$a" = push ] && [ ! -e "$SHIM_RACE_DIR.raced" ]; then',
    '      : > "$SHIM_RACE_DIR.raced"',
    '      t=$("$REAL_GIT" -C "$SHIM_RACE_DIR" hash-object -t tree -w --stdin </dev/null)',
    '      c=$("$REAL_GIT" -C "$SHIM_RACE_DIR" commit-tree -m race "$t")',
    '      "$REAL_GIT" -C "$SHIM_RACE_DIR" update-ref refs/heads/ctl/state "$c"',
    "    fi",
    "  done",
    "fi",
    'exec "$REAL_GIT" "$@"',
    "",
  ].join("\n");
  // POSIX: the sh script above. Windows cannot run an extensionless script as `git`, so the same
  // log / race jobs are done by test/helpers/git-shim.cs (built to git.exe, driven by the env below).
  if (IS_WIN) require("./win-git-shim").installWinGitShim(dir);
  else fs.writeFileSync(path.join(dir, "git"), script, { mode: 0o755 });
  const env: Record<string, string> = {
    PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
    SHIM_LOG: log,
    REAL_GIT: realGit,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: ["test", "example.invalid"].join("@"),
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: ["test", "example.invalid"].join("@"),
  };
  if (opts.raceOriginDir) env.SHIM_RACE_DIR = opts.raceOriginDir;
  return {
    env,
    calls: () =>
      fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== ""),
  };
}
