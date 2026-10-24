/**
 * READ-ONLY census for B1: variant rows whose stored `variantName` (or `name`) carries their parent's name as a
 * "<Parent> - " prefix, the corruption the product page's save wrote before B1 (each edit re-prefixed it:
 * "Acme - Classic", then "Acme - Acme - Classic"). A variant stores only its own label; the display name is
 * composed at read time, so every row listed here renders with a doubled parent ("Acme - Acme - Classic").
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   railway run --service postgres node apps/api/scripts/report-variant-name-prefix.mjs
 *   ... add --json for the full machine-readable list, --tenant <tenantId> to scope it,
 *       --sample <n> for the number of truncated name samples per tenant (default 5).
 *   node apps/api/scripts/report-variant-name-prefix.mjs --self-test   (no database)
 *
 * WHICH DATABASE: the shared report resolver (scripts/lib/report-db-url.mjs, B768): the Railway proxy variables
 * win, and the target is printed (password redacted) before anything is read.
 *
 * WHAT IT PRINTS, per tenant ID (all tenants; never a slug or a business name): the variants scanned, how many
 * are COMPOSED (the name starts with "<parent name> - ") and how many are DOUBLED (that prefix appears twice in a
 * row, or the whole prefix is repeated inside the value), the affected product ids, and a few samples with each
 * name truncated to 14 characters. The match is the server normaliser's: NFC, trimmed, whitespace-collapsed and case-insensitive, whole parent name plus " - " only.
 *
 * SAFETY: the Prisma client is used only through `product.findMany` / `product.count`; the connection pool runs
 * with `default_transaction_read_only = on`; there is no write branch and no --apply flag. A source pin
 * (src/common/report-variant-name-prefix-script.spec.ts) fails the build if a write call is ever added.
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const NAME = "report-variant-name-prefix";
const SEPARATOR = " - ";
const PAGE = 2000;
const ID_CAP_TEXT = 25;

/**
 * @returns {null | "COMPOSED" | "DOUBLED"} how this variant's stored names carry the parent prefix, or null when
 * they are bare. DOUBLED wins over COMPOSED.
 */
export function classifyVariantName({ name, variantName, parentName }) {
  // Mirrors src/products/product-variant-name.ts: NFC, trimmed, whitespace-collapsed, case-insensitive, whole parent
  // name plus the " - " separator (never a partial word).
  const tokens = (parentName ?? "").normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const body = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const one = new RegExp(`^\\s*${body}\\s+-\\s+(?=\\S)`, "iu");
  const two = new RegExp(`^\\s*${body}\\s+-\\s+${body}\\s+-\\s+(?=\\S)`, "iu");
  const inner = new RegExp(`${body}\\s+-\\s+${body}\\s+-\\s+`, "iu");
  let kind = null;
  for (const raw of [variantName, name]) {
    if (typeof raw !== "string") continue;
    const value = raw.normalize("NFC");
    if (two.test(value) || inner.test(value)) return "DOUBLED";
    if (one.test(value)) kind = "COMPOSED";
  }
  return kind;
}

