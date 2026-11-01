#!/usr/bin/env node
// One runner, one job, then gone. Runs on the HOST under the lead's gh login; the container only
// ever receives a one-job JIT config on stdin. Refuses while the repo is PUBLIC, because a public
// repo lets fork PRs reach a self-hosted runner, and a job `if:` cannot stop that: a fork edits its
// own copy of the workflow. Routine: docs/runbooks/self-hosted-runner.md.
//
//   node tools/ci-runner/launch-once.mjs --branch <train> [--cpus 0-3] [--memory 16g] [--max-minutes 60]
import { launch, parseFlags } from "./runner-lib.mjs";

process.exit(await launch(parseFlags(process.argv.slice(2))));
