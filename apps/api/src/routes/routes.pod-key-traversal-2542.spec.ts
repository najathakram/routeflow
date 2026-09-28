/**
 * #2542 (SECURITY): POD artifact keys. Signing used to check only a `tenants/<own>/pod/` PREFIX, and
 * the complete-stop DTO accepts arbitrary strings, so `tenants/<own>/pod/../../<other>/…` (or an
 * encoded / backslashed variant) could be stored and then signed as another tenant's R2 object. A
 * POD key must now be EXACTLY `tenants/<own>/pod/<stopId>/<name>.<ext>`, on WRITE and at SIGN.
 * Red-first against the prefix check. Bootstrap copied from routes.service.stop-state-guards.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
// F03/F05 own the "counts as collected money" predicate — R1's live-money
// reopen guard must pin to THIS shared const rather than a literal
// `status: "PAID"`, same convention as every other confirmed-money read.
import { CONFIRMED_PAYMENT } from "../invoices/payment-predicates";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { geocodeAddress } from "../common/geocode.util";
import { compressImage } from "../storage/compress.util";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));
// Real sharp is exercised by compress.util.spec.ts; here it's mocked so POD
// unit tests need no real image fixtures.
jest.mock("../storage/compress.util", () => ({
  compressImage: jest.fn().mockResolvedValue({
    buffer: Buffer.from("compressed"),
    mimeType: "image/jpeg",
    ext: "jpg",
  }),
}));

// Campaign batch F10 — REG-B54/B55/B71/B72/B120/B121. Every test below is a
// RED-GATE proof: written before the fix lands, each must fail on an
// assertion (never a compile/import error) against the CURRENT
// (pre-implementation) behavior of RoutesService. See
// .claude/pipeline/2026-09-01-F10-reopen-stop-state-guards/{spec,test-plan}.md.

const operatorPayload = { sub: "user-op", role: "OPERATOR", tenantId: "t1" } as any;
const driverPayload = { sub: "user-drv", role: "DRIVER", tenantId: "t1" } as any;

const RUN_FIXTURE = {
  id: "run-1",
  driverId: "drv-1",
  status: "SCHEDULED" as const,
  startedAt: null as Date | null,
  settlementNote: null as string | null,
  settlementVariance: null as number | null,
};

// The order carried by reopenStop's stop fixture — status DELIVERED so the
// reversal's order-demotion step (step 4) is exercised.
const REOPEN_ORDER = { id: "order-1", status: "DELIVERED", lineItems: [] as unknown[] };

const REOPEN_STOP_BASE = {
  id: "stop-1",
  status: "COMPLETED" as const,
  orders: [REOPEN_ORDER],
  signatureUrl: null as string | null,
  podPhotoUrls: [] as string[],
  ageVerified: false,
  identityVerified: false,
  identityType: null as string | null,
  identityVerifiedAt: null as Date | null,
  completedAt: null as Date | null,
  safeDropEnabled: false,
  driverNote: null as string | null,
};

const SIG_DATA_URL = "data:image/png;base64,aGk=";
const PHOTO_DATA_URL = "data:image/jpeg;base64,/9j/fake";

import { isPodStorageKey, podCaptureValueRefusal } from "./pod-artifacts.util";
import { ingestPodCapture } from "./pod-ingest";

describe("RoutesService — POD key traversal (#2542)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let gateway: jest.Mocked<
    Pick<
      RouteFlowGateway,
      "emitStopCompleted" | "emitOrderCreated" | "emitOrderStatusChanged" | "emitToDriver"
    >
  >;
  let notifications: jest.Mocked<Pick<NotificationsService, "sendToDriver">>;
  let messaging: { notify: jest.Mock; notifyEvent: jest.Mock };
  let invoicesService: {
    recordDeliveryPaymentInTx: jest.Mock;
    reconcileDeliveredOrdersInTx: jest.Mock;
    reverseRunAdvancesInTx: jest.Mock;
  };
  let storage: { upload: jest.Mock; presignedUrl: jest.Mock; delete: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // R6's archival write targets `tx.auditLog.create`; `createMockPrisma()`
    // carries `auditLog` in its shared model list, so the top-level mock and the
    // default tenantTransaction client are the SAME jest.fn — which is what makes
    // T16's "was NOT the call site" assertion mean something. Never re-attach it
    // by hand here: that would fork the two and the assertion would pass vacuously.

    invoicesService = {
      recordDeliveryPaymentInTx: jest
        .fn()
        .mockResolvedValue({ applied: 0, invoiceIds: [], paymentIds: [] }),
      reconcileDeliveredOrdersInTx: jest.fn().mockResolvedValue(undefined),
      reverseRunAdvancesInTx: jest.fn().mockResolvedValue(0),
    };

    gateway = {
      emitStopCompleted: jest.fn(),
      emitOrderCreated: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
      emitToDriver: jest.fn(),
    };

    notifications = {
      sendToDriver: jest.fn().mockResolvedValue(undefined),
    };

    messaging = {
      notify: jest.fn().mockResolvedValue([]),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    };

    storage = {
      upload: jest.fn().mockImplementation((key: string) => Promise.resolve(key)),
      presignedUrl: jest.fn().mockImplementation((key: string) => Promise.resolve(`signed:${key}`)),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: gateway },
        { provide: NotificationsService, useValue: notifications },
        { provide: MessagingService, useValue: messaging },
        { provide: InvoicesService, useValue: invoicesService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
        { provide: StorageService, useValue: storage },
        // Feature grants v2 brief C (PR-5): resolves "unset" so every existing test in this
        // file keeps exercising today's (every-kind-allowed) dispatch behavior unchanged.
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
      ],
    }).compile();

    service = module.get<RoutesService>(RoutesService);
  });

  const T = "t1";
  const OWN = `tenants/${T}/pod/stop-1/photo-abcd1234.jpg`;
  const ESCAPES = [
    `tenants/${T}/pod/../../t2/pod/stop-9/photo-abcd1234.jpg`,
    `tenants/${T}/pod/stop-1/../../../t2/logo.png`,
    `tenants/${T}/pod/./stop-1/photo-abcd1234.jpg`,
    `tenants/${T}/pod//stop-1/photo-abcd1234.jpg`,
    `tenants/${T}/pod/stop-1/..%2F..%2F..%2Ft2%2Flogo.png`,
    `tenants/${T}/pod/stop-1/%2e%2e.png`,
    `tenants\\${T}\\pod\\stop-1\\photo-abcd1234.jpg`,
    `tenants/${T}/pod/stop-1/photo-abcd1234.jpg/extra`,
    `tenants/${T}/pod/stop-1/.hidden`,
    `tenants/${T}/pod/`,
    `tenants/t2/pod/stop-9/photo-abcd1234.jpg`,
    `products/p1/x.jpg`,
  ];

  describe("isPodStorageKey: exact structure, own tenant only", () => {
    it("accepts this tenant's canonical pod key", () => {
      expect(isPodStorageKey(OWN, T)).toBe(true);
      expect(isPodStorageKey(`tenants/${T}/pod/stop-1/signature-sig00001.jpg`, T)).toBe(true);
    });
    it.each(ESCAPES)("refuses %s", (key) => {
      expect(isPodStorageKey(key, T)).toBe(false);
    });
    it("refuses when the tenant id itself is not key-safe", () => {
      expect(isPodStorageKey("tenants/../pod/s/x.jpg", "..")).toBe(false);
    });
  });

  describe("write: complete-stop POD values", () => {
    it.each([
      ["a data URL to ingest", "data:image/jpeg;base64,/9j/fake"],
      ["a device-local file URI", "file:///var/mobile/photo.jpg"],
      ["the legacy sentinel", "native-captured"],
      ["this tenant's own key (a client echoing a stored key)", OWN],
    ])("accepts %s", (_label, v) => {
      expect(podCaptureValueRefusal(v, T)).toBeNull();
    });
    it.each(ESCAPES)("refuses %s", (v) => {
      expect(podCaptureValueRefusal(v, T)).toMatch(/own proof-of-delivery key/);
    });

    it("ingestPodCapture refuses a traversal before anything is uploaded", async () => {
      const deps = {
        prisma: { getTenantId: () => T },
        storage: { upload: jest.fn() },
        logger: { warn: jest.fn() },
      };
      await expect(
        ingestPodCapture(deps, { signatureUrl: ESCAPES[0], podPhotoUrls: [] }, "stop-1"),
      ).rejects.toThrow(BadRequestException);
      await expect(
        ingestPodCapture(
          deps,
          { podPhotoUrls: ["data:image/jpeg;base64,/9j/fake", ESCAPES[4]] },
          "stop-1",
        ),
      ).rejects.toThrow(BadRequestException);
      expect(deps.storage.upload).not.toHaveBeenCalled();
    });
  });

  describe("sign: getStopPod never signs an escaped key already stored (poisoned row)", () => {
    it("signs the own key only; escaped photos and signature are never signed", async () => {
      (prisma.getTenantId as jest.Mock).mockReturnValue(T);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "COMPLETED",
        signatureUrl: ESCAPES[1],
        podPhotoUrls: [OWN, ESCAPES[0], ESCAPES[4]],
        driverNote: null,
        completedAt: null,
        ageCheckRequired: false,
        ageVerified: false,
        identityCheckRequired: false,
        identityVerified: false,
        identityType: null,
      });
      prisma.routeRun.findFirst.mockResolvedValue({ driverId: "drv-1" });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      const pod = await (service as any).getStopPod("run-1", "stop-1", driverPayload);

      expect(storage.presignedUrl.mock.calls.map((c: unknown[]) => c[0])).toEqual([OWN]);
      expect(pod.photos).toEqual([{ url: `signed:${OWN}` }]);
      expect(pod.signatureUrl).toBeNull();
      expect(JSON.stringify(pod)).not.toContain("t2");
    });
  });
});
