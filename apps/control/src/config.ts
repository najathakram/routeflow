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
  githubToken?: string;
  deployKeyB64?: string;
  /** `owner/name` of the GitHub repository. */
  repo?: string;
  fixtureDir?: string;
  railwayToken?: string;
  railwayProjectId?: string;
  railwayEnvironmentId?: string;
  /** Where the state-branch and master clones live (defaults under the OS temp dir). */
  stateDir?: string;
  masterDir?: string;
  /** The origin the browser sees (e.g. https://control.example); else derived from the request. */
  publicOrigin?: string;
}

type Env = Record<string, string | undefined>;

export const REQUIRED_NON_LOCAL = [
  "CONTROL_PASSWORD",
  "CONTROL_SESSION_SECRET",
  "CONTROL_GITHUB_TOKEN",
  "CONTROL_DEPLOY_KEY_B64",
  "CONTROL_REPO",
] as const;

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
    deployKeyB64: opt(env, "CONTROL_DEPLOY_KEY_B64"),
    repo,
    fixtureDir: opt(env, "CONTROL_FIXTURE"),
    railwayToken: opt(env, "CONTROL_RAILWAY_TOKEN"),
    railwayProjectId: opt(env, "CONTROL_RAILWAY_PROJECT_ID"),
    railwayEnvironmentId: opt(env, "CONTROL_RAILWAY_ENVIRONMENT_ID"),
    stateDir: opt(env, "CONTROL_STATE_DIR"),
    masterDir: opt(env, "CONTROL_MASTER_DIR"),
    publicOrigin,
  };
}
