// registry-write.mjs — the register's ONE write transaction (B1-b1, SPEC v3.2 "Ruling v3").
//
//   withRegistryWrite(fn, opts)  lock -> origin check -> dirty guard -> fetch + reset -> fn -> commit
//                                explicit paths -> push; a rejected push resets and redoes fn, up to
//                                REGISTRY_PUSH_RETRIES times. The dirty guard runs before EVERY reset
//                                (each retry, the give-up): after our own commit the tree is clean, so
//                                anything dirty is a hand edit and is kept (exit 2), never reset. If
//                                fn, add or commit throws after writing, the clone is left as is (exit
//                                2); if fn threw before writing anything, its own error comes back.
//                                Returns { result, attempts, pushed } only after the push landed, so a
//                                caller prints an id after it.
//
// fn({ cloneDir, root, attempt, dirty }) does the read-modify-write and returns { paths, result };
// `paths` are the clone-relative files to commit (never `add -A`); an empty list means "nothing to
// write" (an idempotent re-run) and is refused (exit 2) if the tree under the prefix is dirty anyway.
// The clone, the git plumbing and the lock live in registry-clone.mjs. Inert while REGISTRY_MODE is
// "tracked": nothing calls this.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY_FIX_COMMAND } from "./registry-root.mjs";
import {
  CLONE_DEFAULTS,
  DIRTY_MESSAGE,
  RegistryError,
  checkOrigin,
  dirtyPaths,
  firstLine,
  guardClean,
  locked,
  refusal,
  registryGit,
  reset,
  settings,
  toOrigin,
} from "./registry-clone.mjs";

export { RegistryError };
export const WRITE_DEFAULTS = CLONE_DEFAULTS;

export const needClone = (c) => {
  if (!existsSync(join(c.cloneDir, ".git")))
    throw new RegistryError(
      `register clone not found at ${c.cloneDir} — run \`${REGISTRY_FIX_COMMAND}\``,
      2,
    );
};

// opts.capture(c) runs under the lock right after the first dirty guard (commit-record saves its hand
// edit there, so a refused clone leaves no capture). opts.allowDirty exempts those paths from that
// FIRST guard only: after the capture the edit lives in the saved copy, so every later guard treats
// the same path as someone else's edit. allowDirty without capture is refused.
export function withRegistryWrite(fn, opts = {}) {
  const { capture, allowDirty, ...rest } = opts;
  const c = settings(rest);
  needClone(c);
  if (allowDirty && !capture) throw new Error("withRegistryWrite: allowDirty needs a capture");
  return locked(c, () => {
    checkOrigin(c);
    guardClean({ ...c, allowDirty });
    capture?.(c);
    let inFlight = false; // fn has run and its edits are not committed yet: the dirt is ours
    try {
      let last = "";
      for (let attempt = 0; attempt <= c.retries; attempt++) {
        if (attempt > 0) guardClean(c, last); // the push window is open to hand edits
        try {
          toOrigin(c);
        } catch (e) {
          last = e.message;
          continue;
        }
        const root = join(c.cloneDir, c.prefix);
        inFlight = true;
        const out = fn({ cloneDir: c.cloneDir, root, attempt, dirty: () => dirtyPaths(c) }) ?? {};
        const paths = out.paths ?? [];
        const done = {
          result: out.result,
          attempts: attempt + 1,
          pushed: false,
        };
        if (!paths.length) {
          const stray = dirtyPaths(c);
          if (stray.length)
            throw refusal(
              `not recorded: the write changed ${stray.join(", ")} but named no paths to commit; ` +
                `the clone was left as is — ${DIRTY_MESSAGE}`,
            );
          return done;
        }
        registryGit(c, ["add", "--", ...paths]);
        const same = registryGit(c, ["diff", "--cached", "--quiet", "--", ...paths], { ok: true });
        if (same.status === 0) return done; // fn changed nothing
        const named = registryGit(c, ["config", "user.email"], {
          ok: true,
        }).stdout;
        const who = named
          ? []
          : ["-c", "user.name=registry", "-c", "user.email=registry@localhost"];
        registryGit(c, [...who, "commit", "-m", `registry: ${c.label}`, "--", ...paths]);
        inFlight = false;
        c.hooks?.beforePush?.(attempt, c);
        const push = registryGit(c, ["push", "origin", `HEAD:refs/heads/${c.branch}`], {
          ok: true,
        });
        if (push.status === 0) return { ...done, pushed: true };
        last =
          push.stderr
            .split("\n")
            .find((l) => /^\s*!/.test(l))
            ?.trim() ?? firstLine(push.stderr);
      }
      throw new RegistryError(
        `not recorded: no push landed in ${c.retries + 1} attempts (${last})`,
      );
    } catch (e) {
      if (e.keepClone) throw e;
      // Mid-write (fn, add or commit threw), our own edits and a hand edit cannot be told apart, so
      // nothing is reset: the next write's dirty guard refuses the clone until someone looks.
      if (inFlight) {
        // Nothing written: the clone is as fetched and the error is fn's own, so it is not masked.
        if (!dirtyPaths(c).length) throw e;
        throw new RegistryError(
          `not recorded: the write failed mid-transaction (${e.message}); the clone was left as is ` +
            `so no hand edit is lost — inspect ${c.cloneDir}, then commit or discard it`,
          2,
        );
      }
      guardClean(c, e.message); // anything dirty now is not ours: keep it
      reset(c);
      throw e;
    }
  });
}
