/**
 * The Windows half of the PATH-first `git` shims (B988). On POSIX a spec drops an extensionless
 * `git` sh script first on PATH; Windows cannot run that as `git` (Node resolves `git` to `git.exe`
 * and CreateProcess needs an image), so there the same shim jobs are done by one small exe built
 * from test/helpers/git-shim.cs, configured through the environment (see that file's header).
 *
 * The exe is compiled on first use with the .NET Framework C# compiler every Windows ships
 * (`csc.exe`), cached in the OS temp dir under a hash of its source, and copied as `git.exe` into
 * each shim directory. Not imported on POSIX.
 */
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SOURCE = path.join(__dirname, "git-shim.cs");

function cscPath(): string {
  const win = process.env.SystemRoot ?? process.env.windir ?? "C:/Windows";
  for (const fw of ["Framework64", "Framework"]) {
    const p = path.join(win, "Microsoft.NET", fw, "v4.0.30319", "csc.exe");
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    "csc.exe (.NET Framework 4 C# compiler) not found; the Windows git shim needs it",
  );
}

let built: string | null = null;

/** Absolute path of the compiled shim exe (built once per machine per source version). */
export function winGitShimExe(): string {
  if (built) return built;
  const src = fs.readFileSync(SOURCE);
  const hash = crypto.createHash("sha256").update(src).digest("hex").slice(0, 12);
  const exe = path.join(os.tmpdir(), `routeflow-ctl-git-shim-${hash}.exe`);
  if (!fs.existsSync(exe)) {
    // build under a private name, then rename: two jest workers can race here, and the loser's
    // rename either fails (the winner's exe already exists, which is fine) or replaces it with
    // the identical bytes
    const tmp = `${exe}.${process.pid}.${Date.now()}.tmp.exe`;
    execFileSync(cscPath(), ["/nologo", "/optimize", "/target:exe", `/out:${tmp}`, SOURCE], {
      stdio: "pipe",
    });
    try {
      fs.renameSync(tmp, exe);
    } catch {
      fs.rmSync(tmp, { force: true });
      if (!fs.existsSync(exe)) throw new Error("could not publish the compiled git shim");
    }
  }
  built = exe;
  return exe;
}

/** Install the shim as `<dir>/git.exe`. */
export function installWinGitShim(dir: string): void {
  fs.copyFileSync(winGitShimExe(), path.join(dir, "git.exe"));
}

/** The real git every shim forwards to: the first `git.exe` on PATH (Windows analogue of `which git`). */
export function realGitWin(): string {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, "git.exe");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("git.exe not found on PATH");
}

/**
 * A `git.exe` that FAILS: with `failOn` = a subcommand (`push`) only calls carrying it fail, printing
 * `message` to stderr and exiting 1 (everything else runs the real git); `failOn` = `*` fails every
 * call without reaching the real git. Returns the env the exe reads. The POSIX twin is the inline
 * sh stub each spec writes.
 */
export function installWinFailGit(
  dir: string,
  failOn: string,
  message: string,
): Record<string, string> {
  installWinGitShim(dir);
  return { SHIM_FAIL_ON: failOn, SHIM_FAIL_MSG: message, REAL_GIT: realGitWin() };
}
