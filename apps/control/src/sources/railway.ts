/**
 * Railway source: which commit is live on the api and web services (A14 probe), wrapped so a
 * failure becomes `deployed: unknown` plus a source warning, with a fallback to the GitHub
 * deployments Railway posts (`deployment_status`, E45). `fetch` is injected; tokens come from
 * config and never appear in a warning.
 */

import { dig } from "../domain/prs";

export interface Deploy {
  /** Commit sha live on the service; null when the deploy carries none (CLI deploy). */
  sha: string | null;
  at: string;
}

export interface Deploys {
  api: Deploy | null;
  web: Deploy | null;
  failedShas: string[];
}

export interface DeployRead {
  state: Deploys | null;
  source: "railway" | "github" | "none";
  warnings: string[];
}

type Raw = Record<string, unknown>;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const time = (iso: unknown): number => (typeof iso === "string" ? Date.parse(iso) : NaN);
const safeMessage = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 200);

const serviceOf = (name: unknown): "api" | "web" | null => {
  const n = typeof name === "string" ? name.toLowerCase() : "";
  return n.endsWith("api") ? "api" : n.endsWith("web") ? "web" : null;
};

/** Newest `SUCCESS` per service is live; `failedShas` = commits whose deploy FAILED. */
export function normalizeDeployments(raw: unknown): Deploys {
  const edges = dig(raw, "data", "deployments", "edges");
  const live: Record<"api" | "web", { t: number; id: string; d: Deploy } | null> = {
    api: null,
    web: null,
  };
  const failed = new Set<string>();
  for (const e of Array.isArray(edges) ? (edges as unknown[]) : []) {
    const n = (dig(e, "node") ?? {}) as Raw;
    const svc = serviceOf(dig(n, "service", "name"));
    const t = time(n.createdAt);
    const hash = dig(n, "meta", "commitHash");
    const sha = typeof hash === "string" && hash !== "" ? hash : null;
    if (n.status === "FAILED" && sha) failed.add(sha);
    if (n.status !== "SUCCESS" || !svc || !Number.isFinite(t)) continue;
    const cur = live[svc];
    const id = typeof n.id === "string" ? n.id : "";
    if (!cur || t > cur.t || (t === cur.t && cmp(id, cur.id) > 0)) {
      live[svc] = { t, id, d: { sha, at: new Date(t).toISOString().replace(".000Z", "Z") } };
    }
  }
  return { api: live.api?.d ?? null, web: live.web?.d ?? null, failedShas: [...failed].sort(cmp) };
}

/**
 * Read the deploy state. A failing probe never throws: it yields a warning and (when given) the
 * GitHub-deployments fallback; with neither, `state` is null (every merged PR reads `unknown`).
 */
export async function readDeployState(
  probe: () => Promise<unknown>,
  fallback?: () => Promise<Deploys>,
): Promise<DeployRead> {
  const warnings: string[] = [];
  try {
    return { state: normalizeDeployments(await probe()), source: "railway", warnings };
  } catch (e) {
    warnings.push(`railway probe failed: ${safeMessage(e)}`);
  }
  if (fallback) {
    try {
      return { state: await fallback(), source: "github", warnings };
    } catch (e) {
      warnings.push(`github deployments fallback failed: ${safeMessage(e)}`);
    }
  }
  return { state: null, source: "none", warnings };
}

export interface RailwayConfig {
  token: string;
  projectId: string;
  environmentId?: string;
  /** Defaults to Railway's public GraphQL endpoint. */
  url?: string;
  fetch?: typeof fetch;
}

/** The A14 probe: recent deployments with service name and commit hash. Rejects on any failure. */
export function createRailwayProbe(cfg: RailwayConfig): () => Promise<unknown> {
  const doFetch = cfg.fetch ?? globalThis.fetch;
  return async () => {
    const res = await doFetch(cfg.url ?? "https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query ($input: DeploymentListInput!) {
  deployments(first: 50, input: $input) {
    edges { node { id status createdAt service { name } meta } }
  }
}`,
        variables: {
          input: {
            projectId: cfg.projectId,
            ...(cfg.environmentId ? { environmentId: cfg.environmentId } : {}),
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`railway HTTP ${res.status}`);
    const body = (await res.json()) as Raw;
    const errMsg = dig(body, "errors", 0, "message");
    if (!body.data)
      throw new Error(
        `railway: ${(typeof errMsg === "string" ? errMsg : "no data").slice(0, 120)}`,
      );
    return body;
  };
}

export interface GithubDeploymentsConfig {
  token: string;
  owner: string;
  repo: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Fallback source (E45): the GitHub deployments Railway posts. One REST list plus the newest
 * status of each of the 12 newest deployments. The service is read from the environment name
 * (an `api` / `web` suffix); deployments that name neither are ignored.
 */
export function createGithubDeployments(cfg: GithubDeploymentsConfig): () => Promise<Deploys> {
  const doFetch = cfg.fetch ?? globalThis.fetch;
  const base = `${(cfg.apiUrl ?? "https://api.github.com").replace(/\/+$/, "")}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/deployments`;
  const headers = {
    authorization: `Bearer ${cfg.token}`,
    accept: "application/vnd.github+json",
    "user-agent": "routeflow-control",
  };
  const get = async (url: string): Promise<Raw[]> => {
    const res = await doFetch(url, { method: "GET", headers });
    if (!res.ok) throw new Error(`github deployments HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as Raw[]) : [];
  };
  return async () => {
    const deployments = (await get(`${base}?per_page=12`)).slice(0, 12);
    const edges: Raw[] = [];
    for (const d of deployments) {
      const statuses = await get(`${base}/${encodeURIComponent(String(d.id))}/statuses?per_page=1`);
      const s = statuses[0];
      const status =
        s?.state === "success"
          ? "SUCCESS"
          : s?.state === "failure" || s?.state === "error"
            ? "FAILED"
            : "OTHER";
      const name = typeof d.environment === "string" ? d.environment : "";
      edges.push({
        node: {
          id: String(d.id),
          status,
          createdAt: s?.created_at ?? d.created_at,
          service: { name },
          meta: { commitHash: typeof d.sha === "string" ? d.sha : null },
        },
      });
    }
    return normalizeDeployments({ data: { deployments: { edges } } });
  };
}
