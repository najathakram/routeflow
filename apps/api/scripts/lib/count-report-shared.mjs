/**
 * Shared helpers for the owner-run READ-ONLY production COUNT reports (W-1449):
 * report-b1461-stale-draft-tax.mjs and report-import-orphan-tenant-link.mjs.
 *
 * Counts only. Nothing here can print a slug, name, id or row content: a business is only ever
 * shown as an opaque rank ("business #1", "business #2", ...), ordered by its count, so the output
 * says how many businesses are affected and how unevenly, never which ones.
 */
/** `host:port` with every host label masked to first and last character. No user, password or db name. */
export function maskHost(url) {
  try {
    const u = new URL(url);
    const mask = (label) => (label.length <= 2 ? "**" : `${label[0]}***${label[label.length - 1]}`);
    return `${u.hostname.split(".").map(mask).join(".")}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "<unparseable>";
  }
}

/**
 * rows: [{ tenantId, n }]. Returns { noBusiness, perBusiness: [{ business: "#1", count }] }, ranked
 * by count (desc); the tenant id only breaks ties and is dropped here. A null tenantId (a row with no
 * business) is not a business: it is summed into `noBusiness`.
 */
export function toOpaqueBuckets(rows) {
  let noBusiness = 0;
  const live = [];
  for (const r of rows) {
    const n = Number(r.n);
    if (r.tenantId == null) noBusiness += n;
    else live.push({ key: String(r.tenantId), n });
  }
  live.sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1));
  return {
    noBusiness,
    perBusiness: live.map((r, i) => ({ business: `#${i + 1}`, count: r.n })),
  };
}

export function formatBuckets(label, buckets) {
  const lines = [`  ${label}`];
  if (buckets.noBusiness > 0) lines.push(`    no business link: ${buckets.noBusiness}`);
  if (buckets.perBusiness.length === 0 && buckets.noBusiness === 0) lines.push("    none");
  for (const b of buckets.perBusiness) lines.push(`    business ${b.business}: ${b.count}`);
  return lines.join("\n");
}
