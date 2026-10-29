// mkdir-lock.mjs — the mkdir lock moved out of scripts/campaign/bugs.mjs (B1-b0), where its rules are
// written up above `lockPath`. A pure move; B1-b1 added the optional trailing `die`, `spinMs` and `label` arguments.
// `die` covers only the give-up path; owner-write faults still throw. `label` is the wording of the
// messages: today's exact strings by default (bugs.mjs output is byte-identical), a caller's own otherwise.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { uptime } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
export const BUGS_LABEL = { prefix: "bugs", holder: "another bugs.mjs process" };
const defaultDie = (m, label = BUGS_LABEL) => {
  console.error(`${label.prefix}: ${m}`);
  process.exit(1);
};

export const LOCK_SPIN_MS = 10000;
export const LOCK_STEP_MS = 20;
// Last resort ONLY, for a lockdir carrying no readable owner.json (a crash
// between the mkdir and the owner write, or a lock left by an older build).
// Deliberately far larger than any real critical section — this threshold must
// never be the thing that breaks a lock a live process is holding.
export const LOCK_ABANDON_MS = 120000;
export const ownerPath = (p) => join(p, "owner.json");
const shardOfLockPath = (p) => basename(p).replace(/\.lock$/, "");
// lock path -> the token THIS process wrote into that lockdir's owner.json.
export const heldLocks = new Map();
const lockLabels = new Map(); // p -> the label its holder gave, for the release message

const readLockOwner = (p) => {
  try {
    const o = JSON.parse(readFileSync(ownerPath(p), "utf8"));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null; // missing, half-written, or not ours to read — unknowable
  }
};

// A boot-epoch stamp: current time minus how long THIS boot has been up, so
// it is (near enough) constant across every process started on the same
// boot and DIFFERENT after a reboot — even if the OS immediately reuses the
// exact same pid. Without this, `pidAlive(owner.pid)` alone cannot tell "the
// original writer is still running" from "an unrelated process now happens
// to hold this pid", and a lockdir whose owner pid gets reused by ANY live
// process was never broken — permanently wedged, since `process.kill(pid,0)`
// answers `true` for the impostor forever. A live pid on the SAME boot is
// still unbreakable — bootAt only ever proves a NEGATIVE (this cannot be the
// same process), never used to break a lock whose boot actually matches.
export const bootStamp = () => Math.round(Date.now() - uptime() * 1000);
// A few seconds of slop for clock/measurement jitter between the stamp this
// process wrote and the one read back moments (or days) later — comfortably
// smaller than any real reboot gap, which is measured in minutes at least.
const BOOT_STAMP_SLOP_MS = 5000;

// A pid that `process.kill(pid, 0)` accepts can still be DEAD on POSIX: a child
// that exited (or was SIGKILLed) stays a ZOMBIE — pid allocated, signal 0
// accepted, no ESRCH — until its parent reaps it, and a parent blocked in a
// synchronous `sleepSync` loop never does. That is exactly what CI's ubuntu
// runner showed: the self-test's dead holder was never "gone", so its lock was
// never broken and every later case inherited it. Linux exposes the state as
// the "Z" field of /proc/<pid>/stat; treat that as gone. macOS has no /proc but
// `ps -o stat= -p <pid>` prints the same state letter (B574: without this a
// SIGKILLed, unreaped lock holder read as alive on a Mac and its lock was never
// broken); a missing/failing `ps` means "cannot tell" = keep the signal-0 answer
// (alive — the safe default). Windows has no zombie state (the pid check fails the
// moment the process ends), and any other host without /proc keeps the signal-0 answer.
const zombieProcess = (pid) => {
  if (process.platform === "darwin") {
    try {
      const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
      });
      return ps.status === 0 && ps.stdout.trim().startsWith("Z");
    } catch {
      return false;
    }
  }
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // "<pid> (<comm>) <state> …" — comm may itself contain spaces or ")", so
    // the state is the first field after the LAST ")".
    const close = stat.lastIndexOf(")");
    return close !== -1 && stat.charAt(close + 2) === "Z";
  } catch {
    return false;
  }
};

