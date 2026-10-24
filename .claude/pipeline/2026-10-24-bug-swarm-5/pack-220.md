aceb7686baef4832c824ca29d43d3143f878c497
# row 220 eslint no-unused-vars varsIgnorePattern (LIVE)
Evidence: apps/api/eslint.config.mjs:44 has only argsIgnorePattern; users.service.ts:128-129 destructures _deniedPermissionGroups/_permissionsVersion (unused warns).
Signatures: config only; add varsIgnorePattern '^_' (consider destructuredArrayIgnorePattern/ignoreRestSiblings).
Radius: apps/api/eslint.config.mjs, apps/api/src/users/users.service.ts
Lessons: none material; ESLint is per-workspace (run npm run lint -w apps/api).
