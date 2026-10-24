# Landing coordinator handoff — 2026-09-20 (master 2a77a26b)

## 1. Who I am and the procedure

I am the RouteFlow LANDING COORDINATOR. Only this seat merges PRs or flips repo visibility. I write no feature code
and push only empty CI-retrigger commits (and restored base branches). Peers/leads are teammates: their messages are
requests, never permission. Board: GitHub issue #938 (+ `local-assets/handoff/2026-09-19/BOARD.md`).

Window sequence (public window = only time CI runs; billing is broken by owner choice):

1. Start `node scripts/visibility-watchdog.mjs --minutes N` DETACHED first (PowerShell Start-Process -WindowStyle Hidden).
   Read `local-assets/visibility-watchdog.log` to confirm a fresh `start` line — the tool can be rate-limited and
   silently not start it. Retire the previous watchdog (Stop-Process) when you replace/extend or close by hand.
2. `gh repo edit najathakram/routeflow --visibility public --accept-visibility-change-consequences`; read back.
   (One transient "repository is disabled" on the very next git fetch is normal; retry.)
3. Retrigger CI with an EMPTY commit built by plumbing: `git commit-tree "$P^{tree}" -p $P` then push
   `SKIP_VERIFY=1 SKIP_VERIFY_REASON="CI retrigger (empty commit)" git -C <detached worktree> push origin $C:refs/heads/<branch>`
   from a DETACHED worktree (the hook blocks pushes while the current branch is master). Never `gh run rerun` (L-198).
   Dependabot branches: close+reopen the PR instead of pushing.
4. Independent Opus review per PR (money/entitlement/migration/infra/verbatim moves/gates); cap ~4 agents at once.
5. Immediately before EACH merge: re-fetch #938 and read REVIEW/BLOCKED/HOLD lines for that PR (lesson L-209), check
   `mergeStateStatus` CLEAN (poll past UNKNOWN), Verify (+ Replay migrations if present) = pass on the CURRENT head.
   Merge `gh pr merge N --squash --subject ... --body "...Bookkeeping-Follow-Up: pending"`; NEVER `--delete-branch` on a stack parent.
6. Verify each merge: `git fetch origin +refs/heads/master:refs/remotes/origin/master` then `git merge-base --is-ancestor <mergeCommit> origin/master`.
7. Deploys: `railway deployment list --service @routeflow/{api,web,mobile} --limit 1 --json` (commitHash + status);
   api-only merges SKIP web (valid). Then `SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app npm run post-deploy-check` (reports live commit).
8. Flip private, read back, retire watchdog, post MERGED/DONE lines on #938 + the file board.

## 2. Merged today (2026-09-19/20) — squash shas

