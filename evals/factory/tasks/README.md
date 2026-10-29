# Frozen eval tasks

One `<id>.json` per past change. The set is picked by a human from `node scripts/factory-eval.mjs select`
output and is frozen: changing it is its own diff. A task marked `"example": true` documents the schema;
every command skips it unless `--include-example` is passed. The 20 real tasks and the example land in R6-b.

| Field         | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `id`          | Same as the file name; lower-case letters, digits, dashes.                                    |
| `kind`        | `bug` or `feature`.                                                                           |
| `risk`        | Risk class of the source PR: `green`, `amber`, `red` or `black`.                              |
| `sourcePr`    | The PR number the task came from.                                                             |
| `baseSha`     | The parent of the real change; the agent starts from here.                                    |
| `brief`       | Issue or spec text given to the agent, scrubbed to acme-style names. No client identifiers.   |
| `hiddenTests` | `[{ path, fromSha }]`: the change's own test files at its merge sha. Copied in only to grade. |
| `grade`       | Optional extra command as a list, for example `["node", "scripts/x.self-test.mjs"]`.          |

Grading: `pass` (hidden tests and `grade` pass), `fail`, or `broken` (a hidden test cannot run).
Known limit: the tree shares the repo's object store, so an agent could find the fix with `git log --all`.