// true = alive, false = definitely gone (ESRCH, or a zombie on Linux/macOS) OR its owner
// pid predates this boot (so it cannot possibly be the process that wrote the
// lock), null = cannot tell. EPERM means the pid exists and belongs to someone
// else — alive, not free, UNLESS the boot stamp already proved it can't be ours.
export const pidAlive = (pid, ownerBootAt) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (typeof ownerBootAt === "number" && Math.abs(ownerBootAt - bootStamp()) > BOOT_STAMP_SLOP_MS)
    return false;
  try {
    process.kill(pid, 0);
    return zombieProcess(pid) ? false : true;
  } catch (e) {
    return e.code === "ESRCH" ? false : true;
  }
};
// Synchronous sleep — this whole file is synchronous by design (it is a CLI a
// hook shells out to), so a promise-based wait would need every caller to be
// async. `Atomics.wait` on the main thread is permitted in Node.
export const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
let exitHookInstalled = false;
function installLockExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [p, token] of [...heldLocks]) {
      try {
        releaseLock(p, token);
      } catch {
        /* nothing useful to do while exiting */
      }
    }
  });
  // Node's DEFAULT action for these three signals terminates the process
  // WITHOUT running `exit` listeners, so a Ctrl-C (or an orchestrator's
  // SIGTERM) mid-write left the lockdir behind and wedged the next writer.
  // Routing them through process.exit runs the hook above with the
  // conventional 128+signal status.
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    try {
      process.on(sig, () => process.exit(code));
    } catch {
      /* not every signal is listenable on every platform */
    }
  }
}

// The one lock primitive. `p` is the lock DIRECTORY, `name` the thing it
// guards as a human says it ("F01.jsonl", "bugs.jsonl"), `guarded` the file
// itself for the give-up message. The shard lock and the catalogue lock are the
// SAME mechanism deliberately: a second, hand-rolled copy for the catalogue is
// exactly how the two of them would drift apart.
export function acquireLock(p, name, guarded, die, spinMs = LOCK_SPIN_MS, label = BUGS_LABEL) {
  const giveUp = die ?? ((m) => defaultDie(m, label));
  mkdirSync(dirname(p), { recursive: true });
  const deadline = Date.now() + spinMs;
  for (;;) {
    try {
      mkdirSync(p); // NOT recursive: recursive:true succeeds on an existing dir
      installLockExitHook();
      // The owner stamp is what makes both the break and the release
      // identity-checked. Written immediately after the mkdir wins the race;
      // a waiter that reads the lockdir in that sub-millisecond window sees no
      // owner, cannot conclude anything, and simply spins again.
      const token = randomUUID();
      try {
        // TEST SEAM, gated exactly like BUGS_TEST_STALL_MS: a real disk-full
        // or permission fault here is not reproducible on demand, so the
        // self-test drives this exact path through an env var instead of a
        // hand-rolled re-implementation of the cleanup logic below.
        if (process.env.BUGS_SELF_TEST === "1" && process.env.BUGS_TEST_FAIL_OWNER_WRITE === "1")
          throw Object.assign(new Error("BUGS_TEST_FAIL_OWNER_WRITE fixture"), {
            code: "EFIXTURE",
          });
        writeFileSync(
          ownerPath(p),
          JSON.stringify({ pid: process.pid, token, at: Date.now(), bootAt: bootStamp() }),
        );
      } catch (writeErr) {
        // A crash here (disk full, a permission fault) must not leave behind
        // a lockdir with no owner stamp — that is exactly the "no readable
        // owner.json" case that wedges every later waiter for a full
        // LOCK_ABANDON_MS before it self-heals. Remove the directory THIS
        // call just created (never one it merely found already there)
        // before rethrowing — the crash itself is a real fault the caller
        // needs to see, not something to retry silently.
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          /* best effort — surfacing writeErr matters more than this cleanup */
        }
        throw writeErr;
      }
      heldLocks.set(p, token);
      lockLabels.set(p, label);
      return p;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const owner = readLockOwner(p);
    const alive = owner ? pidAlive(owner.pid, owner.bootAt) : null;
    // TEST SEAM (B598): the holder finishes and releases in the gap between the owner read above
    // and the break decision below — the window a descheduled waiter on a loaded host really hits.
    if (
      process.env.BUGS_SELF_TEST === "1" &&
      process.env.BUGS_TEST_RELEASE_AFTER_OWNER_READ === "1"
    )
      rmSync(p, { recursive: true, force: true });
    // TEST SEAM (B588): announce "I am now blocked behind a LIVE holder" exactly once, so a test
    // can release the holder only after the waiter is provably in the spin loop.
    if (process.env.BUGS_SELF_TEST === "1" && process.env.BUGS_TEST_WAIT_MARKER && alive === true) {
      try {
        writeFileSync(process.env.BUGS_TEST_WAIT_MARKER, p, { flag: "wx" });
      } catch {
        /* already announced */
      }
    }
    const bootMismatch =
      alive === false &&
      typeof owner?.bootAt === "number" &&
      Math.abs(owner.bootAt - bootStamp()) > BOOT_STAMP_SLOP_MS;
    let age = null;
    try {
      age = Date.now() - statSync(p).mtimeMs;
    } catch {
      age = null; // it vanished between the mkdir and the stat — just retry
    }
    let breakWhy = null;
    if (bootMismatch)
      breakWhy = `its owner (pid ${owner.pid}) predates this boot — it cannot possibly still be that process`;
    else if (alive === false)
      breakWhy = `its owner (pid ${owner.pid}) is gone — a writer was killed mid-write`;
    else if (alive === null && age !== null && age > LOCK_ABANDON_MS)
      breakWhy =
        `LAST RESORT: it is ${Math.round(age / 1000)}s old and carries no readable owner.json, ` +
        `so its holder cannot be verified either way`;
    // B598: `owner` was read BEFORE the pid probe, and a loaded host can deschedule this waiter
    // between the two for as long as the holder needs to finish, release and exit. The stale read
    // then convicts a lock that is already gone — or that a third writer has just taken, which the
    // rm below would rob. Break only a lockdir that STILL carries the very owner judged dead.
    if (breakWhy) {
      const now = readLockOwner(p);
      if (owner ? now?.token !== owner.token : now !== null) breakWhy = null;
    }
    if (breakWhy) {
      console.error(
        `${label.prefix}: breaking the lock on ${name} — ${breakWhy}; ` +
          `re-read the file if anything looks wrong`,
      );
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* another process won the race to break it — retry below */
      }
    }
    if (Date.now() >= deadline)
      giveUp(
        `could not lock ${guarded} within ${spinMs}ms — ${name} is held by ` +
          `${owner?.pid ? `pid ${owner.pid}, which still answers` : label.holder}. ` +
          `Retry; if nothing is running, remove ${p}` +
          // A lockdir with no readable owner.json isn't stuck forever — it is
          // exactly the LAST-RESORT case above, just not yet old enough to
          // trip it. Without this, the give-up message reads as a permanent
          // wedge needing a manual `rm`, when the honest story is "wait".
          (!owner
            ? ` — it carries no owner stamp and will be broken automatically ` +
              `once it is ${LOCK_ABANDON_MS / 1000}s old`
            : ""),
      );
    sleepSync(LOCK_STEP_MS);
  }
}

