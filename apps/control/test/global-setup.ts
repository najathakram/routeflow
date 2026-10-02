/**
 * Jest globalSetup: compile the server ONCE per run into `.dist-global-<pid>` (inside apps/control,
 * covered by the .gitignore pattern for .dist- dirs) and publish it as `CONTROL_TEST_DIST`, which every worker
 * inherits. Specs that spawn the compiled server or CLI reuse it (helpers/build-dist.ts,
 * helpers/spawn-cli.ts) instead of each paying for a private `tsc` build; the CI runner is shared
 * with every other workspace's tests, so three full compiles per run was real, avoidable load.
 *
 * A dir left by a killed run is swept here when its pid is gone; the teardown removes ours, also
 * when tests failed.
 */
import * as fs from "fs";
import * as path from "path";
import { GLOBAL_DIST_PREFIX, compileDist } from "./helpers/build-dist";

const CONTROL = path.join(__dirname, "..");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sweepStale(): void {
  for (const name of fs.readdirSync(CONTROL)) {
    const m = new RegExp(`^${GLOBAL_DIST_PREFIX.replace(".", "\\.")}(\\d+)$`).exec(name);
    if (m && !alive(Number(m[1]))) {
      fs.rmSync(path.join(CONTROL, name), { recursive: true, force: true });
    }
  }
}

export default async function globalSetup(): Promise<void> {
  sweepStale();
  const dir = path.join(CONTROL, `${GLOBAL_DIST_PREFIX}${process.pid}`);
  compileDist(dir); // removes its own half-built dir on failure (jest skips the teardown then)
  process.env.CONTROL_TEST_DIST = dir;
  // Git for Windows ships `core.autocrlf=true` in its SYSTEM gitconfig, so every checkout a spec makes
  // would hand the code under test CRLF files (a nonce row then ends in a carriage return and
  // Date.parse of it is NaN). The fixtures are byte-exact LF; the system config is irrelevant to
  // offline fixture repos.
  if (process.platform === "win32") process.env.GIT_CONFIG_NOSYSTEM = "1";
}
