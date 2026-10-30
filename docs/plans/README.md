# Work plans (`*.plan.json`)

A feature with more than one slice gets one plan file here; lane briefs cite slice ids, not prose.
Top level: `slug`, `spec`, `owner`, `criteria[]`, `slices[]`. A criterion has `id`, an EARS `ears`
sentence ("The X shall", "When …, the X shall", "While …", "If …, then the X shall", "Where …") and
`testIds`. A slice has `id`, `title`, `files`, `testIds`, `dependsOn`, and optionally `estLines`,
`branch`, `pr`. `testIds` are test names, not paths. Slices that share a file need a `dependsOn` chain.

- `node scripts/plan.mjs <file>` checks (default); `--waves` prints the landing order; `--status` asks gh.
- `npm run verify` runs `node scripts/plan.mjs --check-all` over every plan here.
- `example-acme.plan.json` is a format sample. The `.md` files here are unrelated older notes: leave them.