// Identity-checked. `token` defaults to whatever this process recorded for `p`;
// if the lockdir now names a DIFFERENT owner, our lock was broken while we were
// inside the critical section and the directory belongs to our successor —
// deleting it would admit a third writer, so leave it and say so out loud.
export function releaseLock(p, token = heldLocks.get(p), label = lockLabels.get(p) ?? BUGS_LABEL) {
  heldLocks.delete(p);
  lockLabels.delete(p);
  if (!existsSync(p)) return; // already gone — nothing to undo
  const owner = readLockOwner(p);
  if (!owner || !token || owner.token !== token) {
    console.error(
      `${label.prefix}: our lock on ${shardOfLockPath(p)} was broken by another process; verify the shard`,
    );
    // A stolen lock means a SECOND writer was inside the critical section
    // while this one still believed it held it exclusively — the integrity
    // of whatever this process just wrote is exactly what is now unknown.
    // Left at the default 0, a caller that shells out and branches on the
    // exit code (a hook, a CI step) read this as a clean success.
    process.exitCode = 1;
    return;
  }
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* already gone (someone broke it between the read and the rm) */
  }
}

// Re-entrant: if this process already holds `p`, `fn` runs directly and the
// OUTER hold owns the release.
export function withLock(p, name, guarded, fn, die, spinMs = LOCK_SPIN_MS, label = BUGS_LABEL) {
  if (heldLocks.has(p)) return fn();
  acquireLock(p, name, guarded, die, spinMs, label);
  try {
    return fn();
  } finally {
    releaseLock(p);
  }
}
