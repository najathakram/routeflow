/**
 * Inventory guard: no production file outside the invite-token helper reads or writes the
 * plaintext `CustomerLink.inviteToken` column.
 *
 * WHY: an invite is stored as a hash (`inviteTokenHash`); the plaintext column survives only so
 * invites issued before the switch keep working until `LEGACY_INVITE_ACCEPT_UNTIL`. Every reader
 * must go through `buyer/invite-token.ts` (`findLiveInvite`, `inviteClaimWhere`,
 * `hasLiveInviteToken`) so the legacy rule lives in ONE place, and every writer that consumes or
 * revokes an invite must null BOTH columns (`clearInvite`). A direct read or write elsewhere would
 * either honour a plaintext token after the window or leave a redeemable hash behind.
 *
 * SCOPE: the identifier `inviteToken` (select / where / property / data key / argument name) in a
 * non-spec .ts file under apps/api/src, comments excluded. The match is on the bare word, so a
 * renamed local that still touches the column is caught by the column's name, not by a call shape.
 * Each allow-listed file names why it may contain the word and the exact number of occurrences, so
 * a second use added to an allowed file still fails.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

interface Allowed {
  /** Path under apps/api/src. */
  file: string;
  /** Exact number of `inviteToken` occurrences (comments excluded). */
  uses: number;
  reason: string;
}

const ALLOWED: Allowed[] = [
  {
    file: "buyer/invite-token.ts",
    uses: 11,
    reason:
      "the helper itself: the one place that reads the plaintext column (legacy lookup and claim) and that nulls both columns",
  },
  {
    file: "auth/dto/google-start.dto.ts",
    uses: 1,
    reason:
      "the request-body field of POST /auth/google/start: the token a visitor presents, not the column",
  },
  {
    file: "auth/auth.controller.ts",
    uses: 1,
    reason:
      "forwards that request-body field to the OAuth service, which keeps it server-side against the nonce",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Remove // and block comments (string-naive; good enough for this codebase's own sources). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function usesOf(file: string): number {
  const code = stripComments(fs.readFileSync(file, "utf8"));
  return (code.match(/\binviteToken\b/g) ?? []).length;
}

describe("the plaintext invite-token column is touched only by its helper", () => {
  const files = walk(SRC_ROOT);

  it("finds the source tree (guards against an empty scan)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no production file outside the allow-list mentions the column", () => {
    const allowed = new Set(ALLOWED.map((a) => a.file));
    const offenders = files
      .map((f) => ({ rel: path.relative(SRC_ROOT, f).split(path.sep).join("/"), f }))
      .filter(({ rel }) => !allowed.has(rel))
      .filter(({ f }) => usesOf(f) > 0)
      .map(({ rel, f }) => `${rel} (${usesOf(f)} use(s))`);
    expect(offenders).toEqual([]);
  });

  it.each(ALLOWED)("$file holds exactly its allowed uses ($reason)", ({ file, uses }) => {
    const full = path.join(SRC_ROOT, file);
    expect(fs.existsSync(full)).toBe(true);
    expect(usesOf(full)).toBe(uses);
  });

  it("every consumer reaches the columns through the helper", () => {
    const need: Array<[string, RegExp]> = [
      ["buyer/buyer.service.ts", /findLiveInvite\(/],
      ["buyer/buyer.service.ts", /inviteClaimWhere\(/],
      ["buyer/buyer.service.ts", /clearInvite\(/],
      ["auth/google-oauth.service.ts", /findLiveInvite\(/],
      ["auth/google-oauth.service.ts", /inviteClaimWhere\(/],
      ["auth/google-oauth.service.ts", /clearInvite\(/],
      ["customers/customers.service.ts", /issueInviteData\(/],
      ["customers/customers.service.ts", /hasLiveInviteToken\(/],
      ["customers/customers.service.ts", /clearInvite\(/],
      ["buyer/buyer-admin.service.ts", /withoutInviteSecrets\(/],
      ["buyer/buyer-admin.service.ts", /clearInvite\(/],
    ];
    for (const [file, pattern] of need) {
      const src = fs.readFileSync(path.join(SRC_ROOT, file), "utf8");
      expect({ file, found: pattern.test(src) }).toEqual({ file, found: true });
    }
  });
});
