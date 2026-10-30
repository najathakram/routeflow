# Self-hosted runner: Verify on a train head

The lead starts this, on demand, on the PC. It runs one `Verify` on a train head while the repo is PRIVATE, so a train can reach a green CI result without opening the repo.

It does not replace anything:

- Train verify and the DB lane on our machines stay the gate.
- PR pushes stay on hosted CI.
- Deploys keep their public window.
- `Control` and `Migration replay` stay as they are.

Trial results and reasoning: `docs/runbooks/self-hosted-runner-trial.md` on branch `trial/self-hosted-runner`.

## Start it

Dispatch the job, then start the runner. Use two commands, in this order.

```bash
gh workflow run ci.yml --repo najathakram/routeflow --ref <train-branch> -f runner=self-hosted
```

```bash
node tools/ci-runner/launch-once.mjs --branch <train-branch>
```

The launcher takes its own heavy seat, so do not wrap it in `heavy-slot run`. Run it in the background and read its output when it exits. While it waits for a seat, nothing is registered, and it is safe to stop. `--branch` must match the dispatch: the launcher stops any job that isn't a dispatch on that branch.

The branch needs this PR's `ci.yml`, because a dispatch reads the workflow from the branch.

**One-time setup on the PC.** Both are done. When `Dockerfile` or `entrypoint.sh` changes, bump the tag here and in `launch-once.mjs`, then rebuild. A launcher that can't find its tag fails instead of running an old image.

```bash
docker build -t routeflow-ci-runner:2.338.2-r2 tools/ci-runner
```

```bash
docker network create routeflow-ci-runner
```

## What it costs

- **One capped verify seat for about 38 minutes.** The trial took 37m51s against hosted's 19m34s, and it took 26 minutes to get a seat. The seat competes with landing verifies, so run it behind the landing queue.
- **4 CPUs and 16 GB.** Memory peaked at 15.29 GiB. 6 CPUs ran out of memory, so keep the default size.
- **About 1.5 runs an hour** at most, before any wait for a seat.

## One Verify at a time

- The PC fits only one. Docker's VM is capped at 24 GB.
- **A runner takes whatever matching job is waiting, oldest first.** Queue only one job with `runner=self-hosted`. Before you start, cancel any older one that is still queued. If it takes the wrong job, the launcher stops it, and you lose that seat.
- A queued `runner=self-hosted` run blocks any other dispatch on the same branch until it finishes or you cancel it.
- It runs `Verify` only. Dispatching with `runner=self-hosted` skips the E2E jobs.

## Reading the result

**The launcher's exit code is not the CI result.** It reports on the runner, so read the run:

```bash
gh run list --repo najathakram/routeflow --workflow ci.yml --branch <train-branch> --limit 1
```

| Exit | Meaning                                                 | What to do                                            |
| ---- | ------------------------------------------------------- | ----------------------------------------------------- |
| 2    | `--branch` is missing, or `--max-minutes` isn't 1 to 80 | Fix the flag                                          |
| 3    | The repo is not PRIVATE                                 | Wait for the window to close, then start the launcher |
| 4    | A run from outside the repo is queued or running        | Do not start a runner. Read the run first             |
| 5    | No heavy seat: `CI` is set, or `RF_HEAVY_SLOT=off`      | Unset it. The runner never runs beside a seat         |

These four print a `refusing:` line and register no runner. The job stays queued for up to 24 hours, so a later launcher can still take it.

With no `refusing:` line, the code comes from elsewhere:

- 1: a failed `gh` call, or a seat wait that timed out.
- 76: the seat's hold cap.
- 130 or 143: the launcher was interrupted.
- 125: Docker couldn't start the container, for example because the image isn't built.
- Anything else: the container's own code.

Read the launcher's output, then check `docker ps` and the run.

## Stopping it

Stop the container and cancel the run, and leave the launcher running so it can clean up.

```bash
docker ps --filter name=rf-ephemeral
```

```bash
docker rm -f <container-name>
```

```bash
gh run cancel <run-id> --repo najathakram/routeflow
```

The launcher then frees its seat and retries deleting the runner for up to 15 minutes, because GitHub refuses to delete a runner until its run closes. If it gives up, it prints the command to finish the job.

If the launcher dies, its container ends within seconds, because the container stops when the launcher's end of stdin closes. The runner stays registered but offline, so it can't take a job. Cancel the run, then delete the runner:

```bash
gh api repos/najathakram/routeflow/actions/runners --jq ".runners[] | {id, name, status, busy}"
```

```bash
gh api -X DELETE repos/najathakram/routeflow/actions/runners/<id>
```

## What keeps it safe

A public repo lets a fork PR reach a self-hosted runner, and the repo goes public for deploys. A job `if:` cannot stop this, because a fork edits its own copy of the workflow. So no runner should exist while the repo is public:

- The launcher refuses unless the repo is PRIVATE and no outside run is queued or running. It checks after it gets the seat.
- Every 15 seconds it checks again. An idle runner is removed if the repo leaves PRIVATE, or if 45 seconds pass with no PRIVATE reading.
- When a job starts, the launcher finds the run holding this runner. Unless it is a dispatch in this repo on `--branch`, the container is stopped. If GitHub can't confirm that within 2 minutes, it is stopped too.
- If the launcher dies, the container ends with it.
- The runner's token is good for one job, and the container is deleted after it.
- The container holds no secrets, runs as an unprivileged user and can't reach private addresses.

**Check for a live runner before opening a window.** The deploy flow doesn't check this for you.

```bash
gh api repos/najathakram/routeflow/actions/runners --jq ".total_count"
```

It should print 0. If it doesn't, finish or stop that runner before you open the window, as in [Stopping it](#stopping-it).

A confirmed job keeps running if the repo goes public. A one-job runner can't take a second job, so that job is the only one exposed.

**Keep the `runner` input on dispatch only.** PR events must stay on `ubuntu-latest`.
