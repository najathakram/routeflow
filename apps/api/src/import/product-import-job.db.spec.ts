/**
 * SA-823 section 5 (row 655, R7a PR-2 fold cc3cb510d): a regrouping product-import apply over
 * IMPORT_FAMILY_SYNC_MAX_ROWS is queued on a REAL Bull queue (Redis) and processed by the REAL
 * ProductImportProcessor. The queued apply returns {queued:{jobId}}; the job completes with the same counts a
 * synchronous apply of an equal file gives; the job's status is tenant-scoped (another tenant's id is a 404).
 *
 * Needs Postgres AND Redis: set REDIS_URL (local, e.g. redis://127.0.0.1:6390). CI's DB lane runs Postgres only, so
 * without REDIS_URL this suite is skipped there. The base jest config mocks `ioredis`, so Bull gets the real
 * client through `createClient` (jest.requireActual). The queue uses a run-unique prefix and is emptied in afterAll.
 * Throwaway `qa-famjob*` tenants. Collected only by jest.db.config.js.
 */
import type { Queue } from "bull";
import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { ImportService } from "./import.service";
import { ProductFamilyImportService } from "./product-family-import.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { ProductFamiliesService } from "../products/product-families.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { MeterService } from "../billing/meter.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

import { ProductImportJobService } from "./product-import-job.service";
import { ProductImportProcessor } from "./product-import.processor";
import {
  IMPORT_FAMILY_SYNC_MAX_ROWS,
  PRODUCT_IMPORT_QUEUE,
  type ProductImportJobData,
} from "./product-import-job";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Bull = require("bull");
// The base jest config maps `ioredis` to a mock for every lane; this suite needs the real client.
// A subpath, because moduleNameMapper (`^ioredis$`) applies to jest.requireActual too.
const ioredisActual = jest.requireActual("ioredis/built/index.js");
const RealRedis = ioredisActual.default ?? ioredisActual.Redis ?? ioredisActual;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = `FJ${randomUUID().slice(0, 8)}`;
const REDIS_URL = process.env.REDIS_URL;
const describeQueue = REDIS_URL ? describeDb : describe.skip;

