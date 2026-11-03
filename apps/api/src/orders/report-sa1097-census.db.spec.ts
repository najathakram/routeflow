/**
 * SA-1097 read-only census (apps/api/scripts/report-sa1097-stored-line-pack-census.mjs) against real Postgres: seeds one line of
 * each class under a throwaway `qa-sa1097census-<run>` tenant and proves the census counts exactly those (run before and after,
 * the delta is the seed - the script has no tenant flag by design). The script is run as a child process on this lane's
 * loopback database. Also proves it wrote nothing (the seeded rows are byte-equal after).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SCRIPT = path.resolve(__dirname, "../../scripts/report-sa1097-stored-line-pack-census.mjs");
const RUN = randomUUID().slice(0, 8);

describeDb("SA-1097 census counts one seeded line of each class, real Postgres", () => {
  let prisma: PrismaService;
  let tenantId = "";

  const census = () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, CENSUS_DATABASE_URL: requireLocalDatabaseUrl() },
      timeout: 120_000,
    });
    if (r.status !== 0) throw new Error(`census exit ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };

  beforeAll(async () => {
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    const slug = assertTestTenant(`qa-sa1097census-${RUN}`, "report-sa1097-census.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `census ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    const where = { where: { tenantId } };
    await (prisma as any).orderRevision?.deleteMany(where).catch(swallow);
    await prisma.orderItem.deleteMany(where).catch(swallow);
    await prisma.order.deleteMany(where).catch(swallow);
    await prisma.product.deleteMany(where).catch(swallow);
    await prisma.customer.deleteMany(where).catch(swallow);
    await prisma.user.deleteMany(where).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma?.$disconnect();
  }, 120_000);

  it("counts a 12-pack line, a no-pack line, two 0-box lines and the re-stamped line in the edit history - and writes nothing", async () => {
    const before = census();
    const user = await prisma.user.create({
      data: { email: `c-${RUN}@example.invalid`, username: `c-${RUN}`, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "c", contactName: "c", tenantId },
    });
    const mk = async (
      label: string,
      line: { qty: number; boxes: number; pieces: number; subtotal: number; snapshot?: number },
    ) => {
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `Acme ${label} ${RUN}`,
          unit: "case",
          pricePerUnit: 10,
          unitsPerBox: 24,
        } as any,
      });
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          status: "PENDING",
          orderNumber: `ORD-C-${RUN}-${label}`,
          subtotal: line.subtotal,
          tax: 0,
          total: line.subtotal,
        } as any,
      });
      await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty: line.qty,
          boxes: line.boxes,
          pieces: line.pieces,
          ...(line.snapshot ? { unitsPerBox: line.snapshot } : {}),
          unitPrice: 10,
          subtotal: line.subtotal,
        } as any,
      });
      return { order, product };
    };
    await mk("own12", { qty: 120, boxes: 10, pieces: 0, subtotal: 100 }); // own pack 12, live 24: exposed
    await mk("nopack", { qty: 10, boxes: 10, pieces: 0, subtotal: 100 }); // sold with no pack, live 24: exposed
    await mk("zerofit", { qty: 6, boxes: 0, pieces: 6, subtotal: 2.5 }); // 0-box, fits the live 24: not exposed
    await mk("zerobad", { qty: 6, boxes: 0, pieces: 6, subtotal: 7 }); // 0-box, fits neither: refused
    await mk("snap", { qty: 120, boxes: 10, pieces: 0, subtotal: 100, snapshot: 12 }); // has a snapshot: not counted
    const hit = await mk("hist", { qty: 120, boxes: 10, pieces: 0, subtotal: 100, snapshot: 24 });
    const lineOf = (o: object) => ({
      productId: hit.product.id,
      status: "PENDING",
      qty: 120,
      unitPrice: 10,
      ...o,
    });
    await (prisma as any).orderRevision.createMany({
      data: [
        {
          tenantId,
          orderId: hit.order.id,
          revisionNumber: 1,
          snapshot: {
            lineItems: [lineOf({ boxes: 10, pieces: 0, unitsPerBox: null, subtotal: 100 })],
          },
        },
        {
          tenantId,
          orderId: hit.order.id,
          revisionNumber: 2,
          snapshot: { lineItems: [lineOf({ boxes: 5, pieces: 0, unitsPerBox: 24, subtotal: 50 })] },
        },
      ],
    });
    const rowsBefore = JSON.stringify(
      await prisma.orderItem.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    );

    const after = census();
    const d = (k: string) => after.lines.total[k] - before.lines.total[k];
    expect(d("storedSplitNoSnapshot")).toBe(4); // own12, nopack, zerofit, zerobad (snap and hist carry a snapshot)
    expect(d("exposed")).toBe(2); // own12 (12 vs 24) and nopack (none vs 24)
    expect(d("ownPackDiffersLive")).toBe(1);
    expect(d("soldWithNoPack")).toBe(1);
    expect(d("zeroBox")).toBe(2);
    expect(d("wouldRefuse")).toBe(1);
    const h = (k: string) => after.editHistory[k] - before.editHistory[k];
    expect(h("revisionPairsExamined")).toBe(1);
    expect(h("linesExamined")).toBe(1);
    expect(h("restampedAtOtherPack")).toBe(1);
    expect(h("moneyMoved")).toBe(1);
    expect(
      JSON.stringify(
        await prisma.orderItem.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
      ),
    ).toBe(rowsBefore);
    // counts only: nothing of the seed's names or ids reaches the output
    expect(JSON.stringify(after)).not.toContain(RUN);
  }, 120_000);
});