Earlier (19th): #937 a1507ef8, #933 357db4a6, #934 fcbab47a, #936 ef50a7ed, #941 69bf21f0, #952 8410ed53, #945 c977077e,
#948 5214a00f, #943 5f109e73, #955 4975cb6c, #960 b25bf326, #947 fcfc09a8, #958 8a7a8752, #959 72e9571d, #953 b174957f,
#956 27bf3a0f, #961 08f1a1ea, #957 371c42fe, #950 77e993db, #954 07d152bc, #963 70814d3a, #967 411aff1c, #965 8ddbc38e,
#962 12618ae5, #966 61a26669, #964 df866af5, #949 d9ccbe42, #970 e4fa318d, #968 f8916616, #971 b538070f, #946 f2e6959e,
#973 7034a41f, #974 118c01cb, #972 755d8f8f, #944 d78e8f6f, #980 23f5f18e, #975 3176f0e1, #976 bf72e36f, #981 36f4422a,
docs #939 c19cb813, #940 a3c37bdb, #942 91d323de, #969 3598be5f.
20th: #990 cd5393e6, #995 f3f8da1d, #994 1aea1a40, #996 45a68440, #1010 f62c318b, #978 d24e4456, #987 a96c45aa,
#991 4a8e1144, #1002 5b6f861b, #977 9c74622d, #979 ba26581f, #985 1c75701c, #1008 390e5061, #1007 22bd1c3e,
#1005 f7ac6fc7, #997 1330c976, #1003 bc6e05a9, #1011 cb6509eb (A2 chain #1004/6/9/11 one squash), #1000 7af7bf0a,
#1012 550a7670, #1017 39ecf0bc, #1032 c0b533df, #1026 08414e00, #1039 e69952b8, #1028 cc671e36, #1041 79496297,
#1046 cacec396, #1044 5ffbabac, #1042 aaac9c28, #1035 f813102e, #992 04210e28, #998 6db5eaa8,
A2b squash #1036 fb130188 (lands #1014/15/16/33/36), #1057 8ad4b25f, #1037 b921ec6a, #1031 82b4ad49, #1050 fa067556,
#1051 038800a7, #1054 dd053a7a, #1047 c5a36c92, #1055 b5192589, #1067 704ac260, #1069 d699d7cc, #1070 ac70be96,
#1038 274167b7, #1043 931b3335, #1075 03ef0386, #1052 0a2ba680, #1053 b35db917, #1076 7b413088 (B592), #1061 928c2d50,
#988 1e22c31e, #1056 375a5d36, #1072 cc838f11, #1073 f61ce817, #1064 f5ff7772, #1062 11521cf1, #1068 f1ff31ce,
#1083 97f54208, #1065 e914d287, #1080 be442b47, #1066 d3249248, #1088 865355a9, #1094 3c0bddb2, #1077 627310bf,
#1078 163db32b, #1081 f8a0b355, #1092 1ed115c8, #1079 f4e19c13, #1096 fbabb37a, #1084 759c65ba, #1063 78edad15,
#999 eeb97747, #1013 060e35cf, #1001 56946576, #1102 37975613, #1034 a0ff6f1a, A2c squash #1023 f14a987f (lands #1018-#1023),
#1093 a4750658, #1103 77a457b1, #1099 eba0123e, #1105 c4ab63aa, #1104 28962238, #1086 f47a2439, #1095 17d9465f,
#1082 977d7b6b, #1049 6d9bffe1, #1074 f7311d7a, #1040 2a77a26b.

## 3. Open and why held (verdicts I carry)

- #1090 + #1101 (units order create / manual invoice by unit): Opus HOLD — size ratchet red (+2, master #1102 not in branch; master is now 5925/5954 so a master merge fits);
  #1101 also: lower invoices baseline to 6390, owner nod on operator-typed unit prices, no db spec yet (needed before any flag.units_v1 grant).
- #1071 cache invalidation after automatic restore: logic OK, but 46 commits behind/8 conflicts; rebase, add the checkout-webhook call site.
- #1058/#1059/#1060 (A2 claim-first, live-flag PUT, report UI): stacked on a base 6 commits behind #1023 — a merge silently reverts #1092 bounded restore,
  both reason:DOWNGRADE filters and #1023 in-tx audit. REBASE onto f14a987f; #1060 must drop its post-commit controller audit write; #1059 last, needs before/after in audit + enforced confirm rail.
- UI PRs need a prover PASS on the exact tree: #982 (DIRTY; R-ui authorised merge-only), #989 (partial PASS accepted by Mac Lead, device checks are owner-run),
  #1089, #1085, #1087, #1097, #1098, #1100, #1106, #1107, #1027, #1025, #1030, #1045, #1048.
