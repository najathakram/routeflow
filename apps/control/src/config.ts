/**
 * Environment -> Config. Refuses to boot (throws) naming every missing or invalid variable, never
 * echoing a value, and never defaulting a secret. `CONTROL_LOCAL=1` needs none of the secrets.
 */
export interface Config {
  local: boolean;
  host: string;
  port: number;
  password?: string;
  sessionSecret?: string;
  webhookSecret?: string;
  /** One read-only token (contents:read) for both repos and the GitHub poller. */
  githubToken?: string;
  /** `owner/name` of the product repository (PR/CI reads and the master clone). */
  repo?: string;
  /** `owner/name` of the separate state repository (the ctl/state branch). Never the product repo. */
  stateRepo?: string;
  fixtureDir?: string;
  railwayToken?: string;
  railwayProjectId?: string;
  railwayEnvironmentId?: string;
  /** Where the state-branch and master clones live (defaults under the OS temp dir). */
  stateDir?: string;
  masterDir?: string;
  /** The origin the browser sees (e.g. https://control.example); else derived from the request. */
  publicOrigin?: string;
  /**
   * The web write path (POST /api/event). Off unless CONTROL_WRITEBACK is exactly `on`: the server's
   * token is read-only, so a web save cannot reach the state repo until a state-repo-only write
   * credential exists. The CLI writes lane state directly and is unaffected.
   */
  writeback: boolean;
  /** One line each, printed at boot; never carries a value. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

export const REQUIRED_NON_LOCAL = [
  "CONTROL_PASSWORD",
  "CONTROL_SESSION_SECRET",
  "CONTROL_GITHUB_TOKEN",
  "CONTROL_REPO",
  "CONTROL_STATE_REPO",
] as const;

/** The product repo can never be the state repo: state never lives in routeflow. */
const PRODUCT_REPO = "najathakram/routeflow";
/**
 * Lower-case, then strip trailing `/`, `.`, `.git` and `.wiki` repeatedly until stable, so every
 * spelling (`Owner/Name.`, `name..git`, `name.git.`) matches.
 */
const normaliseRepo = (v: string): string => {
  let r = v.trim().toLowerCase();
  for (;;) {
    const next = r.replace(/(\/|\.git|\.wiki|\.)$/, "");
    if (next === r) return r;
    r = next;
  }
};

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const opt = (env: Env, k: string): string | undefined => {
  const v = env[k];
  return typeof v === "string" && v !== "" ? v : undefined;
};

export function loadConfig(env: Env): Config {
  const local = env.CONTROL_LOCAL === "1";
  const problems: string[] = [];
  if (!local) {
    for (const k of REQUIRED_NON_LOCAL) if (!opt(env, k)) problems.push(`${k} is required`);
  }
  const sessionSecret = opt(env, "CONTROL_SESSION_SECRET");
  if (sessionSecret !== undefined && Buffer.byteLength(sessionSecret) < 32) {
    problems.push("CONTROL_SESSION_SECRET must be at least 32 bytes");
  }
  const repo = opt(env, "CONTROL_REPO");
  if (repo !== undefined && !REPO_RE.test(repo)) problems.push("CONTROL_REPO must be owner/name");
  const stateRepo = opt(env, "CONTROL_STATE_REPO");
  if (stateRepo !== undefined) {
    if (normaliseRepo(stateRepo) === PRODUCT_REPO) {
      problems.push(
        `CONTROL_STATE_REPO must not be ${PRODUCT_REPO} (state never lives in the product repo)`,
      );
    } else if (repo !== undefined && normaliseRepo(stateRepo) === normaliseRepo(repo)) {
      problems.push(
        "CONTROL_STATE_REPO must not equal CONTROL_REPO (state never lives in the product repo)",
      );
    } else if (!REPO_RE.test(stateRepo)) {
      problems.push("CONTROL_STATE_REPO must be owner/name");
    }
  }
  const warnings: string[] = [];
  if (opt(env, "CONTROL_DEPLOY_KEY_B64") !== undefined) {
    warnings.push("control: CONTROL_DEPLOY_KEY_B64 is no longer used; remove it");
  }
  const writeback = env.CONTROL_WRITEBACK === "on"; // exact, case-sensitive: anything else is off
  if (writeback && !local && opt(env, "CONTROL_FIXTURE") === undefined) {
    warnings.push("control: CONTROL_WRITEBACK=on but the token is read-only; saves will fail");
  }
  const portRaw = opt(env, "CONTROL_PORT") ?? opt(env, "PORT");
  let port = local ? 4317 : 3000;
  if (portRaw !== undefined) {
    const n = Number(portRaw);
    if (/^\d+$/.test(portRaw) && Number.isInteger(n) && n >= 0 && n <= 65535) port = n;
    else problems.push(`${opt(env, "CONTROL_PORT") ? "CONTROL_PORT" : "PORT"} must be 0-65535`);
  }
  const publicRaw = opt(env, "CONTROL_PUBLIC_URL");
  let publicOrigin: string | undefined;
  if (publicRaw !== undefined) {
    try {
      const u = new URL(publicRaw);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
      publicOrigin = u.origin;
    } catch {
      problems.push("CONTROL_PUBLIC_URL must be an http(s) URL");
    }
  }
  if (problems.length > 0) throw new Error(`control config: ${problems.join("; ")}`);
  return {
    local,
    host: local ? "127.0.0.1" : "0.0.0.0",
    port,
    password: opt(env, "CONTROL_PASSWORD"),
    sessionSecret,
    webhookSecret: opt(env, "CONTROL_WEBHOOK_SECRET"),
    githubToken: opt(env, "CONTROL_GITHUB_TOKEN"),
    repo,
    stateRepo,
    fixtureDir: opt(env, "CONTROL_FIXTURE"),
    railwayToken: opt(env, "CONTROL_RAILWAY_TOKEN"),
    railwayProjectId: opt(env, "CONTROL_RAILWAY_PROJECT_ID"),
    railwayEnvironmentId: opt(env, "CONTROL_RAILWAY_ENVIRONMENT_ID"),
    stateDir: opt(env, "CONTROL_STATE_DIR"),
    masterDir: opt(env, "CONTROL_MASTER_DIR"),
    publicOrigin,
    writeback,
    warnings,
  };
}
