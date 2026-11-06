ebc237be009b73e56e4f5d15934ed3d7921be02d
# Row 734 handover-stamp static test races .jest-cache (LIVE)
Evidence: apps/web/lib/handover-stamp.staff-only.static.test.ts:10 SKIP=new Set(['node_modules','.next','e2e','coverage']) lacks .jest-cache; :15 statSync unguarded -> ENOENT race.
Fix: add .jest-cache to SKIP, tolerate ENOENT; audit other walkers using readdirSync+statSync (counter-focus.structure.test.ts, no-raw-strings.test.ts, no-can-edit-prices.test.ts, tailwind-no-template-classes.static.test.ts, etc.).
Radius: test files only.
Lessons: L-322 repoint static scans after edits; L-176 own npm ci per worktree.
