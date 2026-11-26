/**
 * W-1464 (SA-1538 PR-A): the mail wall for Test-class businesses.
 *
 * A business whose class is TEST may mail only the addresses on its allowed list. The list is one
 * PlatformConfig row per business (JSON array of entries). This file holds the pure rules and the
 * two store functions; the check itself sits beside `refuseSentinel` at both public send entries of
 * EmailService. Nothing here reads a slug or a name: class and list only.
 */
import type { PrismaService } from "../prisma/prisma.service";

/** One tester team, not a mailing list. */
export const MAIL_WALL_MAX_ENTRIES = 20;

/** The coded reason a held send carries; the web maps it to its own words (no server text on the client). */
export const MAIL_WALL_HOLD_CODE = "MAIL_WALL_HELD" as const;

/** The log-only code word for the dark step (a Test business with no list yet). */
export const MAIL_WALL_WOULD_HOLD = "would hold" as const;

export const mailWallKey = (tenantId: string): string => `mail.wall.${tenantId}`;

/** `name@domain` or `name+*@domain` (plus-addressing). Never a bare domain, never a wildcard domain. */
const ENTRY_RE = /^[a-z0-9._%-]+(\+\*|\+[a-z0-9._%-]+)?@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Lower-case, trimmed entry, or null when it is not one of the two allowed forms. */
export function normalizeMailWallEntry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length === 0 || v.length > 254) return null;
  return ENTRY_RE.test(v) ? v : null;
}

/** What a stored value reads as: `absent` (no row), `unreadable` (a row we cannot trust), or the entries. */
export type MailWallRead =
  { kind: "absent" } | { kind: "unreadable" } | { kind: "list"; entries: string[] };

export function parseMailWallValue(value: string | null | undefined): MailWallRead {
  if (value === null || value === undefined) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { kind: "unreadable" };
  }
  if (!Array.isArray(parsed) || parsed.length > MAIL_WALL_MAX_ENTRIES) {
    return { kind: "unreadable" };
  }
  const entries: string[] = [];
  for (const raw of parsed) {
    const e = normalizeMailWallEntry(raw);
    if (!e) return { kind: "unreadable" };
    entries.push(e);
  }
  return { kind: "list", entries };
}

/** One `@`, and no whitespace, comma, semicolon, angle bracket, quote, parenthesis or backslash. */
export function isSinglePlainAddress(to: string): boolean {
  return /^[^@\s,;<>"'()\\]+@[^@\s,;<>"'()\\]+$/.test(to);
}

/** Exact match on the lower-cased address; an entry `name+*@domain` also matches `name+anything@domain`. */
export function mailWallAllows(entries: readonly string[], to: string): boolean {
  // The wall never relies on upstream validation: anything that is not exactly one plain address is held.
  if (!isSinglePlainAddress(to)) return false;
  const addr = to.toLowerCase();
  return entries.some((entry) => {
    if (entry === addr) return true;
    const star = entry.indexOf("+*@");
    if (star < 0) return false;
    const local = entry.slice(0, star);
    const domain = entry.slice(star + 3);
    const at = addr.lastIndexOf("@");
    if (at < 0 || addr.slice(at + 1) !== domain) return false;
    const addrLocal = addr.slice(0, at);
    return addrLocal.startsWith(`${local}+`) && addrLocal.length > local.length + 1;
  });
}

export type WallDecision = "allow" | "hold" | "would-hold";

/**
 * The rule. Only a TEST class is ever walled. A list that exists holds anything not on it; a list
 * that cannot be read holds (fail closed); no list is the dark step (log only, send as today).
 */
export function decideRecipientWall(opts: {
  klass: string;
  list: MailWallRead;
  to: string;
}): WallDecision {
  if (opts.klass !== "TEST") return "allow";
  if (opts.list.kind === "absent") return "would-hold";
  if (opts.list.kind === "unreadable") return "hold";
  return mailWallAllows(opts.list.entries, opts.to) ? "allow" : "hold";
}

// ─── Store (PlatformConfig, raw like PlatformConfigService: the table is not tenant-scoped) ───

export async function readMailWall(prisma: PrismaService, tenantId: string): Promise<MailWallRead> {
  const key = mailWallKey(tenantId);
  const rows = await prisma.$queryRaw<{ value: string }[]>`
    SELECT value FROM "PlatformConfig" WHERE key = ${key} LIMIT 1
  `;
  return parseMailWallValue(rows[0]?.value ?? null);
}

/** Replaces the list. An empty list removes the row (back to the dark step). Returns the stored entries. */
export async function writeMailWall(
  prisma: PrismaService,
  tenantId: string,
  entries: readonly string[],
): Promise<string[]> {
  const key = mailWallKey(tenantId);
  const clean = [...new Set(entries.map((e) => normalizeMailWallEntry(e)))].filter(
    (e): e is string => e !== null,
  );
  if (clean.length === 0) {
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = ${key}`;
    return [];
  }
  const value = JSON.stringify(clean);
  await prisma.$executeRaw`
    INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
      VALUES (gen_random_uuid()::text, ${key}, ${value}, now())
    ON CONFLICT ("key")
      DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()
  `;
  return clean;
}
