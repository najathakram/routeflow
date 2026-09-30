# Cause brief — `e2e` job's "Skip superseded deployments" step always skips

Evidence gathering only (bug-pipeline S1). No root-cause judgment, no fix proposals below —
raw facts and verbatim tool output only. Main checkout is on `fix/imp-02-order-merge-advisory-lock`;
all workflow evidence is read from `origin/master` (fetched fresh at the start of this run) via
`git show origin/master:.github/workflows/ci.yml`, saved locally at
`<scratchpad>/bug-e2e-freshness-guard/ci-master.yml` (657 lines).

---

## 1. Report (owner's text, verbatim)

> the guard's bash; `gh api "repos/$GITHUB_REPOSITORY/deployments?per_page=1" --jq '.[0].sha'`
> returns a 403 body `{"message":"Resource not accessible by integration",…}`; `$latest` is
> non-empty so the fail-open branch never runs; every deployment_status E2E run is skipped as
> "superseded"; observed on runs 33885520334 (master `f60bd27c`, 2026-09-04) and 33755924684
> (`e39bf9db`, 2026-09-03) and all runs back to 2026-09-02T15:19; `default_workflow_permissions: read`.

---

## 2. The code path (full `e2e` job, `origin/master:.github/workflows/ci.yml`)

### `on:` triggers (lines 68–111)

```yaml
on:
  pull_request:
    branches: [master]
    types: [opened, synchronize, reopened, ready_for_review]
    paths-ignore:
      - "**.md"
      - ".claude/**"
      - "docs/**"
      - ".vscode/**"
      - "local-assets/**"
      - "LICENSE"

  deployment_status:

  repository_dispatch:
    types: [railway-deploy]

  workflow_dispatch:
```

There is **no `push:` trigger** (deliberately removed 2026-08-30 per the file's own header comment,
lines 54–63).

### `permissions:` — none declared anywhere in the file

A repo-wide grep of the saved `ci-master.yml` for `permissions` returns exactly one hit, and it is
inside a comment, not a live key:

```
310:  #      Contents:read + Metadata:read + "Repository dispatch"(write) permissions.
```

No `permissions:` block exists at workflow level or at either job (`verify`, `e2e`). The `GH_TOKEN`
used by the guard step is `${{ github.token }}` (line 383) — the default `GITHUB_TOKEN` — so its
effective scopes come entirely from the repo's `default_workflow_permissions` setting (see §5).

### Concurrency (lines 113–125, workflow-level; 357–359, job-level)

```yaml
concurrency:
  group: ci-${{ github.event.deployment.sha || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Job-level, inside `e2e`:

```yaml
concurrency:
  group: ci-e2e-${{ github.event.deployment.sha || github.sha }}
  cancel-in-progress: true
```

### `e2e` job header and `if:` (lines 336–346)

```yaml
e2e:
  name: E2E (Playwright)
  runs-on: ubuntu-latest
  timeout-minutes: 45
  if: >
    (github.event_name == 'deployment_status' && github.event.deployment_status.state == 'success') ||
    github.event_name == 'repository_dispatch' ||
    github.event_name == 'workflow_dispatch'
