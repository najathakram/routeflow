/**
 * The PR ledger on the state branch (spec 5.5): `derived/prs.jsonl`, append-only, written only by
 * the server, one batch (one commit) per tick that has new rows.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { LedgerRow } from "../domain/prs";
import { MAX_LINE_BYTES } from "../domain/schema";
import { denylistAvailable, denylistHit } from "../sources/denylist";
import { CTL_IDENTITY, CtlError, cloneTimeoutMs, git, gitTry } from "../sources/git";
import type { Env } from "../sources/git";
import { withLock } from "../sources/lock";
import { ensureClone, lockDirOf, syncClone } from "../sources/state-branch";
import { canonicalJson } from "./assemble";

export const LEDGER_FILE = path.join("derived", "prs.jsonl");

/** Parse the ledger of a checkout; unreadable or malformed lines are skipped. */
export function readLedger(clone: string): LedgerRow[] {
  let text = "";
  try {
    text = fs.readFileSync(path.join(clone, LEDGER_FILE), "utf8");
  } catch {
    return [];
  }
  const out: LedgerRow[] = [];
  for (const l of text.split("\n")) {
    if (l.trim() === "") continue;
    try {
      const v = JSON.parse(l) as LedgerRow;
      if (v && typeof v === "object" && Number.isSafeInteger(v.pr) && typeof v.at === "string") {
        out.push(v);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

const REDACTED = "[redacted]";

/** Redact every string field the denylist flags (the row is kept) and enforce the line cap. */
export function sanitizeRow(row: LedgerRow): LedgerRow {
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") return denylistHit(JSON.stringify({ v })) ? REDACTED : v;
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x)]),
      );
    }
    return v;
  };
  let out = scrub(row) as LedgerRow;
  const size = (r: LedgerRow): number => Buffer.byteLength(JSON.stringify(r));
  if (size(out) > MAX_LINE_BYTES) {
    const areas = [...out.areas];
    while (areas.length > 0 && size({ ...out, areas }) > MAX_LINE_BYTES) areas.pop();
    out = { ...out, areas };
  }
  if (size(out) > MAX_LINE_BYTES) out = { ...out, headRef: REDACTED };
  return out;
}

const sig = (r: LedgerRow): string => {
  const { at: _at, ...rest } = r;
  void _at;
  return canonicalJson(rest);
};

/** Append `rows` (those not already the last row of their PR) in one commit; throws on failure. */
export async function appendLedger(env: Env, rows: LedgerRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  if (!denylistAvailable()) throw new CtlError(4, "denylist unavailable: ledger not written");
  rows = rows.map(sanitizeRow);
  const clone = await ensureClone(env);
  return withLock(lockDirOf(clone), 30_000, () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      syncClone(env, clone);
      const last = new Map<number, string>();
      for (const r of readLedger(clone)) last.set(r.pr, sig(r));
      const fresh: LedgerRow[] = [];
      for (const r of rows) {
        if (last.get(r.pr) === sig(r)) continue;
        last.set(r.pr, sig(r));
        fresh.push(r);
      }
      if (fresh.length === 0) return 0;
      const file = path.join(clone, LEDGER_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let cur = "";
      try {
        cur = fs.readFileSync(file, "utf8");
      } catch {
        /* first write */
      }
      if (cur !== "" && !cur.endsWith("\n")) cur += "\n";
      fs.writeFileSync(file, cur + fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
      git(clone, ["add", "--", LEDGER_FILE]);
      git(clone, [
        ...CTL_IDENTITY,
        "commit",
        "-q",
        "--no-verify",
        "-m",
        `ctl(server): ledger +${fresh.length}`,
      ]);
      const b = env.stateBranch;
      const pushed = gitTry(clone, ["push", "-q", "origin", `HEAD:refs/heads/${b}`], {
        timeoutMs: cloneTimeoutMs(),
      });
      if (pushed.ok) return fresh.length;
      gitTry(clone, ["reset", "-q", "--hard", `refs/remotes/origin/${b}`]);
      if (!/non-fast-forward|fetch first|rejected/.test(pushed.err)) {
        throw new CtlError(5, pushed.err.trim().slice(0, 200));
      }
    }
    throw new CtlError(5, "ledger push exhausted");
  });
}
