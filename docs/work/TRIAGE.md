# Triage: turning a loose ask into a placed ticket

The triage agent follows these steps. It runs on a schedule, a few times a day, and whenever the lead
asks. Its input is every open issue with `needs-triage`, oldest first.

For each issue:

1. **Duplicate check.** Search open and recently closed issues and PRs for the same problem (title
   words, the screen or endpoint, the bug id). If one exists: comment `Duplicate of #N`, close it as
   not planned, and stop.
2. **Understand it.** Read `.claude/code-map/INDEX.md` and the one area file it points to, then the
   specific source file. Read `.claude/lessons/LESSONS-DIGEST.md` for lessons in that area. Never
   guess a file path. Cite the files you actually opened.
3. **Classify.**
   - `kind:*`: bug (something behaves wrong), feature (new capability), customization (an existing
     feature adjusted for one customer), chore or migration.
   - `sev:*` for bugs, by impact: critical = money or data loss, or an outage; high = a wrong result
     with a workaround; medium = degraded; low = cosmetic.
   - `lane:*`: the file area the change will live in (see docs/work/WORKFLOW.md).
   - `tier1` when it touches money, tenancy or a migration.
4. **Prioritize** with the severity × urgency table in WORKFLOW.md. Urgency is "now" when a customer
   is hitting it or it blocks a release.
5. **Place it.** Set the milestone to the release it belongs to. A P0 goes to the lead immediately
   (comment `@najathakram P0:` plus one line). A feature that would push planned work out of its
   release is **not** placed silently: comment the trade-off and leave `needs-triage` for the owner.
6. **Make it workable.** Edit the issue body into:
   - **Problem / goal:** two or three sentences.
   - **Acceptance criteria:** a checklist; each item is observable.
   - **Where:** the files and functions involved.
   - **Test plan:** the specs to add (Jest / DB spec / Playwright at 390, 768 and 1440 for UI).
   - **Notes:** lessons that apply (ids) and related issues.

   Keep the asker's original words at the bottom under **Original ask**.

7. **Split** a feature bigger than one PR into sub-issues, each placeable on its own.
8. **Finish.** Remove `needs-triage`. Uncertain on any field? Keep `needs-triage`, and comment one
   specific question for the owner.

Never put client names, tenant ids, credentials or production data in an issue (issues go public
during CI windows). Never assign workers. Claiming is theirs (`npm run work:claim`).
