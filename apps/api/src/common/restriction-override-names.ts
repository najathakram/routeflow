/**
 * Row 510: the display name of whoever overrode a restriction on a line, for a STAFF read of an order or an invoice.
 * The stamp stores the User id (`restrictionOverrideBy`, ruling Q4); a staff screen shows a name, so the read resolves it
 * once per document with ONE query and only when some line carries a stamp. A user who is gone (deleted, or never found) resolves to `null`
 * (the client shows "former user"). Never on a buyer read: a CUSTOMER principal gets nothing added (and the buyer
 * allowlists in staff-only-fields.ts would drop the key anyway, pinned by restriction-override-staff-only.spec.ts).
 */
export async function stampOverrideNames(
  db: {
    user: {
      findMany(
        args: unknown,
      ): Promise<Array<{ id: string; username: string | null; deletedAt?: Date | null }>>;
    };
  },
  lines: ReadonlyArray<{ restrictionOverrideBy?: string | null }> | null | undefined,
  viewer?: { role?: string | null } | null,
): Promise<void> {
  if (!lines || viewer?.role === "CUSTOMER") return;
  const ids = [
    ...new Set(lines.flatMap((l) => (l.restrictionOverrideBy ? [l.restrictionOverrideBy] : []))),
  ];
  if (ids.length === 0) return;
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, username: true, deletedAt: true },
  });
  // A removed user (soft-deleted, or no row at all) has no name to show: the client says "former user".
  const names = new Map(users.map((u) => [u.id, u.deletedAt ? null : (u.username ?? null)]));
  for (const line of lines) {
    if (line.restrictionOverrideBy)
      Object.assign(line, {
        restrictionOverrideByName: names.get(line.restrictionOverrideBy) ?? null,
      });
  }
}