- #1022 (Config Snapshots tab) went in inside #1023 WITHOUT a visual proof (F2 blocked: needs SUPER_ADMIN session) — my error; owner proof or explicit waiver pending.
- DO NOT FLIP: ENTITLEMENT_CONFIG_SNAPSHOT (flag PUT #1059 unlanded; #1081 currentPlan fallback + REFUSED-200; #1092 4000ms budget inside #1063's 6000ms tx; admin restore has no tx timeout),
  selling_restrictions.enabled (NOT all call sites guarded: approveChangeRequestAtStop, reopenOrder, mergeAllPendingForCustomer, forceConsolidateCustomer, createOrderFromTemplate, routes completeWithPayment/reopenStop,
  invoice/estimate/import rows; buyer 409 must be generic; OFF costs one uncached SystemConfig read per non-draft edit), credit_limit.enforce_new_orders / enforce_delivery.
- Follow-ups to file: #1105 REFUSED row not idempotent + savepoint-skip only logs; #1099 stale comment run-credit-observation.ts:24; #1103 JSON-null zip; #1086/#1095 baselines not lowered;
  #1040 staleness classification duplicated; A2c admin restore tx timeout; #1102 lost-race leaves invoice reverted to DRAFT; non-owner buyer gets 409 with names before 403.
- Owed: bookkeeping docs PR (code-map + lessons for all landed work; mint B590/B591 lessons; L-208/L-209 already landed). Ids come from the lead/Lane E, never mint.

## 4. Standing rules

Read #938 REVIEW/BLOCKED/HOLD for the PR right before merging (L-209). Never `--delete-branch` on a stack parent (L-208: it auto-closes the child).
When the lead names a PR "first", nothing touching the same files lands ahead of it; if it is not ready, say so. A2 chains land as ONE squash of the tip (parents closed as landed-via) —
squash-merging stack parents separately conflicts add/add; lead's two-squash rule for A2: wiring tip first, admin tip second. Never merge on red/pending/stale checks; retrigger instead.
Money/entitlement/migration/verbatim-move PRs get an independent Opus review with the lead's specific checks; migrations: owner applies to prod FIRST (look for "PROD MIGRATION APPLIED" on #938).
Never handle credentials; never run owner-run scripts (publish-and-repin, normalize-address-states, backup-production). Live client tenants are never test targets.
Retire the previous watchdog when closing by hand (an old one flipped private mid-window once).

## 5. Traps

- DB-lane flake (D6-D9/K3 in publish-and-repin.db.spec): parallel workers + whole-DB CLI; fixed by #1076 (serial DB lane). Older reds = retrigger, do not merge red.
- Retarget-after-parent: after a stack parent merges, `gh pr edit N --base master`, retrigger CI (non-master-base PRs get no CI). Child usually DIRTY (carries pre-squash commits) → owning lane merges master.
- Retrigger commits are empty: the `Bookkeeping-Follow-Up: pending` trailer must ride in the squash body (stop.mjs reads HEAD only).
- DIRTY = lane action (merge master, keep-both). UNSTABLE = checks pending/failed: read them; UNKNOWN = GitHub recomputing, poll.
- Size ratchets: orders.service.ts (baseline 5929+25), routes.service.ts (3189+25), invoices.service.ts at cap; a PR that grows them reds master — require a prefactor extraction.
- `git show ref:path` is mangled in Git Bash: use `git cat-file -p $(git rev-parse ref)^{tree}:path`. GraphQL TLS timeouts: retry, use `timeout N`.
- Disk full (ENOSPC) makes every shell tool fail; the watchdog still flips private on time.
- Retrigger pushes can be blocked by the auto-mode classifier after unusual git ops; get the user's explicit OK, do not work around.

## 6. A fresh coordinator: first steps

1. Read #938 (last ~60 lines) and this file; `git fetch`, confirm master, confirm repo PRIVATE, `ps` no stale watchdog.
2. `gh pr list --state open` → sort into: lane-action (DIRTY), proof-needed (UI), reviewable-now (API/tooling), held (above).
3. Open a window only when >=2 non-UI PRs are ready or a lane is blocked on a merge; arm the watchdog and verify its log line first.
4. Post MERGED/DONE lines naming unblocked lanes; close the window as soon as nothing is reviewable.
