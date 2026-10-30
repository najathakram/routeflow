# #2873 (B909-B911) non-blocking folds, lead Opus PASS 5919633176 @a101d0e7

The sentinel-email session is no longer reachable (it isn't in ListAgents at ~22:30Z). These folds need a new owner.
Branch: fix/sentinel-followups-b909-b911 (stacked on #2854 fix/sentinel-email-render-sites @df32c18f).
Worktree: ~/code/routeflow/.claude/worktrees/sentinel-email-clean (or a new one off a101d0e7).

1. Add 3 parity rows to the api internal-email spec table: a subdomain, a trailing dot, a quoted local part.
2. Fix the comment rot: the comments must say the api keeps a local copy (the no-runtime-workspace-imports tripwire).
3. Move the JSDoc back onto refuseSentinel in email.service.ts.
4. Wrap the Resend msg/err.message in redactAddresses (email.service.ts).
Items 3 and 4 touch email.service.ts, which salvage (PC) owns: get its OK through Mac Lead before committing.
Test-first. Single-slot Mac queue: ask Mac Lead for the push slot. Lands after #2854.
A separate ticket for send()'s full-address logs (~1365-1393) was sent to the coordinator to mint.
