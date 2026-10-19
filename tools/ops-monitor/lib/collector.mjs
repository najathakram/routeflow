// Collector: polls the derived-fact sources (specs clone, GitHub, git branches, bug registry,
// file tree, Railway) and keeps the last good data per source. All IO goes through an injected
// exec(cmd, args, opts) → Promise<{code, stdout, stderr}>. Parsers are pure and exported.
import { fileToArea, areaDomain, buildAreaTree, guessDomainFromText } from "./areas.mjs";
import { GITHUB_REPO } from "./config.mjs";
import { cloudSyncSpecs, readOnlyExec, redact } from "./cloud.mjs";

export const DEFAULT_INTERVALS = {
  specs: 30,
  github: 60,
  branches: 120,
  bugs: 120,
  areas: 300,
  railway: 120,
};
// Cloud: webhooks make it real time; the polls are the backstop.
export const CLOUD_INTERVALS = {
  github: 120,
  specs: 120,
  branches: 300,
  bugs: 300,
  areas: 600,
  railway: 300,
};
export const BRANCH_DIFF_CAP = 30;
export const FETCH_EVERY = 5;
const BUGS_DIR = ".claude/campaign/bugs";
const CLOSED_STATES = new Set([
  "done",
  "already-fixed",
  "refuted",
  "closed",
  "fixed",
  "duplicate",
  "wontfix",
]);
const DAY = 86400_000;

const [OWNER, REPO] = GITHUB_REPO.split("/");
export const GRAPHQL_QUERY = `query {
  repository(owner: "${OWNER}", name: "${REPO}") {
    visibility
    open: pullRequests(states: OPEN, first: 60, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title isDraft headRefName headRefOid baseRefName updatedAt url
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        files(first: 100) { nodes { path } } }
    }
    merged: pullRequests(states: MERGED, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title headRefName mergedAt url baseRefName mergeCommit { oid } }
    }
    master: ref(qualifiedName: "refs/heads/master") {
      target { ... on Commit { oid committedDate messageHeadline statusCheckRollup { state } } }
    }
    deployments(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { environment commitOid createdAt latestStatus { state createdAt } }
    }
  }
}`;

// ---------- pure parsers ----------

/** gh graphql JSON → { visibility, open, merged, master }. */
export function parsePrGraphql(json) {
  const repo = json?.data?.repository ?? json?.repository ?? {};
  const open = (repo.open?.nodes ?? []).filter(Boolean).map((n) => ({
    number: n.number,
    title: n.title,
    draft: Boolean(n.isDraft),
    branch: n.headRefName,
    headSha: n.headRefOid ?? null,
    base: n.baseRefName ?? null,
    updatedAt: n.updatedAt ?? null,
    url: n.url ?? null,
    checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    files: (n.files?.nodes ?? []).map((f) => f?.path).filter(Boolean),
  }));
  const merged = (repo.merged?.nodes ?? []).filter(Boolean).map((n) => ({
    number: n.number,
    title: n.title,
    branch: n.headRefName,
    mergedAt: n.mergedAt ?? null,
    mergeSha: n.mergeCommit?.oid ?? null,
    url: n.url ?? null,
    base: n.baseRefName ?? null,
  }));
  const t = repo.master?.target;
  const master = t
    ? {
        sha: t.oid,
        date: t.committedDate ?? null,
        headline: t.messageHeadline ?? "",
        checks: t.statusCheckRollup?.state ?? null,
      }
    : null;
  return {
    visibility: repo.visibility ?? null,
    open,
    merged,
    master,
    deploys: parseGithubDeployments(repo.deployments?.nodes),
  };
}

/**
 * GitHub deployment nodes (newest first) → one entry per service, source 'github'. The service is
 * the `@routeflow/<x>` in the environment name when present, else the environment itself.
 */
export function parseGithubDeployments(nodes) {
  const out = [];
  const seen = new Set();
  for (const n of nodes ?? []) {
    if (!n || typeof n.environment !== "string") continue;
    const service = /@routeflow\/[\w.-]+/.exec(n.environment)?.[0] ?? n.environment;
    if (seen.has(service)) continue;
    seen.add(service);
    out.push({
      service,
      status: n.latestStatus?.state ?? null,
      sha: n.commitOid ?? null,
      createdAt: n.latestStatus?.createdAt ?? n.createdAt ?? null,
      source: "github",
    });
  }
  return out;
}

