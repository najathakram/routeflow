/**
 * A PATH shim for `git` that appends every argv (one JSON array per line) to a log file, then
 * execs the real git. Lets a spec prove what did, and did not, reach a git child's command line.
 * Throwaway dir under os.tmpdir(); call `shim.cleanup()` in afterEach.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface GitShim {
  /** Directory to prepend to PATH. */
  dir: string;
  /** Every recorded argv, in call order. */
  argvs(): string[][];
  /** The raw log text (for substring checks). */
  rawLog(): string;
  cleanup(): void;
}

export function installGitShim(): GitShim {
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
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
  fs.writeFileSync(path.join(dir, "git"), script, { mode: 0o755 });
  fs.writeFileSync(log, "");
  return {
    dir,
    argvs: () =>
      fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as string[]),
    rawLog: () => fs.readFileSync(log, "utf8"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
