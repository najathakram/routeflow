#!/usr/bin/env node
// W-767 (SA-908, SA-917) census: which routes a SUPER_ADMIN, or a staff-token CUSTOMER, used with NO business in the
// session, from the deploy logs of the DARK TenantRequiredInterceptor. READ-ONLY: it reads log files you exported and prints a table. It never connects
// to a database, never calls Railway, and writes nothing.
//
//   railway logs --service @routeflow/api > api.log      (the owner/lead exports; this script never runs railway)
//   node apps/api/scripts/report-tenantless-writes.mjs api.log [more.log ...]
//   ... | node apps/api/scripts/report-tenantless-writes.mjs -          ("-" reads stdin)
//
// The interceptor logs each route ONCE per process, so a count is "processes that saw it", not request volume. The
// route SET is what the flip needs:
//   - every WRITE listed must move to impersonation ("act as") or get `@PlatformScoped()` (taking its tenant explicitly)
//     before TENANT_REQUIRED_MODE flips to "enforced" in its own diff;
//   - CUSTOMER writes (SA-917) are measured only: the census decides whether they are refused, in the same flip diff;
//   - READS are listed for SA-908 item 4's second row, never refused by this card. Check each for a side effect: a GET
//     that WRITES is outside the non-GET rule (SA-917 LOW) and belongs in that row.
// Exit 0 always (a report, not a gate); exit 2 on a usage or read error.
import { readFileSync } from "node:fs";

const LINE =
  /\[tenant-required\] (would-deny|tenantless-read|tenantless-customer-write) (\S+) (\S+)/;

function tally(text) {
  const writes = new Map();
  const reads = new Map();
  const customers = new Map();
  const into = {
    "would-deny": writes,
    "tenantless-read": reads,
    "tenantless-customer-write": customers,
  };
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const key = `${m[2]} ${m[3]}`;
    into[m[1]].set(key, (into[m[1]].get(key) ?? 0) + 1);
  }
  return { writes, reads, customers };
}

function table(title, map) {
  const rows = [...map].sort(([a], [b]) => a.localeCompare(b));
  const out = [
    `## ${title} (${rows.length})`,
    "",
    "| Route | Processes that logged it |",
    "|---|---|",
  ];
  for (const [route, n] of rows) out.push(`| \`${route}\` | ${n} |`);
  if (rows.length === 0) out.push("| (none) | - |");
  return out.join("\n");
}

function main(argv) {
  const files = argv.slice(2);
  if (files.length === 0 || files.includes("--help")) {
    process.stderr.write("usage: report-tenantless-writes.mjs <log-file>... | -   (read-only)\n");
    return 2;
  }
  let text = "";
  try {
    for (const f of files) text += readFileSync(f === "-" ? 0 : f, "utf8") + "\n";
  } catch (err) {
    process.stderr.write(`report-tenantless-writes: cannot read logs: ${err.message}\n`);
    return 2;
  }
  const { writes, reads, customers } = tally(text);
  process.stdout.write(
    [
      "# Tenantless routes (W-767 census, read-only)",
      "",
      table("SUPER_ADMIN writes the enforced rule would refuse", writes),
      "",
      table("Staff-token CUSTOMER writes with no business (measured only; SA-917)", customers),
      "",
      table(
        "SUPER_ADMIN reads (listed only; SA-908 item 4; flag any that write, SA-917 LOW)",
        reads,
      ),
      "",
    ].join("\n"),
  );
  return 0;
}

process.exitCode = main(process.argv);