/** GitHub + Railway deploy rows → one per service; Railway's status wins, GitHub's is kept. */
export function mergeDeploys(githubDeploys, railwayDeploys) {
  const gh = githubDeploys ?? [];
  const rw = railwayDeploys ?? [];
  const rwNames = new Set(rw.map((d) => d.service));
  const out = rw.map((r) => {
    const g = gh.find((x) => x.service === r.service);
    return g
      ? { ...r, github: { status: g.status, sha: g.sha, createdAt: g.createdAt } }
      : { ...r };
  });
  for (const g of gh) if (!rwNames.has(g.service)) out.push(g);
  return out;
}

/** `refname<TAB>sha<TAB>iso-date` lines → [{ branch, sha, date }] (origin/ stripped; HEAD/master dropped). */
export function parseForEachRef(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, sha, date] = line.split("\t");
    if (!ref || !sha) continue;
    if (!ref.startsWith("origin/")) continue;
    const branch = ref.slice("origin/".length);
    if (branch === "HEAD" || branch === "master" || !branch) continue;
    out.push({ branch, sha, date: date ? new Date(date).toISOString() : null });
  }
  return out;
}

/** Registry bug markdown → fields; YAML-ish `key: value` lines between the first two `---`. */
export function parseBugFrontMatter(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const kv = {};
  let i = lines.findIndex((l) => l.trim() === "---");
  if (i >= 0) {
    for (i += 1; i < lines.length && lines[i].trim() !== "---"; i++) {
      const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(lines[i]);
      if (m) kv[m[1]] = m[2].trim();
    }
  }
  return {
    id: kv.id ?? "",
    title: kv.title ?? "",
    severity: kv.severity ?? "",
    state: kv.state ?? "",
    sensitive: /^true$/i.test(kv.sensitive ?? ""),
    files: (kv.files ?? "").split(/\s+/).filter(Boolean),
    location: kv.location ?? "",
    closed: kv.closed ?? "",
  };
}

export function isOpenBug(b) {
  if (b.closed && String(b.closed).trim()) return false;
  const first = String(b.state ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
  return !CLOSED_STATES.has(first);
}

export const SENSITIVE_TITLE = "Security hardening item (details machine-local)";

/** Public-safe bug row; sensitive bugs lose title, area and files. */
export function maskBug(b, area) {
  if (b.sensitive) {
    return {
      id: b.id,
      title: SENSITIVE_TITLE,
      severity: b.severity,
      state: b.state,
      area: null,
      domain: null,
      sensitive: true,
    };
  }
  const a = area ?? (b.files?.length ? fileToArea(b.files[0]).area : null);
  const domain = a ? areaDomain(a) : (guessDomainFromText(b.title) ?? "other");
  return {
    id: b.id,
    title: b.title,
    severity: b.severity,
    state: b.state,
    area: a,
    domain,
    sensitive: false,
  };
}

/** `git cat-file --batch` output (Buffer or string) → [{ sha, content }]; missing objects skipped. */
export function parseCatFileBatch(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""), "utf8");
  const out = [];
  let pos = 0;
  while (pos < b.length) {
    const nl = b.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = b.toString("utf8", pos, nl).trim();
    pos = nl + 1;
    if (!header) continue;
    const m = /^(\S+) blob (\d+)$/.exec(header);
    if (!m) continue;
    const size = Number(m[2]);
    out.push({ sha: m[1], content: b.toString("utf8", pos, pos + size) });
    pos += size + 1;
  }
  return out;
}

/** `railway status --json` → production @routeflow/* service deploys. */
export function parseRailwayStatus(json) {
  const root = json?.data ?? json ?? {};
  const envs = (root.environments?.edges ?? []).map((e) => e?.node).filter(Boolean);
  const prod = envs.find((e) => e.name === "production");
  if (!prod) return [];
  const out = [];
  for (const edge of prod.serviceInstances?.edges ?? []) {
    const n = edge?.node;
    if (!n || typeof n.serviceName !== "string" || !n.serviceName.startsWith("@routeflow/"))
      continue;
    const d = n.latestDeployment ?? {};
    out.push({
      service: n.serviceName,
      status: d.status ?? null,
      sha: d.meta?.commitHash ?? null,
      createdAt: d.createdAt ?? null,
    });
  }
  return out;
}

// ---------- Railway API (read-only) ----------

// EVERY Railway GraphQL document lives here. The token is a project token for another project's
// production environment: queries only, never a mutation.
export const RAILWAY_QUERIES = {
  projectToken: "query { projectToken { projectId environmentId } }",
  project:
    "query ($id: String!) { project(id: $id) { services { edges { node { name serviceInstances { edges { node { environmentId latestDeployment { status createdAt meta } } } } } } } } }",
};
export const RAILWAY_URL = "https://backboard.railway.com/graphql/v2";

