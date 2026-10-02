import * as fs from "fs";
import * as path from "path";
import { rawMessageReads } from "./raw-message-scan";
import ALLOWLIST from "./raw-message-allowlist.json";

/**
 * B986 static pin: no non-test source under apps/web reads a server/axios message (response.data.message,
 * data.message, err.message) outside the closed allowlist `raw-message-allowlist.json`.
 *
 * It is a RATCHET: each file's count must EQUAL its allowlist entry, so removing a read without
 * lowering the entry fails too, and a new read anywhere fails. Area PRs delete their entries; the
 * entries marked `permanent` are lookups, classifications and logs that never render the text.
 */
const WEB = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "e2e", "coverage", ".turbo", "dist"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), out);
    } else if (/\.(ts|tsx)$/.test(ent.name) && !/\.(test|spec)\.(ts|tsx)$/.test(ent.name)) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

function measure(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const f of walk(WEB)) {
    const n = rawMessageReads(fs.readFileSync(f, "utf8")).length;
    if (n > 0) found[path.relative(WEB, f).split(path.sep).join("/")] = n;
  }
  return found;
}

type Entry = { count: number; why: string; permanent?: boolean };
const allow = ALLOWLIST as Record<string, Entry>;

describe("no raw server message in apps/web UI (B986 ratchet)", () => {
  const found = measure();

  it("every file with a raw message read is allowlisted at its exact count", () => {
    const bad: string[] = [];
    for (const [f, n] of Object.entries(found)) {
      if (!allow[f]) bad.push(`${f}: ${n} raw message read(s), not allowlisted`);
      else if (allow[f].count !== n)
        bad.push(
          `${f}: ${n} read(s) but the allowlist says ${allow[f].count} (lower it, never raise it)`,
        );
    }
    for (const f of Object.keys(allow))
      if (!found[f]) bad.push(`${f}: allowlisted but has no raw message read (delete the entry)`);
    expect(bad).toEqual([]);
  });

  it("every entry says why, and a permanent entry is a lookup/classification/log", () => {
    for (const [f, e] of Object.entries(allow)) {
      expect(typeof e.why === "string" && e.why.length > 8).toBe(true);
      expect(Number.isInteger(e.count) && e.count > 0).toBe(true);
      if (e.permanent) expect(e.why).toMatch(/lookup|classif|log|compar|key/i);
      expect(f).not.toMatch(/\.test\./);
    }
  });

  it("the pending (non-permanent) total only ever goes down: pinned", () => {
    const pending = Object.values(allow)
      .filter((e) => !e.permanent)
      .reduce((a, e) => a + e.count, 0);
    expect(pending).toBeLessThanOrEqual(PENDING_CEILING);
  });

  it("mutation-proof: the scanner goes red on planted raw reads and ignores comments", () => {
    expect(rawMessageReads("toast({ title: err?.response?.data?.message });")).toHaveLength(1);
    expect(rawMessageReads("toast({ description: e.message });")).toHaveLength(1);
    expect(rawMessageReads("const m = res.data.message;")).toHaveLength(1);
    expect(
      rawMessageReads("// err.message is never shown\n/* e.message */ const x = 1;"),
    ).toHaveLength(0);
    expect(rawMessageReads('const url = "https://x"; const ok = 1;')).toHaveLength(0);
  });
});

/** Set by the generator; lower it as area PRs land. */
const PENDING_CEILING = 220;
