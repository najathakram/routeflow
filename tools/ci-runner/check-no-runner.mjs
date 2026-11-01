#!/usr/bin/env node
// A public repo lets a fork PR reach a self-hosted runner, so a public flip waits until none is
// registered. It runs straight before the flip, and only a reading of 0 lets the flip go. Exit 1 is
// a runner still registered; exit 2 is no reading. Routine: docs/runbooks/self-hosted-runner.md.
//
//   node tools/ci-runner/check-no-runner.mjs && gh repo edit <repo> --visibility public ...
import { checkNoRunner } from "./runner-lib.mjs";

process.exit(checkNoRunner());
