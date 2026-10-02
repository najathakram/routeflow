/**
 * A PATH shim for `git` that appends every argv (one JSON array per line) to a log file, then
 * execs the real git. Lets a spec prove what did, and did not, reach a git child's command line.
 * Throwaway dir under os.tmpdir(); call `shim.cleanup()` in afterEach.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IS_WIN, realGitPath, rmTree } from "./platform";

export interface GitShim {
  /** Directory to prepend to PATH. */
  dir: string;
  /** Env the shim needs (empty on POSIX, where the log path is baked into the script). Merge into the child env. */
  env: Record<string, string>;
  /** Every recorded argv, in call order. */
  argvs(): string[][];
  /** The raw log text (for substring checks). */
  rawLog(): string;
  cleanup(): void;
}

export function installGitShim(): GitShim {
  const real = realGitPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-shim-"));
  const log = path.join(dir, "argv.log");
  const script = [
    "#!/bin/sh",
    `log='${log}'`,
    'line="["',
    "first=1",
    'for a in "$@"; do',
    "  esc=$(printf '%s' \"$a\" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g')",
    '  if [ $first = 1 ]; then first=0; else line="$line,"; fi',
    '  line="$line\\"$esc\\""',
    "done",
    'printf \'%s]\\n\' "$line" >> "$log"',
    `exec '${real}' "$@"`,
    "",
  ].join("\n");
  if (IS_WIN) require("./win-git-shim").installWinGitShim(dir);
  else fs.writeFileSync(path.join(dir, "git"), script, { mode: 0o755 });
  fs.writeFileSync(log, "");
  return {
    dir,
    env: IS_WIN ? { SHIM_ARGV_LOG: log, REAL_GIT: real } : {},
    argvs: () =>
      fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as string[]),
    rawLog: () => fs.readFileSync(log, "utf8"),
    cleanup: () => rmTree(dir),
  };
}
