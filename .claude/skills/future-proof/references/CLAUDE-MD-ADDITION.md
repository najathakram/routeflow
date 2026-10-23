# CLAUDE.md addition for the lead's close-out commit

CLAUDE.md is edited only in a close-out commit, never mid-session. Paste the block below into the
project `CLAUDE.md` as a new section, directly after "## Lessons learned routine". Paste it verbatim:
one heading and one paragraph, about 1.2 KB.

---

## Design Gate (owner R19)

Every spec, fix ruling and design ruling carries a filled `## Design Gate` block from the
[`future-proof`](.claude/skills/future-proof/SKILL.md) skill before review or build. **Full** is for
features, new models and money/auth/tenancy/schema work; **Lite** is for small or one-area work
(bug-pipeline `cause-ruling.md`, a PR body); **Hotfix** is for a P0, with a dated follow-up. The gate
covers: program-map fit, with facts at a pinned sha; an area sweep (fix the area's open items
together, each issue its own commit and red test); a variation map across business types and scale
(BUILD NOW / SEAM NOW / LATER); replace-later; one helper plus an inventory pin; data and time; scale;
the apple-ux lens; change-friendliness, with expected diff sizes; cost and stop; and owner questions,
batched at planning. `node .claude/skills/future-proof/scripts/check-gate.mjs <spec>` must pass before
the lead dispatches a review, and the reviewer returns `GATE: PASS | FAIL`. A PR without a gate
reference is a BLOCK. On dev-pipeline and bug-pipeline routes the routing hook prints "Design Gate
required". Stop-hook Gate 6 warns when a feat/* or fix/* branch has code but no gate; it is dark and
never blocks.
