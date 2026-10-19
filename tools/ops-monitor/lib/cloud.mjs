// Cloud (Railway container) support: env checks, the read-only clones, secret redaction and the
// read-only exec guard. The cloud service NEVER writes git: its GitHub token is read-only, the
// specs clone is only fetched + reset to origin, and readOnlyExec() throws on anything else.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GITHUB_REPO, opsHome, specsDir, specsRemote } from "./config.mjs";
import { isWellFormedHash } from "./auth.mjs";

const SECRET_MIN_CHARS = 32;

/** Strips anything that looks like a credential. `secrets` are literal values to blank as well. */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out
    .replace(/Authorization:\s*\S+(?:[ \t]+\S+)?/gi, "Authorization: [redacted]")
    .replace(/Project-Access-Token:\s*\S+/gi, "Project-Access-Token: [redacted]")
    .replace(/x-access-token(?::[^\s@'"]*)?/gi, "[redacted]")
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[redacted]");
}

/** Where the routeflow clone lives: RF_REPO_DIR, else <opsHome>/routeflow. */
export function repoDirFor(env = process.env) {
  return env.RF_REPO_DIR ? resolve(env.RF_REPO_DIR) : join(opsHome(env), "routeflow");
}

/**
 * Startup checks. Cloud needs OPS_PASSWORD_HASH + OPS_SESSION_SECRET; a local run that sets a
 * hash also needs the secret (sessions cannot be signed without it). Never echoes a value.
 */
export function checkCloudEnv(env = process.env, { cloud = false } = {}) {
  const errors = [];
  const hash = env.OPS_PASSWORD_HASH;
  const secret = env.OPS_SESSION_SECRET;
  if (cloud && !hash) {
    errors.push(
      "OPS_PASSWORD_HASH is not set (make one with `rf hash-password`); refusing to serve the board without a login.",
    );
  } else if (hash && !isWellFormedHash(hash)) {
    errors.push(
      "OPS_PASSWORD_HASH is not a well-formed scrypt hash (expected scrypt$<salt>$<hash>).",
    );
  }
  if ((cloud || hash) && !secret) {
    errors.push("OPS_SESSION_SECRET is not set (at least 32 random bytes, hex).");
  } else if (secret && secret.length < SECRET_MIN_CHARS) {
    errors.push(`OPS_SESSION_SECRET is too short (need at least ${SECRET_MIN_CHARS} characters).`);
  }
  return { ok: errors.length === 0, errors };
}

// git subcommands the cloud service may run. Everything else (push, commit, rebase, pull, merge,
// tag, branch, ...) is refused before reaching the shell.
export const READ_ONLY_GIT = new Set([
  "fetch",
  "reset",
  "rev-parse",
  "rev-list",
  "for-each-ref",
  "diff",
  "ls-tree",
  "cat-file",
  "symbolic-ref",
  "show-ref",
  "log",
  "show",
]);

function gitSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "-C" || a === "-c") {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

/** Wraps an exec so git can only run the read-only allow-list. */
export function readOnlyExec(exec) {
  return async (cmd, args = [], opts) => {
    if (cmd === "git") {
      const sub = gitSubcommand(args);
      if (!READ_ONLY_GIT.has(sub)) {
        throw new Error(`cloud service is read-only: refused 'git ${sub ?? ""}'`.trim());
      }
    }
    return exec(cmd, args, opts);
  };
}

const basic = (token) => Buffer.from(`x-access-token:${token}`).toString("base64");

/**
 * Cloud sync of the specs clone: fetch, then reset --hard to origin's default branch. No pull,
 * no rebase, no push: the clone is read-only. Never throws.
 */
export async function cloudSyncSpecs(dir, exec) {
  const run = (args) => exec("git", args, { cwd: dir, env: { GIT_TERMINAL_PROMPT: "0" } });
  const f = await run(["fetch", "--quiet", "origin"]);
  if (f.code !== 0) {
    return {
      ok: false,
      error: redact(f.stderr || `git fetch exited ${f.code}`)
        .trim()
        .slice(0, 300),
    };
  }
  let branch = null;
  const head = await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim())
    branch = head.stdout.trim().replace(/^refs\/remotes\//, "");
  if (!branch) {
    for (const cand of ["origin/main", "origin/master"]) {
      const v = await run(["rev-parse", "--verify", "--quiet", cand]);
      if (v.code === 0) {
        branch = cand;
        break;
      }
    }
  }
  if (!branch) return { ok: false, error: "no origin/main or origin/master in the specs clone" };
  if (!branch.startsWith("origin/")) branch = `origin/${branch.split("/").pop()}`;
  const r = await run(["reset", "--hard", "--quiet", branch]);
  if (r.code !== 0)
    return {
      ok: false,
      error: redact(r.stderr || "git reset failed")
        .trim()
        .slice(0, 300),
    };
  return { ok: true, error: null };
}

/**
 * Clones (if missing) the specs repo (full) and the routeflow repo (blobless, no checkout), and
 * stores the auth header in each clone's own local config so later fetches authenticate. The
 * token is never put in a URL; it appears only in the -c header and the container's own clone
 * configs (never the user's git config, never a log: errors go through redact()).
 */
export async function cloudBoot({ env = process.env, exec } = {}) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required in cloud mode");
  const b64 = basic(token);
  const header = `Authorization: Basic ${b64}`;
  const secrets = [token, b64];
  const repoDir = repoDirFor(env);
  const specs = specsDir(env);
  const gitEnv = { GIT_TERMINAL_PROMPT: "0" };

  const ensure = async (dir, url, extra) => {
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(dirname(dir), { recursive: true });
      const r = await exec(
        "git",
        ["-c", `http.extraHeader=${header}`, "clone", "--quiet", ...extra, url, dir],
        { cwd: dirname(dir), env: gitEnv, timeoutMs: 300000 },
      );
      if (r.code !== 0) {
        throw new Error(
          `git clone ${url} failed: ${redact(r.stderr || r.stdout, secrets)
            .trim()
            .slice(0, 300)}`,
        );
      }
    }
    // Stored in the container's own clone so fetches authenticate without the token in a URL.
    const c = await exec(
      "git",
      ["config", "--local", "http.https://github.com/.extraheader", header],
      {
        cwd: dir,
        env: gitEnv,
      },
    );
    if (c.code !== 0) {
      throw new Error(
        `git config failed in ${dir}: ${redact(c.stderr, secrets).trim().slice(0, 200)}`,
      );
    }
  };

  await ensure(specs, specsRemote(env), []);
  await ensure(repoDir, `https://github.com/${GITHUB_REPO}.git`, [
    "--filter=blob:none",
    "--no-checkout",
  ]);
  return { repoDir, specsDir: specs };
}
