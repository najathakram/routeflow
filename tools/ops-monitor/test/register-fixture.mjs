// A minimal product repo whose origin/master carries a register, so register reads succeed
// (loadBugIds fails closed when there is no register to read).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registryDir } from "../lib/registry.mjs";

export function makeRegisterRepo(dir) {
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, registryDir(), "bugs"), { recursive: true });
  g("init", "-q", "-b", "master");
  g("config", "user.name", "Fixture");
  g("config", "user.email", "fixture@example.com");
  writeFileSync(join(dir, registryDir(), "bugs", "B1.md"), "# B1\n");
  g("add", "-A");
  g("commit", "-q", "-m", "register");
  g("update-ref", "refs/remotes/origin/master", "HEAD");
  return dir;
}
