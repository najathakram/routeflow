#!/usr/bin/env node
// Coverage for the pure lane-lock decision in scripts/work/claim.mjs —
// everything above its "── IO" marker. Same convention as
// scripts/work/claude-hook.self-test.mjs: no fake fs/child_process, every
// export here is a pure function of its inputs.
//
// Run: node scripts/work/claim.self-test.mjs
import { canClaim, issueHoldsLane } from "./claim.mjs";
import { readFileSync as readPkgFile } from "node:fs";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}

// ── issueHoldsLane ───────────────────────────────────────────────────────
{
  const assigned = { number: 10, state: "OPEN", assignees: [{ login: "a" }] };
  const unassigned = { number: 11, state: "OPEN", assignees: [] };
  const closed = { number: 12, state: "CLOSED", assignees: [{ login: "a" }] };

  check("assigned issue, no linked PR -> holds (In progress)", issueHoldsLane(assigned, []), true);
  check(
    "assigned issue, open draft PR -> holds (In progress)",
    issueHoldsLane(assigned, [{ state: "OPEN", isDraft: true }]),
    true,
  );
  check(
    "assigned issue, open NON-draft PR -> does NOT hold (In review)",
    issueHoldsLane(assigned, [{ state: "OPEN", isDraft: false }]),
    false,
  );
  check(
    "assigned issue, one draft + one ready open PR -> does NOT hold (any ready PR releases it)",
    issueHoldsLane(assigned, [
      { state: "OPEN", isDraft: true },
      { state: "OPEN", isDraft: false },
    ]),
    false,
  );
  check(
    "assigned issue, its ready PR is now CLOSED (never merged) -> holds again",
    issueHoldsLane(assigned, [{ state: "CLOSED", isDraft: false }]),
    true,
  );
  check("unassigned issue -> never holds", issueHoldsLane(unassigned, []), false);
  check(
    "closed issue -> never holds, even with an assignee and no PR",
    issueHoldsLane(closed, []),
    false,
  );
  check(
    "closed issue -> never holds, even with a linked draft PR",
    issueHoldsLane(closed, [{ state: "OPEN", isDraft: true }]),
    false,
  );
}

// ── canClaim: lane lock wired through holdsLane ─────────────────────────
{
  const issue = { number: 20, state: "OPEN", labels: [], assignees: [] };

  check("canClaim: lane free (no holder) -> ok", canClaim(issue, []), { ok: true });
  check(
    "canClaim: holder still In progress (holdsLane true) -> refused",
    canClaim(issue, [{ number: 21, holdsLane: true }]),
    { ok: false, reason: "lane held by #21" },
  );
  check(
    "canClaim: holder's PR is In review (holdsLane false) -> ok",
    canClaim(issue, [{ number: 21, holdsLane: false }]),
    { ok: true },
  );
  check(
    "canClaim: ignores itself as a lane holder",
    canClaim(issue, [{ number: 20, holdsLane: true }]),
    { ok: true },
  );
}

// ── result ────────────────────────────────────────────────────────────────
// ── VERIFY-PIN (#2285): `npm run verify` runs this self-test ──────────────────
// Unwired, this file protects nothing (found orphaned in the #2273 sweep), so it pins its own
// place in the root verify chain, the same pattern as the F-22 self-tests' T10v/T17v (#2283).
{
  const pkg = JSON.parse(readPkgFile(new URL("../../package.json", import.meta.url), "utf8"));
  const verify = typeof pkg.scripts?.verify === "string" ? pkg.scripts.verify : "";
  check(
    "VERIFY-PIN: verify chain runs scripts/work/claim.self-test.mjs",
    verify.split("&&").some((step) => step.trim() === "node scripts/work/claim.self-test.mjs"),
    true,
  );
}

console.log(
  failures === 0 ? `\nclaim.self-test: ALL GREEN` : `\nclaim.self-test: ${failures} FAILURE(S)`,
);
process.exitCode = failures === 0 ? 0 : 1;