```

### The guard step, complete `run:` block, with line numbers (lines 380–415)

```
380	      - name: Skip superseded deployments
381	        id: freshness
382	        env:
383	          GH_TOKEN: ${{ github.token }}
384	          EVENT_NAME: ${{ github.event_name }}
385	          DEPLOY_SHA: ${{ github.event.deployment.sha }}
386	        run: |
387	          set -uo pipefail
388
389	          if [ "$EVENT_NAME" != "deployment_status" ]; then
390	            echo "run=true" >> "$GITHUB_OUTPUT"
391	            echo "$EVENT_NAME run — the freshness guard only applies to deployment_status."
392	            exit 0
393	          fi
394
395	          # Compare against the newest DEPLOYMENT, deliberately not the branch
396	          # tip: commits outside Railway's watchPatterns (docs/, root files)
397	          # produce NO deployment at all, so tip-comparison would make the real
398	          # deploy's success look stale whenever such a commit lands inside the
399	          # deploy window — and E2E would silently never run for either commit.
400	          # "Is this deployment still the newest one" is the question; the
401	          # deployments API answers exactly that.
402	          latest=$(gh api "repos/$GITHUB_REPOSITORY/deployments?per_page=1" --jq '.[0].sha' 2>/dev/null || true)
403	          if [ -z "$latest" ]; then
404	            echo "::warning::Could not read the newest deployment — proceeding rather than skipping, so a GitHub API blip cannot silently cancel E2E coverage."
405	            echo "run=true" >> "$GITHUB_OUTPUT"
406	            exit 0
407	          fi
408
409	          if [ "$DEPLOY_SHA" = "$latest" ]; then
410	            echo "run=true" >> "$GITHUB_OUTPUT"
411	            echo "Deployment $DEPLOY_SHA is still the newest deployment — running the suite."
412	          else
413	            echo "run=false" >> "$GITHUB_OUTPUT"
414	            echo "::notice::Skipping — this success is for $DEPLOY_SHA but the newest deployment is $latest. Railway re-posts success on the previous deployment when a new one goes live; the newer deployment has its own run."
415	          fi
416
417	      - uses: actions/checkout@v7
```

### `if:` conditions of every later step keying on `steps.freshness.outputs.run` (line numbers)

```
418	        if: steps.freshness.outputs.run == 'true'     # actions/checkout@v7
431	        if: steps.freshness.outputs.run == 'true'     # actions/setup-node@v7
437	        if: steps.freshness.outputs.run == 'true'     # Install dependencies
448	        if: steps.freshness.outputs.run == 'true'     # Install Playwright browsers
479	        if: steps.freshness.outputs.run == 'true'     # Wait for the deployed app to match this commit
635	        if: steps.freshness.outputs.run == 'true'     # Run Playwright tests
651	        if: failure() && steps.freshness.outputs.run == 'true'   # Upload Playwright report
```

Every step after the guard is gated on the same single output.

### The readiness-gate block that follows (lines 452–632, "Wait for the deployed app to match this commit")

Full step, condensed to its structural shape (env + control flow; verbatim text preserved for the
parts that matter to this bug — the guard never lets execution reach here in the observed runs):

```
478	      - name: Wait for the deployed app to match this commit
479	        if: steps.freshness.outputs.run == 'true'
480	        env:
481	          API_BASE: ${{ secrets.SMOKE_BASE_URL || 'https://routeflowapi-production.up.railway.app' }}
482	          WEB_BASE: ${{ secrets.PLAYWRIGHT_BASE_URL || 'https://routeflowweb-production.up.railway.app' }}
483	          EXPECTED_SHA: ${{ github.event.deployment.sha || github.sha }}
484	          REQUIRE_SHA: ${{ github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/master' }}
485	          WAIT_SECONDS: "900"
```

followed by a 30-attempt reachability-only wait when `REQUIRE_SHA != "true"` (lines 514–531), then
a SHA-matching poll loop against `apps/web/app/api/health`'s reported `sha` (lines 533–632) that
either exits 0 (exact match, or a match modulo files outside `apps/web`/`packages`) or errors out
after `WAIT_SECONDS` (900s). None of this runs in the observed failures — it is entirely skipped by
the `if:` on line 479, same as every other post-guard step.

---

## 3. Repro evidence from CI

### `gh run list --workflow ci.yml --event deployment_status --limit 6 --json databaseId,headSha,conclusion,createdAt`

```json
[
  {
    "conclusion": "success",
    "createdAt": "2026-09-04T14:44:55Z",
    "databaseId": 33885520334,
    "headSha": "f60bd27c893bc0b1058d6dcdfff8180cdd92b42d"
  },
  {
    "conclusion": "skipped",
    "createdAt": "2026-09-04T14:44:36Z",
    "databaseId": 33885490053,
    "headSha": "f60bd27c893bc0b1058d6dcdfff8180cdd92b42d"
  },
  {
    "conclusion": "success",
    "createdAt": "2026-09-04T14:43:28Z",
    "databaseId": 33885383450,
    "headSha": "d07697016bff73e6335e112ae87881ff6e2509c7"
  },
  {
    "conclusion": "skipped",
    "createdAt": "2026-09-04T14:43:24Z",
    "databaseId": 33885376092,
    "headSha": "f60bd27c893bc0b1058d6dcdfff8180cdd92b42d"
  },
  {
    "conclusion": "skipped",
    "createdAt": "2026-09-04T14:41:41Z",
    "databaseId": 33885211796,
    "headSha": "f60bd27c893bc0b1058d6dcdfff8180cdd92b42d"
  },
  {
    "conclusion": "success",
    "createdAt": "2026-09-03T12:33:47Z",
    "databaseId": 33755924684,
    "headSha": "e39bf9db69cbeb3c334b09a82331b0f2dcbade82"
  }
]
```

The two most recent runs beyond the two owner-named targets are 33885490053 and 33885383450 —
used below as "the two most recent other runs".

### `gh run view <id> --json jobs --jq '.jobs[] | select(.name=="E2E (Playwright)") | {conclusion, steps: [.steps[] | {name, conclusion}]}'`

**Run 33885520334** (target, master `f60bd27c`):

```json
{
  "conclusion": "success",
  "steps": [
    { "conclusion": "success", "name": "Set up job" },
    { "conclusion": "success", "name": "Skip superseded deployments" },
    { "conclusion": "skipped", "name": "Run actions/checkout@v7" },
    { "conclusion": "skipped", "name": "Run actions/setup-node@v7" },
    { "conclusion": "skipped", "name": "Install dependencies" },
    { "conclusion": "skipped", "name": "Install Playwright browsers" },
    { "conclusion": "skipped", "name": "Wait for the deployed app to match this commit" },
    { "conclusion": "skipped", "name": "Run Playwright tests" },
    { "conclusion": "skipped", "name": "Upload Playwright report" },
    { "conclusion": "success", "name": "Complete job" }
  ]
}
```

**Run 33755924684** (target, master `e39bf9db`):

```json
{
  "conclusion": "success",
  "steps": [
    { "conclusion": "success", "name": "Set up job" },
    { "conclusion": "success", "name": "Skip superseded deployments" },
    { "conclusion": "skipped", "name": "Run actions/checkout@v7" },
    { "conclusion": "skipped", "name": "Run actions/setup-node@v7" },
    { "conclusion": "skipped", "name": "Install dependencies" },
    { "conclusion": "skipped", "name": "Install Playwright browsers" },
    { "conclusion": "skipped", "name": "Wait for the deployed app to match this commit" },
    { "conclusion": "skipped", "name": "Run Playwright tests" },
    { "conclusion": "skipped", "name": "Upload Playwright report" },
    { "conclusion": "success", "name": "Complete job" }
  ]
}
```

**Run 33885383450** (other, master `d0769701`):

```json
{
  "conclusion": "success",
  "steps": [
    { "conclusion": "success", "name": "Set up job" },
    { "conclusion": "success", "name": "Skip superseded deployments" },
    { "conclusion": "skipped", "name": "Run actions/checkout@v7" },
    { "conclusion": "skipped", "name": "Run actions/setup-node@v7" },
    { "conclusion": "skipped", "name": "Install dependencies" },
    { "conclusion": "skipped", "name": "Install Playwright browsers" },
    { "conclusion": "skipped", "name": "Wait for the deployed app to match this commit" },
    { "conclusion": "skipped", "name": "Run Playwright tests" },
    { "conclusion": "skipped", "name": "Upload Playwright report" },
    { "conclusion": "success", "name": "Complete job" }
  ]
}
```

**Run 33885490053** (other): the `E2E (Playwright)` job itself has `"conclusion":"skipped","steps":[]`
— the guard step never started (the job's own `if:` on lines 343–346 or the `cancel-in-progress: true`
concurrency group at lines 357–359 prevented it; no step-level log to inspect). Full job listing for
this run (`gh run view 33885490053 --json jobs,event,conclusion,displayTitle`):

```json
{
  "conclusion": "skipped",
  "displayTitle": "CI",
  "event": "deployment_status",
  "jobs": [
    {
      "completedAt": "2026-09-04T14:44:36Z",
      "conclusion": "skipped",
      "databaseId": 101064108360,
      "name": "E2E (Playwright)",
      "startedAt": "2026-09-04T14:44:37Z",
      "status": "completed",
      "steps": [],
      "url": "https://github.com/najathakram/routeflow/actions/runs/33885490053/job/101064108360"
    },
    {
      "completedAt": "2026-09-04T14:44:36Z",
      "conclusion": "skipped",
      "databaseId": 101064145333,
      "name": "Verify",
      "startedAt": "2026-09-04T14:44:44Z",
      "status": "completed",
      "steps": [],
      "url": "https://github.com/najathakram/routeflow/actions/runs/33885490053/job/101064145333"
    }
  ]
}
```

This is a distinct empty-job "skipped" from the in-job guard "skip" seen in the other three runs
— noted, not diagnosed.

### Guard-step log lines (`gh run view <id> --log --job=<e2e job id>`, grepped for `Resource not accessible`, `::notice::`, `::warning::`, `run=`)

Job IDs used: 33885520334 → job 101064207362; 33755924684 → job 100650201771; 33885383450 → job 101063752601.

**Run 33885520334**, guard step env + result:

```
E2E (Playwright)	Skip superseded deployments	2026-09-04T14:45:01.5766319Z   EVENT_NAME: deployment_status
E2E (Playwright)	Skip superseded deployments	2026-09-04T14:45:01.5766925Z   DEPLOY_SHA: f60bd27c893bc0b1058d6dcdfff8180cdd92b42d
E2E (Playwright)	Skip superseded deployments	2026-09-04T14:45:02.0589303Z ##[notice]Skipping — this success is for f60bd27c893bc0b1058d6dcdfff8180cdd92b42d but the newest deployment is {"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/deployments/deployments#list-deployments","status":"403"}. Railway re-posts success on the previous deployment when a new one goes live; the newer deployment has its own run.
```

**Run 33755924684**, guard step result:

```
E2E (Playwright)	UNKNOWN STEP	2026-09-03T12:33:55.3120582Z ##[notice]Skipping — this success is for e39bf9db69cbeb3c334b09a82331b0f2dcbade82 but the newest deployment is {"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/deployments/deployments#list-deployments","status":"403"}. Railway re-posts success on the previous deployment when a new one goes live; the newer deployment has its own run.
```

(Step name renders as "UNKNOWN STEP" in this run's raw log dump — same job, same step id `freshness`, only formatting differs from the other two.)

**Run 33885383450**, guard step env + result:

```
E2E (Playwright)	Skip superseded deployments	2026-09-04T14:43:35.2953830Z   EVENT_NAME: deployment_status
E2E (Playwright)	Skip superseded deployments	2026-09-04T14:43:35.2954431Z   DEPLOY_SHA: d07697016bff73e6335e112ae87881ff6e2509c7
E2E (Playwright)	Skip superseded deployments	2026-09-04T14:43:35.7990369Z ##[notice]Skipping — this success is for d07697016bff73e6335e112ae87881ff6e2509c7 but the newest deployment is {"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/deployments/deployments#list-deployments","status":"403"}. Railway re-posts success on the previous deployment when a new one goes live; the newer deployment has its own run.
```

In all three runs with a live guard step, `$latest` printed as the literal JSON error body
`{"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/deployments/deployments#list-deployments","status":"403"}`
(non-empty), and no `::warning::Could not read the newest deployment` line appears in any of the
three logs (that branch requires `$latest` to be empty — see line 403–406 above).

---

## 4. What `--jq` does with an error object

Local machine has no standalone `jq` binary on `PATH` (`which jq` → "no jq in (...)"). The guard
uses `gh api ...--jq`, which is `gh`'s own bundled jq-compatible filter (gojq), not the external
binary, so this does not block reproducing the `gh api` call itself.

### `gh api` reproduction from this machine, with the user's own token (NOT `GITHUB_TOKEN`)

```
$ gh api "repos/najathakram/routeflow/deployments?per_page=1" --jq '.[0].sha'
f60bd27c893bc0b1058d6dcdfff8180cdd92b42d
EXIT=0
```

`gh auth status` on this machine:

```
github.com
  ✓ Logged in to github.com account najathakram (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'user', 'workflow'
```

This is an OAuth token (`gho_…`) with the `repo` scope — a different credential from the Actions
runner's `GITHUB_TOKEN`, which the guard step sets via `GH_TOKEN: ${{ github.token }}` (line 383)
and which draws its permissions from the repo's `default_workflow_permissions` setting (§5), not
from any user's personal scopes. The same endpoint that 403s inside every CI run above returns the
sha cleanly (exit 0) when called with this machine's token.

### `gh api --help` / `gh help exit-codes` (excerpts)

```
$ gh api --help
...
FLAGS
...
  -q, --jq string             Query to select values from the response using jq syntax
...
```

```
$ gh help exit-codes
gh follows normal conventions regarding exit codes.

- If a command completes successfully, the exit code will be 0
- If a command fails for any reason, the exit code will be 1
- If a command is running but gets cancelled, the exit code will be 2
- If a command requires authentication, the exit code will be 4

NOTE: It is possible that a particular command may have more exit codes, so it is a good
practice to check documentation for the command if you are relying on exit codes to
control some behavior.
```

The guard's `latest=$(gh api ... --jq '.[0].sha' 2>/dev/null || true)` (line 402) redirects only
stderr to `/dev/null` and appends `|| true`, so a non-zero `gh api` exit is swallowed — but whatever
`gh api` wrote to **stdout** before/instead of erroring is still captured into `$latest` by the
command substitution. The CI logs in §3 show that stdout content was the full JSON error body, not
an empty string.

---

## 5. Token permissions

### `gh api repos/najathakram/routeflow/actions/permissions/workflow`

```
$ gh api repos/najathakram/routeflow/actions/permissions/workflow
{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
EXIT=0
```

Matches the owner's report verbatim (`default_workflow_permissions: read`).

### GitHub REST docs statement on the permission `GET /repos/{owner}/{repo}/deployments` needs

Fetched from `https://docs.github.com/en/rest/overview/permissions-required-for-github-apps?apiVersion=2022-11-28#deployments`
("Repository permissions for 'Deployments'" table): the row for
`GET /repos/{owner}/{repo}/deployments` lists permission **"Deployments"** at access level
**"read"**, tokens `UAT, IAT`, no additional permissions required.

(An initial fetch of `https://docs.github.com/en/rest/deployments/deployments` — the endpoint's own
reference page rather than the GitHub-Apps permissions-matrix page — did not surface an explicit
permission statement for the _list_ operation specifically; it only documents that **Create a
deployment** needs the `repo` or `repo_deployment` OAuth scope. The permissions-matrix page above is
the one that names "Deployments: read" for the list endpoint.)

### Every occurrence of `permissions:` in `ci.yml`

Already covered in §2: exactly one match in the whole file, and it is prose inside a comment, not a
YAML key:

```
310:  #      Contents:read + Metadata:read + "Repository dispatch"(write) permissions.
```

No `permissions:` block exists at the workflow level or on either job (`verify`, `e2e`).

---

## 6. History

### `git log --oneline -8 -- .github/workflows/ci.yml` (from `origin/master`)

```
f60bd27c fix(api): customer-keyed advisory lock for order merges (imp-02) + wave D (#609)
7e5c2d98 ci(campaign): F00 — CI diet, deploy-signal E2E, and the burn-down campaign's machinery (#545)
a545a10d fix(ci): gate E2E on the deployed web build; de-flake BOXED-01 (#500)
96826793 feat(ci): bug-signature scan — gate new instances of historically-buggy code shapes (#493)
ecfd8efb ci(deps): validate every lockfile dependency edge — pre-install CI gate + verify step (#490)
87ae7ea5 ci(deps): install from the lockfile everywhere — npm ci in CI and Docker (#488)
0a46bbb5 chore(deps): bump actions/checkout from 4 to 7 (#476)
2d0270fd chore(deps): bump actions/setup-node from 4 to 7 (#460)
```

### `git log -S "Skip superseded deployments" --oneline -- .github/workflows/ci.yml`

```
7e5c2d98 ci(campaign): F00 — CI diet, deploy-signal E2E, and the burn-down campaign's machinery (#545)
```

Commit date: `2026-08-30T20:34:52-05:00` (`git show -s --format='%H %ad %s' --date=iso-strict 7e5c2d98`).
This is the only commit that has ever touched the string "Skip superseded deployments" in this
file — i.e. the guard was introduced whole in PR #545 and has not been edited since.

### `git blame -L 380,415 origin/master -- .github/workflows/ci.yml`

Every line of the guard step (380–415, matching the block quoted in §2) blames to the single commit
`7e5c2d981` (`najathakram`, `2026-08-30 20:34:52 -0500`). No line has been touched by a later commit.

---

## 7. Existing tests around the workflow

Grepped `apps/api/src/common` and `scripts` for specs referencing `.github/workflows`, `ci.yml`,
`docs-truth`, `no-runtime-ddl`, `freshness guard`, `Skip superseded`, `deployment_status`:

- `apps/api/src/common/docs-truth.spec.ts` — the only spec matching. It reads `README.md` and
  `CLAUDE.md` as plain text (`readFileSync`) and asserts substrings against them; it never reads
  `.github/workflows/ci.yml`. The one relevant assertion:

  ```ts
  it("documents the deployment_status-triggered E2E flow", () => {
    expect(readme).toContain("deployment_status");
  });
  ```

  This only proves the word "deployment_status" appears somewhere in `README.md` — it asserts
  nothing about the guard's logic, the `permissions:` configuration, or actual E2E execution.

- `apps/api/src/common/no-runtime-ddl.spec.ts` — matched only because its own filename string
  ("no-runtime-ddl") appears inside itself (a tmpdir prefix, line 169); it does not reference
  `ci.yml` or the workflows directory at all.

- `scripts/validate-lock-edges.mjs` — the one hit for `ci.yml` under `scripts/`, but it is a code
  comment about keeping a `semver` version pin in sync with `ci.yml`'s lock-integrity job; unrelated
  to the `e2e` job or the freshness guard.

No spec anywhere in the repo asserts on the `e2e` job's `if:` conditions, the guard step's
behavior, the workflow's `permissions:`, or the token's actual access to the deployments endpoint.

---

## 8. Related lessons

### L-041 (verbatim, `.claude/lessons/LESSONS.md`, "process" category)

> ### L-041 · 2026-09-01 · process
>
> - **Symptom:** 13 rows sat in `proven` — merged, deployed, post-deploy run already green — while
>   every scoreboard counted them outstanding. Then the run cited as their proof turned out to have
>   executed **nothing**.
> - **Root cause:** two failures stacked. The proof fires off the deploy signal and lands after the
>   session that merged the fix has ended, so the flip to `done` belongs to nobody. And the run
>   everyone pointed at (a superseded deployment) reported conclusion **success with every real step
>   `skipped`** — a green job that ran zero tests.
> - **Lesson:** **When the evidence authorizing a state change arrives asynchronously, assign the
>   flip — and when you read that evidence, read the STEP conclusions, never the job's.** A job is
>   green when it is skipped, and a suite is green when a test is skipped; neither says your proof ran.
> - **Guard:** `gh run view <id> --json jobs` — assert the specific step is `success`, not
>   `skipped`; for one test, grep the log for its `✓`. Step COUNT is not execution.

No other entry in `LESSONS.md` or `ARCHIVE.md` mentions `deployment_status` or "skipped" in a way
related to this guard (grepped both files for `deployment_status`, `skipped`, `superseded`; the only
other hits are unrelated domain/tooling entries — L-032's multer upload skip, L-029/L-030/L-045's
"skipped stop" order-lifecycle entries — none about CI workflow runs).
