/** mkdir-atomic lock with a pid file, a heartbeat, stale reclaim and release on exit/SIGINT. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { CtlError } from "./git";

/** Locks we hold: dir -> the token we wrote, so release never removes somebody else's lock. */
const held = new Map<string, string>();
let installed = false;

const tokenOf = (dir: string): string | null => {
  try {
    return fs.readFileSync(path.join(dir, "token"), "utf8").trim();
  } catch {
    return null;
  }
};

/** Remove `dir` only while it still carries our token (B may have taken over a lock we lost). */
function releaseIfOurs(dir: string, token: string): void {
  if (tokenOf(dir) !== token) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function releaseAll(): void {
  for (const [d, token] of held) releaseIfOurs(d, token);
  held.clear();
}

/** Clear a lock by hand (recycled pid, hung holder). The CLI's `unlock` calls this. */
export function forceUnlock(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function onSigint(): void {
  releaseAll();
  uninstall();
  process.kill(process.pid, "SIGINT");
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on("exit", releaseAll);
  process.on("SIGINT", onSigint);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  process.removeListener("exit", releaseAll);
  process.removeListener("SIGINT", onSigint);
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ageMs(p: string): number | null {
  try {
    return Date.now() - fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** True when the lock's recorded holder is a live process on THIS host (never steal it). */
function holderAlive(dir: string): boolean {
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, "pid"), "utf8");
  } catch {
    return false;
  }
  const [pidText, host] = text.trim().split(/\s+/, 2);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || host !== os.hostname()) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Move a stale lock dir aside atomically; put it back if we raced a fresh holder. */
function reclaim(dir: string, staleMs: number): void {
  const aside = `${dir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(dir, aside);
  } catch {
    return; // someone else reclaimed or released it
  }
  const age = ageMs(aside);
  if (age !== null && age <= staleMs) {
    try {
      fs.renameSync(aside, dir); // we grabbed a live lock by mistake: restore it
      return;
    } catch {
      /* a newer lock exists; fall through and drop ours */
    }
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

/** Run fn holding the lock at `dir`. Waits up to staleMs + 5 s, then throws CtlError(5). */
export async function withLock<T>(
  dir: string,
  staleMs: number,
  fn: () => Promise<T> | T,
): Promise<T> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + staleMs + 5_000;
  let delay = 10;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
    }
    const age = ageMs(dir);
    // A live same-host holder is never displaced, however old the lock looks; a recycled pid is
    // cleared by hand (forceUnlock). Only a dead or remote holder's stale lock is reclaimed.
    if (age !== null && age > staleMs && !holderAlive(dir)) {
      reclaim(dir, staleMs);
      continue;
    }
    if (Date.now() > deadline) throw new CtlError(5, `lock busy: ${dir}`);
    await sleepMs(delay);
    delay = Math.min(delay * 2, 100);
  }
  const token = randomBytes(16).toString("hex");
  held.set(dir, token);
  install();
  const beat = setInterval(
    () => {
      const t = new Date();
      try {
        if (tokenOf(dir) === token) fs.utimesSync(dir, t, t);
      } catch {
        /* lock dir gone */
      }
    },
    Math.max(1_000, Math.floor(staleMs / 4)),
  );
  beat.unref();
  try {
    fs.writeFileSync(path.join(dir, "token"), token + "\n");
    fs.writeFileSync(path.join(dir, "pid"), `${process.pid} ${os.hostname()}\n`);
    return await fn();
  } finally {
    clearInterval(beat);
    held.delete(dir);
    releaseIfOurs(dir, token);
    if (held.size === 0) uninstall();
  }
}
