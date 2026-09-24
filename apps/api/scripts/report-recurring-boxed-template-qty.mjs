/**
 * report-recurring-boxed-template-qty.mjs — B646 / SA-135a PRE-LANDING gate. READ-ONLY.
 *
 * Templates whose qty looks like PIECES on a boxed product; each cycle billed qty x per-box price.
 *
 * Lists every ACTIVE recurring template line for a boxed product (unitsPerBox > 1, no selling-unit
 * label), per tenant id, with:
 *   (i)  possible PAST over-billing: a pieces-intent line (qty > unitsPerBox, or a non-integer qty) was
 *        billed qty x the per-box price on every cycle; `possibleOverbillPerCycle` is that figure minus
 *        what it would be if qty meant pieces;
 *   (ii) the FUTURE stock change the B646 fix introduces: pieces decremented per cycle today
 *        (`currentDecrementPieces`, qty stored in the pieces column) vs after the fix
 *        (`postFixDecrementPieces`, qty x unitsPerBox). A pieces-intent template must be corrected
 *        (qty / unitsPerBox) BEFORE the fix's first cycle runs on it.
 * The fix never changes the billed amount (pinned in recurring-invoices.boxed-lines.spec.ts).
 *
 * The owner runs it on prod BEFORE B646 lands. Output carries tenant, template and item ids and numbers
 * only: never a slug, name, SKU or description.
 *
 * NEVER writes anything: there is deliberately no --execute flag and no write branch.
 *
 * Run locally (DATABASE_URL from your env / docker-compose):
 *   node apps/api/scripts/report-recurring-boxed-template-qty.mjs [--json]
 * Run against prod via the Railway postgres proxy:
 *   railway run --service postgres node apps/api/scripts/report-recurring-boxed-template-qty.mjs
 * Optional env: REPORT_TENANT_ID=<uuid> scopes to one tenant.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
import { classifyTemplateLine, summarizeByTenant } from "./lib/recurring-boxed-template-qty.mjs";

const databaseUrl = resolveReportDbUrl("report-recurring-boxed-template-qty");
if (!databaseUrl) process.exit(2);
const pool = new Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const tenantId = process.env.REPORT_TENANT_ID || undefined;
  const items = await prisma.recurringInvoiceItem.findMany({
    where: {
      productId: { not: null },
      recurringInvoice: { isActive: true, ...(tenantId ? { tenantId } : {}) },
    },
    select: {
      id: true,
      productId: true,
      qty: true,
      unitPrice: true,
      unitLabel: true,
      tenantId: true,
      recurringInvoiceId: true,
      product: { select: { unitsPerBox: true } },
    },
  });
  const rows = [];
  for (const it of items) {
    const c = classifyTemplateLine({
      productId: it.productId,
      qty: it.qty,
      unitPrice: it.unitPrice,
      unitLabel: it.unitLabel,
      unitsPerBox: it.product?.unitsPerBox ?? null,
    });
    if (c)
      rows.push({
        tenantId: it.tenantId,
        templateId: it.recurringInvoiceId,
        itemId: it.id,
        ...c,
      });
  }
  const summary = summarizeByTenant(rows);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(
    `B646 pre-landing report: ${rows.length} boxed template line(s) across ${summary.length} tenant(s); READ-ONLY.`,
  );
  for (const t of summary) {
    console.log(
      `\ntenant ${t.tenantId}: ${t.lines} line(s), ${t.flagged} flagged; stock delta per cycle +${t.stockDeltaPerCycle} pieces; possible over-bill per cycle $${t.possibleOverbillPerCycle}`,
    );
    for (const r of t.rows) {
      console.log(
        `  ${r.flagged ? "FLAG" : "ok  "} template ${r.templateId} item ${r.itemId}: qty ${r.qty} of a ${r.unitsPerBox}-pack @ $${r.unitPrice}` +
          ` | billed/cycle $${r.billedPerCycle} (pieces-intent $${r.billedIfPiecesIntent})` +
          ` | stock/cycle ${r.currentDecrementPieces} -> ${r.postFixDecrementPieces} pieces` +
          (r.reasons.length ? ` [${r.reasons.join(", ")}]` : ""),
      );
    }
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
