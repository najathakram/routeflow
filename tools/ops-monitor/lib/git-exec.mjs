// The ONE way the ops monitor runs git. Three guarantees, each born from a production leak (the
// cloud container ran out of processes: "cannot fork()", "spawn git EAGAIN"):
//   1. a timeout that kills the WHOLE process group (git-remote-https and lazy-fetch children
//      included), so a hung fetch cannot pin PIDs forever;
//   2. a global concurrency limiter (default 2) shared by every source;
//   3. a non-interactive environment (no credential prompt can ever block a child).
// runGit REJECTS on timeout / spawn failure (err.code GIT_TIMEOUT | GIT_SPAWN); store.exec turns
// that into a normal {code, stderr} result so callers keep their never-throws contract.
import { spawn as nodeSpawn, spawnSync } from "node:child_process";

export const DEFAULT_GIT_TIMEOUT_MS = 120000;
export const DEFAULT_GIT_CONCURRENCY = 2;
const MAX_BUFFER = 64 * 1024 * 1024;
const WIN = process.platform === "win32";

export const gitTimeoutMs = (env = process.env) => {
  const n = Number(env.OPS_GIT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GIT_TIMEOUT_MS;
};

/** FIFO concurrency limiter. warn() fires once per backlog episode when waiting > warnAt. */
export function createLimiter(max, { warnAt = 8, warn = () => {} } = {}) {
  const queue = [];
  let active = 0;
  let warned = false;
  const next = () => {
    while (active < max && queue.length) {
      active++;
      const job = queue.shift();
      job();
    }
    if (!queue.length) warned = false;
  };
  return {
    max,
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push(() => {
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        });
        if (queue.length > warnAt && !warned) {
          warned = true;
          warn(`git backlog: ${active} running, ${queue.length} waiting (limit ${max})`);
        }
        next();
      });
    },
  };
}

function limitFromEnv(env = process.env) {
  const n = Number(env.OPS_GIT_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_GIT_CONCURRENCY;
}

export const gitLimiter = createLimiter(limitFromEnv(), {
  warn: (m) => console.warn(`[ops-monitor] ${m}`),
});

function killTree(child) {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (WIN) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Runs `git args` (or opts.cmd, a test hook) once. Resolves {code, stdout, stderr}; ENOENT
 * resolves code 127. Rejects on timeout or a spawn failure such as EAGAIN/ENOMEM.
 */
export function runGit(args, { cwd, env, input, timeoutMs, cmd = "git", spawn = nodeSpawn } = {}) {
  const limit = timeoutMs ?? gitTimeoutMs();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...(env ?? {}), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
        detached: !WIN, // own process group on POSIX so the timeout can kill the whole tree
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(spawnError(e));
    }
    const out = [];
    const err = [];
    let size = 0;
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      killTree(child);
      done(
        reject,
        Object.assign(new Error(`git timed out after ${limit}ms`), { code: "GIT_TIMEOUT" }),
      );
    }, limit);
    const take = (bucket) => (d) => {
      size += d.length;
      if (size > MAX_BUFFER) {
        killTree(child);
        return done(
          reject,
          Object.assign(new Error("git output too large"), { code: "GIT_SPAWN" }),
        );
      }
      bucket.push(d);
    };
    child.stdout?.on("data", take(out));
    child.stderr?.on("data", take(err));
    child.on("error", (e) => {
      if (e?.code === "ENOENT") {
        return done(resolve, { code: 127, stdout: "", stderr: String(e.message) });
      }
      done(reject, spawnError(e));
    });
    child.on("close", (code) =>
      done(resolve, {
        code: typeof code === "number" ? code : 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function spawnError(e) {
  return Object.assign(new Error(`git spawn failed: ${e?.code ?? e?.message ?? "unknown"}`), {
    code: "GIT_SPAWN",
  });
}

/** The shared path: limiter + runGit. Used by store.exec for every `git` invocation. */
export const limitedGit = (args, opts) => gitLimiter.run(() => runGit(args, opts));