describeQueue(
  "SA-823 §5: a large family-import apply runs as a real Bull job (Postgres + Redis)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let importService: ImportService;
    let queue: Queue<ProductImportJobData>;
    let jobs: ProductImportJobService;
    let tenantId: string;
    let otherTenantId: string;
    const pricingMode = "off";
    const N = IMPORT_FAMILY_SYNC_MAX_ROWS + 1;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      const host = new URL(REDIS_URL as string).hostname;
      if (!["127.0.0.1", "localhost", "::1"].includes(host))
        throw new Error(`refusing a non-local Redis (${host})`);
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const slug = assertTestTenant(`qa-${RUN.toLowerCase()}`, "product-import-job.db.spec.ts");
      const otherSlug = assertTestTenant(
        `qa-${RUN.toLowerCase()}-b`,
        "product-import-job.db.spec.ts",
      );
      tenantId = (await prisma.tenant.create({ data: { slug, name: `SA-823 ${slug}` } })).id;
      otherTenantId = (
        await prisma.tenant.create({ data: { slug: otherSlug, name: `SA-823 ${otherSlug}` } })
      ).id;
      queue = new Bull(PRODUCT_IMPORT_QUEUE, {
        prefix: `qa-${RUN}`,
        createClient: (type: string) =>
          new RealRedis(
            REDIS_URL as string,
            type === "client" ? {} : { enableReadyCheck: false, maxRetriesPerRequest: null },
          ),
      });
      jobs = new ProductImportJobService(queue as never, prisma);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ImportService,
          ProductFamilyImportService,
          ProductFamiliesService,
          NumberingService,
          ExternalRefService,
          ProductsService,
          CustomersService,
          AuditService,
          { provide: ProductImportJobService, useValue: jobs },
          { provide: PrismaService, useValue: prisma },
          {
            provide: FeatureConfigService,
            useValue: { getEffectiveMode: jest.fn(async () => pricingMode) },
          },
          { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(true) } },
          { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
          {
            provide: SellingRestrictionsService,
            useValue: {
              checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
            },
          },
          { provide: StorageService, useValue: {} },
          { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          {
            provide: EntitlementsService,
            useValue: {
              hasFlag: jest.fn(async (_t: string, k: string) => k !== "flag.units_prices_v2"),
            },
          },
          { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
          {
            provide: RouteFlowGateway,
            useValue: { emitProductUpdated: jest.fn(), emitCatalogChanged: jest.fn() },
          },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
          { provide: MeterService, useValue: { read: jest.fn().mockResolvedValue(0) } },
          { provide: CommissionEngineService, useValue: {} },
          { provide: RegulatedLedgerService, useValue: { reverseInvoiceEntries: jest.fn() } },
          { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();
      importService = module.get(ImportService);
      const processor = new ProductImportProcessor(importService, tenantCtx);
      void queue.process("apply", (job: unknown) => processor.handle(job as never));
    }, 120_000);

    afterAll(async () => {
      await queue?.obliterate({ force: true }).catch(() => {});
      await queue?.close().catch(() => {});
      for (const t of [tenantId, otherTenantId].filter(Boolean)) {
        await prisma.auditLog.deleteMany({ where: { tenantId: t } }).catch(() => {});
        await prisma.product
          .deleteMany({ where: { tenantId: t, parentProductId: { not: null } } })
          .catch(() => {});
        await prisma.product.deleteMany({ where: { tenantId: t } }).catch(() => {});
        await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
      }
      await prisma?.$disconnect();
    }, 120_000);

    /** N standalone products and a file that regroups all of them under one new family. */
    async function regroupFile(tag: string): Promise<string> {
      const lines: string[] = [];
      for (let i = 0; i < N; i++) {
        await prisma.product.create({
          data: {
            tenantId,
            name: `${RUN} ${tag} ${i}`,
            sku: `${RUN}-${tag}${i}`,
            unit: "each",
            pricePerUnit: "5.00",
            currentStock: 40,
          } as never,
        });
        lines.push(`,${RUN}-${tag}${i},,${RUN} ${tag} Family,V${i}`);
      }
      return `Item Name,SKU,Rate,Family,Variant Name\n${lines.join("\n")}\n`;
    }
    const counts = (r: any) => ({
      created: r.created,
      updated: r.updated,
      unchanged: r.unchanged,
      skipped: r.skipped,
      grouped: r.families?.grouped,
      newVariants: r.families?.newVariants,
      moves: r.families?.moves,
      familiesToCreate: (r.families?.familiesToCreate ?? []).map((f: any) => f.rows),
    });
    async function waitDone(jobId: string) {
      const deadline = Date.now() + 240_000;
      for (;;) {
        const s = await tenantCtx.run(tenantId, () => jobs.status(jobId));
        if (s.state === "done" || s.state === "failed") return s;
        if (Date.now() > deadline) throw new Error(`job ${jobId} still ${s.state}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    it(`REG: a ${N}-row regroup apply returns {queued:{jobId}}, and the real processor completes it with the sync counts`, async () => {
      const queuedFile = await regroupFile("Q");
      const syncFile = await regroupFile("S");

      const q: any = await tenantCtx.run(tenantId, () =>
        importService.importProducts(Buffer.from(queuedFile), "user-1", {
          fileName: "fam-q.csv",
          allowBackground: true,
        }),
      );
      expect(q.queued).toEqual({ jobId: expect.any(String), rows: N });
      // nothing is regrouped by the request itself
      expect(await prisma.product.count({ where: { tenantId, kind: "FAMILY" } })).toBe(0);

      const s = await waitDone(q.queued.jobId);
      expect(s.error).toBeUndefined();
      expect(s.state).toBe("done");
      expect(s.progress).toBe(100);

      const sync: any = await tenantCtx.run(tenantId, () =>
        importService.importProducts(Buffer.from(syncFile), "user-1", { fileName: "fam-s.csv" }),
      );
      expect(sync.queued).toBeUndefined();
      expect(counts(s.result)).toEqual(counts(sync));
      expect(counts(sync)).toMatchObject({ updated: N, skipped: 0, grouped: N, moves: 0 });
      expect(await prisma.product.count({ where: { tenantId, kind: "FAMILY" } })).toBe(2);
      expect(
        await prisma.product.count({
          where: { tenantId, kind: "VARIANT", parentProductId: { not: null } },
        }),
      ).toBe(2 * N);
    }, 300_000);

    it("REG: the job status is tenant-scoped: another tenant's id is a 404, and an unknown id is a 404", async () => {
      const lines = Array.from({ length: N }, (_, i) => `,${RUN}-T${i},,${RUN} T Family,V${i}`);
      for (let i = 0; i < N; i++) {
        await prisma.product.create({
          data: {
            tenantId,
            name: `${RUN} T ${i}`,
            sku: `${RUN}-T${i}`,
            unit: "each",
            pricePerUnit: "5.00",
          } as never,
        });
      }
      const q: any = await tenantCtx.run(tenantId, () =>
        importService.importProducts(
          Buffer.from(`Item Name,SKU,Rate,Family,Variant Name\n${lines.join("\n")}\n`),
          "user-1",
          { fileName: "fam-t.csv", allowBackground: true },
        ),
      );
      const jobId: string = q.queued.jobId;
      await expect(tenantCtx.run(otherTenantId, () => jobs.status(jobId))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(tenantCtx.run(tenantId, () => jobs.status("999999999"))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect((await waitDone(jobId)).state).toBe("done");
    }, 300_000);
  },
);
