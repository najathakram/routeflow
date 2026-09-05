# Build plan — PR-4 · `@routeflow/pricing`

Status: APPROVED · scale: major · branch `refactor/imp-01-pricing-package` (after PR-3 merges)
Spec `./spec.md` · Test plan `./test-plan.md` · Lessons: L-008, L-009, L-010, L-028, L-032, L-034, L-038.

Repo: npm workspaces `apps/*`, `packages/*`; Turbo; every existing `packages/*` is source-direct
(no build). API compiles to CommonJS via `nest build` (`apps/api/tsconfig.json`: `module`/
`moduleResolution` nodenext, `resolvePackageJsonExports: true`). Root `overrides` pin jest 30.2.0.
Prettier `npx prettier --write`. Rules: targeted edits; a gap is a finding; never touch files
outside your package; **no pricing body may change** (R2).

## Test packages (Sonnet @ high — money)

| id                   | files                                                      | brief                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tp-shape`           | `packages/pricing/src/package-shape.spec.ts`               | T1 (guarded `fs.readFileSync` + JSON.parse; `{}` when absent).                                                                                              |
| `tp-golden`          | `packages/pricing/src/golden.spec.ts`                      | T2; import fixtures from `./golden.fixtures` with a guarded require (they move in p3 — until then the require fails and the suite fails on its assertions). |
| `tp-no-mirrors`      | `packages/pricing/src/no-mirrors.spec.ts`                  | T3.                                                                                                                                                         |
| `tp-runtime-imports` | `apps/api/src/common/no-runtime-workspace-imports.spec.ts` | T4 — READ the file first if it exists (PR-1's engine may have created it); extend, never duplicate.                                                         |

## Red gate

```
cd packages/pricing && npx jest src/package-shape.spec.ts src/golden.spec.ts src/no-mirrors.spec.ts
cd apps/api && npx jest src/common/no-runtime-workspace-imports.spec.ts
```

expect: fail (the first command needs a `jest.config.js` in the package — the test package
`tp-shape` also creates `packages/pricing/jest.config.js` and a minimal `package.json`
`{ "name": "@routeflow/pricing", "private": true }` so Jest can run; p1 completes them).

## Implementation packages

| id                    | model @ effort         | files                                                                                                                                                                                                                                                                                                                                 | dependsOn | satisfies      | provenBy       |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | -------------- |
| `p1-package-skeleton` | claude-opus-5 @ high   | `packages/pricing/package.json`, `packages/pricing/tsconfig.json`, `packages/pricing/tsconfig.build.json`, `packages/pricing/jest.config.js`, `packages/pricing/.gitignore`, `packages/pricing/src/index.ts`                                                                                                                          | —         | R1             | T1             |
| `p2-sources`          | claude-sonnet-5 @ high | `packages/pricing/src/pricing.ts`, `packages/pricing/src/tier-pricing.ts`, `scripts/codemods/pricing-body-diff.mjs`                                                                                                                                                                                                                   | p1        | R2             | T2             |
| `p3-tests-move`       | claude-sonnet-5 @ high | `packages/pricing/src/pricing.spec.ts`, `src/tier-pricing.spec.ts`, `src/golden.fixtures.ts`; deletions: `apps/api/src/common/pricing.spec.ts`, `pricing-parity.spec.ts`, `pricing-parity.fixtures.ts`, `apps/api/src/utils/pricing.spec.ts`, `apps/mobile/__tests__/pricing.test.ts`, `apps/mobile/__tests__/pricing-parity.test.ts` | p2        | R7             | A3             |
| `p4-wiring`           | claude-opus-5 @ high   | root `package.json`, `turbo.json`, `apps/api/package.json`, `apps/web/package.json`, `apps/mobile/package.json`, `apps/mobile/jest.config.js`, `apps/mobile/metro.config.js`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `package-lock.json`                                                                                       | p1        | R3, R4, R6, R8 | T1, T4, A1, A4 |
| `p5-rewrite`          | claude-sonnet-5 @ low  | `scripts/codemods/pricing-import-rewrite.mjs` + every importer file in `apps/api/src`, `apps/web`, `apps/mobile` (import lines only); deletions of the 4 legacy sources; the 6 comment-only references                                                                                                                                | p2, p4    | R5             | T3, A2         |
| `p6-docs`             | claude-sonnet-5 @ low  | `CLAUDE.md`, `.claude/code-map/{INDEX,api,web,mobile,packages}.md`, `.claude/code-map/_meta.json`, `docs/IMPROVEMENTS.md`, `.claude/lessons/LESSONS.md`, `.claude/lessons/_meta.json`                                                                                                                                                 | p1–p5     | R9             | review         |

### p1 — exact files

`package.json`:

```json
{
  "name": "@routeflow/pricing",
  "version": "0.0.1",
  "private": true,
  "description": "RouteFlow money math — the single source for line/tax/total/promotion/tier pricing used by api, web and mobile",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
    "test": "jest",
    "lint": "tsc --noEmit -p tsconfig.json",
    "check-types": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@types/jest": "<same as apps/api>",
    "jest": "<same as apps/api>",
    "ts-jest": "<same as apps/api>",
    "typescript": "<same as apps/api>"
  }
}
```

`tsconfig.json`: `{ "extends": "@routeflow/typescript-config/base.json", "compilerOptions": { "module": "commonjs", "moduleResolution": "node", "target": "ES2022", "rootDir": "src", "outDir": "dist", "declaration": true, "declarationMap": true, "sourceMap": true, "types": ["jest", "node"] }, "include": ["src"] }` — Opus: confirm `base.json`'s NodeNext settings are overridden cleanly (the API consumes CJS; `moduleResolution: node` avoids `.js` extension rewriting in a package with a single entry).
`tsconfig.build.json`: extends `./tsconfig.json`, `exclude: ["src/**/*.spec.ts", "src/**/*.fixtures.ts"]`.
`jest.config.js`: `{ preset: "ts-jest", testEnvironment: "node", testRegex: ".*\\.spec\\.ts$", roots: ["<rootDir>/src"] }`.
`.gitignore`: `dist/`. `src/index.ts`: `export * from "./pricing"; export * from "./tier-pricing";`.

### p2 — sources (moved, not retyped)

1. Copy `apps/api/src/common/pricing.ts` → `packages/pricing/src/pricing.ts` verbatim.
2. Copy `apps/api/src/utils/pricing.ts` → `src/tier-pricing.ts`; change its import to `from "./pricing"`.
3. Append to `src/pricing.ts`: web's `roundUnitCost` (with doc comment, `apps/web/lib/pricing.ts:119-143`) and mobile's `effectiveQty` (`apps/mobile/lib/pricing.ts:294-308`), verbatim.
4. Widen `prorateLineSubtotal`'s first parameter to `storedSubtotal: number | null | undefined` and add mobile's doc sentence; body unchanged.
5. `scripts/codemods/pricing-body-diff.mjs`: for every `export function` in the old API/web/mobile files, extract the function text (from `export function name` to the matching closing brace at column 0) and compare with the package's; print `identical` / `DIFFERS` per symbol; run it and paste the output into the PR (only `prorateLineSubtotal`'s signature line may differ). Deviation from that → finding.

### p3 — tests move

Move the API `pricing.spec.ts` and delete the "mirror parity" describe; move `utils/pricing.spec.ts`
(imports → `./tier-pricing`); move the fixtures to `src/golden.fixtures.ts` (retain the doc
comment that the numbers are hand-worked); diff mobile's two deleted test files against the moved
suite and port any assertion not already present into `src/pricing.spec.ts` (list them in the
deviation note). Delete `pricing-parity.spec.ts`.

### p4 — wiring (Opus)

- Root `package.json`: `postinstall` — if present, append `&& npm run build -w @routeflow/pricing`; else add it. Add nothing else. Run a REAL `npm install` (not `--package-lock-only`) after the three app `package.json` dependency lines are added; commit `package-lock.json`.
- `turbo.json`: delete the `"@routeflow/api#test"` block (:57-71 — verify by reading the key, not the line numbers); `check-types.dependsOn` → `["^build", "^check-types"]`; `dev.dependsOn` include `"^build"`.
- `apps/api/package.json` jest mapper and `apps/mobile/jest.config.js` mapper (R6); `apps/mobile/metro.config.js` map entry (read the existing `@routeflow/types` line and mirror it).
- Dockerfiles: one manifest COPY line each, placed among the existing `packages/*/package.json` lines.
- Prove: `npm ci` from clean produces `packages/pricing/dist/index.js`; `node -e "console.log(Object.keys(require('@routeflow/pricing')).length)"` from `apps/api` prints 25 (the package has 40 export statements, 15 of them type-only and erased at runtime; the declared surface is proven by the 40 exports visible in `dist/*.d.ts`).

### p5 — rewrite (Sonnet @ low, scripted)

`scripts/codemods/pricing-import-rewrite.mjs` (node, no deps): walks the three apps (skip
`node_modules`, `.next`, `dist`, `packages/pricing`), for each `.ts/.tsx` rewrites import/`export … from`
specifiers matching the forms in spec R5 to `@routeflow/pricing`, merges two imports from the same
package into one (union of named imports, deduplicated, sorted), supports `--check` (exit 1 +
list when any legacy form remains) and `--write`. Run `--write`, then delete the four legacy files
and update the six comment-only references, then Prettier the touched files, then `--check`.

### p6 — docs per R9; lesson L-054 from spec, ≤ 1,000 bytes, category `tooling`.

## Verification

- perRound: `npx tsc -p apps/api/tsconfig.build.json --noEmit` · `npm run check-types -w @routeflow/pricing` · `npm run lint -w apps/api`
- final: `npm run verify`

## Mutation probe — see test plan (3 targets).
