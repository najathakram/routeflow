# Self-hosted runner trial (2026-10-30)

**Result: it works while the repo is PRIVATE.** A full `Verify` passed on a one-job runner on the PC, with the same tests as hosted CI on the same commit. It took 37m51s against 19m34s, and only one can run at a time.

**Recommendation: yes, on demand only.** Use the runner for `Verify` on a train head, started by the lead, while the repo is private. Keep every PR push on hosted CI. Moving all PR pushes to the runner would be a no: each one would hold a heavy seat for 38 minutes, and those seats are already the bottleneck.

What a yes gets:

- A train can reach a green `Verify` without opening the repo, so the public window is needed only for the deploy.
- It costs no GitHub money.
- CI inside a public window keeps working as it does today.

What stays the same: deploys still need a public window. `E2E`, `Control` and `Migration replay` still run on hosted CI.

## Does it run while private?

Yes, seen directly in run [41089707940](https://github.com/najathakram/routeflow/actions/runs/41089707940) on PR [#3993](https://github.com/najathakram/routeflow/pull/3993), repo PRIVATE. The two jobs ran side by side:

| Job              | What happened                                                             |
| ---------------- | ------------------------------------------------------------------------- |
| `Hosted control` | Failed in 1 second with the "recent account payments have failed" message |
| `Self-hosted`    | Picked up by the runner and passed; an anonymous API read returned 404    |

So the billing block stops hosted jobs but did not stop self-hosted jobs. GitHub's docs list self-hosted use as free and don't say what happens under a failed payment, so this result comes from the run, not from a promise. GitHub announced a self-hosted per-minute charge and then postponed it. If that returns, the block could reach these jobs too.

## Time and results against hosted CI

Same commit, `2c69063249` (the merge commit of PR [#3992](https://github.com/najathakram/routeflow/pull/3992)). Hosted is run [41085777884](https://github.com/najathakram/routeflow/actions/runs/41085777884). Runner is run [41123831994](https://github.com/najathakram/routeflow/actions/runs/41123831994).

|                            | Hosted         | Runner (4 CPUs, 16 GB) |
| -------------------------- | -------------- | ---------------------- |
| Result                     | Green          | Green                  |
| Tests passed (plus 4 todo) | 51,062         | 51,062                 |
| Turbo tasks                | 32 of 32       | 32 of 32               |
| Whole job                  | 19m34s         | 37m51s                 |
| `npm ci`                   | 45s (cached)   | 3m42s (cold)           |
| Turbo step                 | 16m22s         | 30m10s                 |
| API tests                  | 685 s          | 1,099 s                |
| Web tests                  | 641 s          | 1,478 s                |
| Mobile tests               | 114 s          | 148 s                  |
| Wait to start              | None in window | 26 min for a seat      |

Every suite and test count matched. The image is Ubuntu 24.04 on both. Hosted's recent `Verify` jobs ran about 20 to 30 minutes, so the runner took 1.3 to 1.9 times as long. `npm ci` could lose about 3 minutes by pre-loading npm's cache into the image. That was not tried.

The first attempt, at 6 CPUs and 16 GB, went red in 43m42s (run [41090079673](https://github.com/najathakram/routeflow/actions/runs/41090079673)). It was out of memory, not a code difference:

- 3 Jest workers were killed with SIGKILL, and 13 web tests failed, 12 of them on the 30-second timeout.
- The container sat at its memory limit in 21 of 53 samples.
- The PC was at 95% CPU or more in 15 samples, and free memory fell to 1.2 GB.

At 4 CPUs, which is the size of the hosted runner, there were no kills and no timeouts:

- Memory peaked at 15.29 of 16 GiB, so the margin is thin.
- The PC never reached 95% in 68 samples, and free memory fell to 3.6 GB.
- The PC was also quieter that evening, so CPU count was not the only thing that changed. Worker count is the likely cause, but it was not measured directly.

The other runs did not reach a `Verify` result. A one-job runner took a leftover proof job from the trial, which passed while private. The next attempt was stopped after 4 minutes at the lead's request, because four landing verifies were waiting behind it.

## How many jobs can run in parallel

**One `Verify` at a time on the PC.**

- A run needs a 16 GB reservation, and the Docker VM is capped at 24 GB, so two will not fit.
- Each run holds one heavy seat for about 38 minutes and competes with landing verifies. The lead stopped one on the day of the trial for that reason.
- At that pace the ceiling is about 1.5 runs an hour, before any seat wait.
- The Mac mini is not an option: it is ARM with 16 GB, and one run peaks at 15.29 GiB.

## What each workflow needs

The repo uses Node 24, not the Node 20 in `CLAUDE.md`.

| Job                | Postgres, Redis, Docker | Secrets | Runner fit                                        |
| ------------------ | ----------------------- | ------- | ------------------------------------------------- |
| `Verify`           | None                    | None    | Proven here. Needs outbound HTTPS and about 16 GB |
| `Control`          | None                    | None    | Should fit, not tested                            |
| `Migration replay` | Postgres via Docker     | None    | Does not fit: a Docker socket is root on the VM   |
| `E2E`, deploy jobs | Production endpoints    | Yes     | Must stay hosted                                  |

## Security setup

The risk: the repo goes public for deploys, and on a public repo a fork PR can reach a self-hosted runner. A job `if:` cannot stop that, because a fork edits its own copy of the workflow. So the main protection is outside the workflow.

**No runner exists while the repo is public.** This runs on the host in `tools/ci-runner/launch-once.mjs`:

- It refuses to start unless the repo is PRIVATE. This fired for real during a deploy window (exit 3).
- It refuses to start if any run from outside the repo is queued, because a fork job queued in a public window can wait 24 hours for the next runner.
- It checks every 15 seconds and removes an idle runner if the repo leaves PRIVATE.
- Its token is good for one job, and the runner deregisters after that job.

**If code does reach the container, it has little to work with:**

- It runs as uid 10001 with zero capabilities and `no-new-privileges`, checked inside the job.
- It has no Docker socket, no volumes, no secrets and no environment from the host. Secret-name checks found none.
- It cannot reach private addresses. Host and LAN ports were reached from a plain container on the same network and blocked from this one. Only web and DNS traffic leave.
- It is limited to 4 CPUs, 16 GB and 8,192 processes, and the container is deleted after the job.

**Rollout adds one more limit:** only `workflow_dispatch` reaches the runner, and only someone with write access can fire that. `pull_request` jobs stay on `ubuntu-latest`.

Limits to know:

- **A real fork PR was not tested.** That cannot be done while private. The protection above is by design, not by observation.
- A job can still send source code out over the web, since 80 and 443 stay open. It holds no secrets to send.
- The 15-second check depends on GitHub's API. One read timed out during the trial and was retried, so an idle runner is unwatched during an API outage.
- The image pins runner 2.338.2, so it needs a rebuild when GitHub retires that version.
- A PC reboot stops this CI path. Hosted CI in a window is the fallback.

## Rollout diff

`pull_request` behaviour does not change, and neither do `control.yml` or the `ci-workflow.spec.ts` pins. The master workflow lines below were read at `3ba29d8a5f`.

```diff
--- a/.github/workflows/ci.yml
-#   1. ubuntu-latest ONLY. Windows bills 2x and macOS 10x.
+#   1. ubuntu-latest ONLY, except Verify dispatched with runner=self-hosted (runbook:
+#      docs/runbooks/self-hosted-runner-trial.md). Windows bills 2x and macOS 10x.

   workflow_dispatch:
+    inputs:
+      runner:
+        description: "Where Verify runs. self-hosted needs tools/ci-runner/launch-once.mjs on the PC."
+        type: choice
+        options: [hosted, self-hosted]
+        default: hosted

   verify:
-    runs-on: ubuntu-latest
-    timeout-minutes: 30
+    runs-on: ${{ inputs.runner == 'self-hosted' && fromJSON('["self-hosted","routeflow-ephemeral"]') || 'ubuntu-latest' }}
+    timeout-minutes: ${{ inputs.runner == 'self-hosted' && 45 || 30 }}
     steps:
       - uses: actions/checkout@v7
+        with:
+          persist-credentials: ${{ inputs.runner != 'self-hosted' }}

   e2e-gate:
-      github.event_name == 'workflow_dispatch'
+      (github.event_name == 'workflow_dispatch' && inputs.runner != 'self-hosted')
```

The `runs-on` and `timeout-minutes` expressions were not run in this trial, which used fixed values. The first dispatch after merge is their test.

The same PR adds `tools/ci-runner/` from this branch with these launcher changes:

1. Fail closed: if the visibility check keeps failing, remove an idle runner.
2. Retry runner deletion after a kill. A busy runner can't be deleted, and the stopped attempt left an offline registration for 5 minutes, until its cancelled run closed.
3. Add a `launch-once.self-test.mjs`, following the repo's `*.self-test.mjs` convention.

`runner-trial.yml` and the trial's `ci.yml` edits are not part of it.

Running it, one job at a time, behind the landing queue:

```bash
gh workflow run ci.yml --ref <train-branch> -f runner=self-hosted
```

```bash
node scripts/heavy-slot.mjs run --label ci-runner --branch <train-branch> -- node tools/ci-runner/launch-once.mjs
```

A runner takes whatever matching job is waiting, so queue only one job at a time.

## Cleanup state

- Runners registered: 0. No `rf-ephemeral` container is left, and visibility, billing, `master` and live tenants were not touched.
- Still on the PC for a yes: image `routeflow-ci-runner:2.338.2` (1.63 GB) and Docker network `routeflow-ci-runner`.
- PR #3993 stays a draft and is not for merge.

If the answer is no, remove both from the PC:

```bash
docker image rm routeflow-ci-runner:2.338.2
```

```bash
docker network rm routeflow-ci-runner
```