/** The single Railway request function: refuses anything that is not a plain query. */
export async function railwayRequest({ fetch: fetchFn = globalThis.fetch, token, doc, variables }) {
  if (
    typeof doc !== "string" ||
    !/^\s*query\b/.test(doc) ||
    /\b(mutation|subscription)\b/i.test(doc)
  ) {
    throw new Error("Railway access is read-only: only query documents are allowed");
  }
  const res = await fetchFn(RAILWAY_URL, {
    method: "POST",
    headers: { "Project-Access-Token": token, "content-type": "application/json" },
    body: JSON.stringify({ query: doc, ...(variables ? { variables } : {}) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Railway API ${res.status}: ${redact(text, [token]).slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Railway API returned invalid JSON");
  }
  if (json.errors?.length && !json.data) {
    throw new Error(
      `Railway API: ${redact(json.errors[0]?.message ?? "error", [token]).slice(0, 200)}`,
    );
  }
  return json.data ?? {};
}

/** project(id) services → same rows as parseRailwayStatus, for the token's environment. */
export function parseRailwayProject(json, environmentId) {
  const root = json?.data ?? json ?? {};
  const out = [];
  for (const edge of root.project?.services?.edges ?? []) {
    const svc = edge?.node;
    if (!svc || typeof svc.name !== "string" || !svc.name.startsWith("@routeflow/")) continue;
    const inst = (svc.serviceInstances?.edges ?? [])
      .map((e) => e?.node)
      .find((n) => n && n.environmentId === environmentId);
    if (!inst) continue;
    const d = inst.latestDeployment ?? {};
    out.push({
      service: svc.name,
      status: d.status ?? null,
      sha: d.meta?.commitHash ?? null,
      createdAt: d.createdAt ?? null,
    });
  }
  return out;
}

// ---------- collector ----------

async function defaultExec(cmd, args, opts) {
  const store = await import("./store.mjs");
  return store.exec(cmd, args, opts);
}

export function createCollector({
  repoRoot,
  specsDir,
  exec = defaultExec,
  now = Date.now,
  intervals = {},
  onUpdate = () => {},
  log = () => {},
  env = process.env,
  deps = {},
  cloud = false,
  fetch: fetchFn = globalThis.fetch,
} = {}) {
  // Cloud never writes git: every git call goes through the read-only allow-list.
  const guardedExec = cloud ? readOnlyExec(exec) : exec;
  exec = guardedExec;
  const fetchEvery = cloud ? 1 : FETCH_EVERY;
  const iv = { ...DEFAULT_INTERVALS, ...(cloud ? CLOUD_INTERVALS : {}), ...intervals };
  const sources = {};
  for (const name of Object.keys(DEFAULT_INTERVALS)) {
    sources[name] = {
      ok: false,
      at: null,
      tried: null,
      error: null,
      data: null,
      intervalSec: iv[name],
    };
  }
  const running = new Map();
  const timers = [];
  const runCounts = {};
  const diffCache = new Map(); // sha → files
  const bugBlobCache = new Map(); // blob sha → parsed bug
  let bugsTree = null;
  let areasSha = null;

  const git = (args) => exec("git", args, { cwd: repoRoot });
  const fail = (msg) => {
    throw new Error(msg);
  };

  const runners = {
    async specs() {
      const store = deps.store ?? (await import("./store.mjs"));
      const cfg = deps.config ?? (await import("./config.mjs"));
      if (cloud) {
        // Read-only clone made at boot: fetch + reset to origin, never pull --rebase or push.
        const r = await (deps.cloudSyncSpecs ?? cloudSyncSpecs)(specsDir, exec);
        if (!r.ok) fail(r.error);
      } else {
        if (store.ensureClone) {
          await store.ensureClone({
            dir: specsDir,
            remote: cfg.specsRemote ? cfg.specsRemote() : undefined,
          });
        }
        await store.syncSpecs(specsDir);
      }
      const events = await store.readAllEvents(specsDir);
      const config = (deps.loadConfig ?? cfg.loadConfig)(specsDir);
      return { events, config };
    },

    async github() {
      const token = env.GITHUB_TOKEN;
      let json;
      if (token) {
        let res;
        try {
          res = await fetchFn("https://api.github.com/graphql", {
            method: "POST",
            headers: {
              authorization: `bearer ${token}`,
              "content-type": "application/json",
              "user-agent": "routeflow-ops-monitor",
            },
            body: JSON.stringify({ query: GRAPHQL_QUERY }),
            signal: AbortSignal.timeout(30000),
          });
        } catch (e) {
          fail(`github API request failed: ${redact(e?.message ?? e, [token]).slice(0, 200)}`);
        }
        const text = await res.text();
        if (!res.ok) fail(`github API ${res.status}: ${redact(text, [token]).slice(0, 200)}`);
        try {
          json = JSON.parse(text);
        } catch {
          fail("github API returned invalid JSON");
        }
        if (json.errors?.length && !json.data) {
          fail(
            `github graphql: ${redact(json.errors[0].message ?? "error", [token]).slice(0, 200)}`,
          );
        }
        return parsePrGraphql(json);
      }
      const r = await exec("gh", ["api", "graphql", "-f", `query=${GRAPHQL_QUERY}`], {
        cwd: repoRoot,
      });
      if (r.code !== 0)
        fail(`gh failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      try {
        json = JSON.parse(r.stdout);
      } catch {
        fail("gh returned invalid JSON");
      }
      if (json.errors?.length && !json.data)
        fail(`gh graphql: ${json.errors[0].message ?? "error"}`);
      return parsePrGraphql(json);
    },

    async branches() {
      const n = (runCounts.branches ?? 1) - 1;
      let fetchError = null;
      if (n % fetchEvery === 0 && env.RF_OPS_LIGHT !== "1") {
        const f = await git(["fetch", "origin", "--quiet"]);
        if (f.code !== 0) fetchError = (f.stderr || "fetch failed").trim().slice(0, 200);
      }
      const r = await git([
        "for-each-ref",
        "refs/remotes/origin",
        "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)",
      ]);
      if (r.code !== 0) fail(`git for-each-ref failed: ${r.stderr.trim().slice(0, 200)}`);
      const t = now();
      const mergedByBranch = new Map();
      for (const p of sources.github.data?.merged ?? [])
        mergedByBranch.set(p.branch, Date.parse(p.mergedAt));
      const recent = parseForEachRef(r.stdout).filter((b) => {
        const d = Date.parse(b.date);
        if (Number.isNaN(d) || t - d > 14 * DAY) return false;
        const mergedAt = mergedByBranch.get(b.branch);
        return !(mergedAt !== undefined && d <= mergedAt);
      });
      let diffs = 0;
      const out = [];
      for (const b of recent) {
        let files = diffCache.get(b.sha);
        if (!files && diffs < BRANCH_DIFF_CAP) {
          diffs += 1;
          const d = await git(["diff", "--name-only", `origin/master...${b.sha}`]);
          if (d.code === 0) {
            files = d.stdout.split(/\r?\n/).filter(Boolean);
            diffCache.set(b.sha, files);
          }
        }
        out.push({ ...b, files: files ?? [] });
      }
      return { branches: out, fetchError };
    },

    async bugs() {
      const tree = await git(["rev-parse", `origin/master:${BUGS_DIR}`]);
      if (tree.code !== 0)
        fail(`bug registry not found on origin/master: ${tree.stderr.trim().slice(0, 200)}`);
      const treeSha = tree.stdout.trim();
      if (treeSha === bugsTree && sources.bugs.data) return sources.bugs.data;
      const ls = await git(["ls-tree", "origin/master", `${BUGS_DIR}/`]);
      if (ls.code !== 0) fail(`git ls-tree failed: ${ls.stderr.trim().slice(0, 200)}`);
      const entries = [];
      for (const line of ls.stdout.split(/\r?\n/)) {
        const m = /^\d+ blob ([0-9a-f]{7,40})\t(.+)$/.exec(line);
        if (m && /(^|\/)B\d+[^/]*\.md$/.test(m[2])) entries.push({ sha: m[1], path: m[2] });
      }
      const need = [...new Set(entries.map((e) => e.sha))].filter((s) => !bugBlobCache.has(s));
      if (need.length) {
        // One batched read when exec supports stdin (opts.input); otherwise (or if it returned
        // nothing) fall back to one `git cat-file blob` per unseen blob, 8 at a time.
        const r = await exec("git", ["cat-file", "--batch"], {
          cwd: repoRoot,
          input: `${need.join("\n")}\n`,
        });
        if (r.code === 0) {
          for (const { sha, content } of parseCatFileBatch(r.stdout)) {
            bugBlobCache.set(sha, parseBugFrontMatter(content));
          }
        }
        const left = need.filter((s) => !bugBlobCache.has(s));
        for (let i = 0; i < left.length; i += 8) {
          await Promise.all(
            left.slice(i, i + 8).map(async (sha) => {
              const one = await git(["cat-file", "blob", sha]);
              if (one.code === 0) bugBlobCache.set(sha, parseBugFrontMatter(one.stdout));
            }),
          );
        }
        if (left.length && left.every((s) => !bugBlobCache.has(s)))
          fail("git cat-file returned no bug files");
      }
      const all = [];
      for (const e of entries) {
        const b = bugBlobCache.get(e.sha);
        if (!b) continue;
        const id = b.id || (/(B\d+)/.exec(e.path)?.[1] ?? "");
        if (id) all.push({ ...b, id });
      }
      bugsTree = treeSha;
      // Raw sensitive rows never leave this function: everything downstream sees masked bugs.
      const masked = all.map((b) => ({ ...maskBug(b), open: isOpenBug(b) }));
      return { treeSha, bugs: masked, open: masked.filter((b) => b.open) };
    },

    async areas() {
      const head = await git(["rev-parse", "origin/master"]);
      if (head.code !== 0) fail(`git rev-parse failed: ${head.stderr.trim().slice(0, 200)}`);
      const sha = head.stdout.trim();
      if (sha === areasSha && sources.areas.data) return sources.areas.data;
      const r = await git([
        "ls-tree",
        "-r",
        "--name-only",
        "origin/master",
        "--",
        "apps",
        "packages",
        "scripts",
        "tools",
        ".claude",
        ".github",
        "docs",
      ]);
      if (r.code !== 0) fail(`git ls-tree failed: ${r.stderr.trim().slice(0, 200)}`);
      const paths = r.stdout.split(/\r?\n/).filter(Boolean);
      areasSha = sha;
      return { sha, fileCount: paths.length, tree: buildAreaTree(paths) };
    },

    async railway() {
      const rwToken = env.RAILWAY_API_TOKEN;
      if (rwToken) {
        try {
          const t = await railwayRequest({
            fetch: fetchFn,
            token: rwToken,
            doc: RAILWAY_QUERIES.projectToken,
          });
          const { projectId, environmentId } = t.projectToken ?? {};
          if (!projectId || !environmentId) fail("Railway token has no project/environment");
          const p = await railwayRequest({
            fetch: fetchFn,
            token: rwToken,
            doc: RAILWAY_QUERIES.project,
            variables: { id: projectId },
          });
          return {
            deploys: parseRailwayProject({ data: p }, environmentId).map((d) => ({
              ...d,
              source: "railway",
            })),
          };
        } catch (e) {
          fail(redact(e?.message ?? e, [rwToken]).slice(0, 300));
        }
      }
      // On Windows the npm-installed CLI is railway.cmd, which Node only runs through cmd.exe
      // (fixed arguments, no user input on the command line).
      const [rwCmd, rwArgs] =
        process.platform === "win32"
          ? ["cmd.exe", ["/d", "/s", "/c", "railway", "status", "--json"]]
          : ["railway", ["status", "--json"]];
      const r = await exec(rwCmd, rwArgs, { cwd: repoRoot });
      if (
        r.code === 127 ||
        /is not recognized as an internal or external command/i.test(r.stderr || "")
      )
        fail("railway CLI unavailable");
      if (r.code !== 0)
        fail(`railway failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      let json;
      try {
        json = JSON.parse(r.stdout);
      } catch {
        fail("railway returned invalid JSON");
      }
      return { deploys: parseRailwayStatus(json).map((d) => ({ ...d, source: "railway" })) };
    },
  };

  function runOnce(name) {
    if (!runners[name]) return Promise.reject(new Error(`unknown source ${name}`));
    if (running.has(name)) return running.get(name);
    const p = (async () => {
      const s = sources[name];
      s.tried = now();
      runCounts[name] = (runCounts[name] ?? 0) + 1;
      try {
        s.data = await runners[name]();
        s.ok = true;
        s.at = now();
        s.error = null;
      } catch (e) {
        s.ok = false;
        s.error = String(e?.message ?? e);
        log(`source ${name} failed: ${s.error}`);
      }
      try {
        onUpdate(name);
      } catch (e) {
        log(`onUpdate(${name}) threw: ${e?.message ?? e}`);
      }
      return s;
    })().finally(() => running.delete(name));
    running.set(name, p);
    return p;
  }

  return {
    sources,
    guardedExec,
    runOnce,
    start() {
      for (const name of Object.keys(runners)) {
        runOnce(name).catch(() => {});
        const t = setInterval(() => runOnce(name).catch(() => {}), iv[name] * 1000);
        t.unref?.();
        timers.push(t);
      }
    },
    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
    },
  };
}