const clip = (v, n = 14) => {
  const s = String(v ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Group classified rows `{ tenantId, id, name, variantName, parentName, kind }` per tenant id. Samples carry
 * truncated names only; ids are complete.
 */
export function summarize(rows, sample = 5) {
  const byTenant = new Map();
  for (const r of rows) {
    const t = byTenant.get(r.tenantId) ?? {
      tenantId: r.tenantId,
      composed: 0,
      doubled: 0,
      ids: [],
      samples: [],
    };
    if (r.kind === "DOUBLED") t.doubled++;
    else t.composed++;
    t.ids.push(r.id);
    if (t.samples.length < sample)
      t.samples.push({
        id: r.id,
        kind: r.kind,
        parent: clip(r.parentName),
        variantName: clip(r.variantName),
        name: clip(r.name),
      });
    byTenant.set(r.tenantId, t);
  }
  const detail = [...byTenant.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  return {
    tenants: detail.length,
    composed: detail.reduce((n, d) => n + d.composed, 0),
    doubled: detail.reduce((n, d) => n + d.doubled, 0),
    detail,
  };
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const c = (name, variantName, parentName) =>
    classifyVariantName({ name, variantName, parentName });
  eq(c("Classic", "Classic", "Acme"), null, "bare");
  eq(c("Acme - Classic", "Acme - Classic", "Acme"), "COMPOSED", "composed");
  eq(c("Classic", "Acme - Classic", "Acme"), "COMPOSED", "composed variantName only");
  eq(c("Acme - Classic", "Classic", "Acme"), "COMPOSED", "composed name only");
  eq(c("Acme - Acme - Classic", "Acme - Acme - Classic", "Acme"), "DOUBLED", "doubled");
  eq(c("Acme - ", "Acme - ", "Acme"), null, "prefix only is not a label");
  eq(c("acme - Classic", "acme - Classic", "Acme"), "COMPOSED", "case-insensitive");
  eq(c("ACME  -  acme - Classic", "x", "Acme"), "DOUBLED", "doubled, case and spacing");
  eq(c("Acmeberry - X", "Acmeberry - X", "Acme"), null, "partial word");
  eq(c("Cool - Mint", "Cool - Mint", "Acme"), null, "other dash name");
  eq(c("Acme - Classic", "Acme - Classic", null), null, "no parent");
  const s = summarize(
    [
      {
        tenantId: "t1",
        id: "a",
        name: "n",
        variantName: "v",
        parentName: "Acme",
        kind: "COMPOSED",
      },
      { tenantId: "t1", id: "b", name: "n", variantName: "v", parentName: "Acme", kind: "DOUBLED" },
      {
        tenantId: "t2",
        id: "c",
        name: "n",
        variantName: "v",
        parentName: "Acme",
        kind: "COMPOSED",
      },
    ],
    1,
  );
  eq([s.tenants, s.composed, s.doubled], [2, 2, 1], "summary counts");
  eq(s.detail[0].ids, ["a", "b"], "ids complete");
  eq(s.detail[0].samples.length, 1, "sample cap");
  eq(clip("abcdefghijklmnopqrstuvwxyz"), "abcdefghijklmn…", "truncation");
  return "self-test ok";
}

function parseArgs(argv) {
  const known = new Set(["--json", "--tenant", "--sample", "--self-test"]);
  const out = { json: false, tenant: null, sample: 5, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--tenant" || a === "--sample") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail(`${a} needs a value`);
      if (a === "--tenant") out.tenant = v;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) fail("--sample needs a non-negative integer");
        out.sample = n;
      }
    } else if (a.startsWith("--") && !known.has(a)) fail(`unknown argument ${a}`);
    else fail(`unexpected argument ${a}`);
  }
  return out;
}

function fail(message) {
  console.error(`${NAME}: ${message}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    console.log(selfTest());
    return;
  }
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const pool = new Pool({
    connectionString: databaseUrl,
    options: "-c default_transaction_read_only=on",
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const where = {
      parentProductId: { not: null },
      ...(args.tenant ? { tenantId: args.tenant } : {}),
    };
    const scanned = await prisma.product.count({ where });
    const hits = [];
    let cursor;
    for (;;) {
      const page = await prisma.product.findMany({
        where,
        select: {
          id: true,
          tenantId: true,
          name: true,
          variantName: true,
          parent: { select: { name: true } },
        },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const p of page) {
        const kind = classifyVariantName({
          name: p.name,
          variantName: p.variantName,
          parentName: p.parent?.name,
        });
        if (kind)
          hits.push({
            tenantId: p.tenantId,
            id: p.id,
            name: p.name,
            variantName: p.variantName,
            parentName: p.parent?.name,
            kind,
          });
      }
      if (page.length < PAGE) break;
      cursor = page[page.length - 1].id;
    }
    const report = { scannedVariants: scanned, ...summarize(hits, args.sample) };
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `${NAME}: scanned ${scanned} variant(s); ${report.composed} composed, ${report.doubled} doubled, across ${report.tenants} tenant(s)`,
    );
    for (const d of report.detail) {
      console.log(`  tenant ${d.tenantId}: ${d.composed} composed, ${d.doubled} doubled`);
      const shown = d.ids.slice(0, ID_CAP_TEXT).join(", ");
      const more =
        d.ids.length > ID_CAP_TEXT ? ` (+${d.ids.length - ID_CAP_TEXT} more; use --json)` : "";
      console.log(`    ids: ${shown}${more}`);
      for (const s of d.samples)
        console.log(
          `    sample ${s.id} [${s.kind}] parent "${s.parent}" variantName "${s.variantName}" name "${s.name}"`,
        );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await pool.end().catch(() => {});
  }
}

/** True when this module is the process entry point (not imported by a spec). */
export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    let r = p;
    try {
      r = realpathSync(p);
    } catch {
      // keep the path as given
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return (
    norm(entry) === norm(self) || basename(entry).toLowerCase() === basename(self).toLowerCase()
  );
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
