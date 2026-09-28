/**
 * #2542 (SECURITY): POD artifact keys. Signing used to check only a `tenants/<own>/pod/` PREFIX, and
 * the complete-stop DTO accepts arbitrary strings, so `tenants/<own>/pod/../../<other>/…` (or an
 * encoded / backslashed variant) could be stored and then signed as another tenant's R2 object. A
 * POD key must now be EXACTLY `tenants/<own>/pod/<stopId>/<name>.<ext>`, on WRITE and at SIGN.
 * Red-first against the prefix check. #2550 adds the per-stop pin on write, the pinned null refusal
 * and the unicode / trailing-dot rows. Bootstrap copied from routes.service.stop-state-guards.spec.ts
 * (trimmed to what these cases use).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
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

const driverPayload = { sub: "user-drv", role: "DRIVER", tenantId: "t1" } as any;

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
    // #2550 (c): unicode look-alikes and trailing dots never pass the ASCII-only shape.
    `tenants/${T}/pod/stop-1/photo\u2024jpg`, // U+2024 ONE DOT LEADER
    `tenants/${T}/pod/\uff0e\uff0e/stop-1/photo.jpg`, // fullwidth ．． segment
    `tenants/${T}/pod/stop-1/photo.jpg.`,
    `tenants/${T}/pod/stop-1/photo.`,
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

    it("#2550 (a): with a stop id, a same-tenant key for ANOTHER stop is refused (no relink)", () => {
      expect(podCaptureValueRefusal(OWN, T, "stop-1")).toBeNull();
      expect(
        podCaptureValueRefusal(`tenants/${T}/pod/stop-2/photo-abcd1234.jpg`, T, "stop-1"),
      ).toMatch(/this stop's own proof-of-delivery key/);
      // Without a stop id (the tenant-only check) the same key is still own-tenant.
      expect(podCaptureValueRefusal(`tenants/${T}/pod/stop-2/photo-abcd1234.jpg`, T)).toBeNull();
    });

    it("#2550 (b): null is REFUSED, never read as absent (it would clear a stored signature)", async () => {
      expect(podCaptureValueRefusal(null, T)).toBe("a POD value must be a string");
      const deps = {
        prisma: { getTenantId: () => T },
        storage: { upload: jest.fn() },
        logger: { warn: jest.fn() },
      };
      await expect(
        ingestPodCapture(deps, { signatureUrl: null as unknown as string }, "stop-1"),
      ).rejects.toThrow(BadRequestException);
      expect(deps.storage.upload).not.toHaveBeenCalled();
    });

    it("ingestPodCapture refuses another stop's key and a traversal before anything is uploaded", async () => {
      const relinkDeps = {
        prisma: { getTenantId: () => T },
        storage: { upload: jest.fn() },
        logger: { warn: jest.fn() },
      };
      await expect(
        ingestPodCapture(
          relinkDeps,
          { podPhotoUrls: [`tenants/${T}/pod/stop-2/photo-abcd1234.jpg`] },
          "stop-1",
        ),
      ).rejects.toThrow(BadRequestException);
      expect(relinkDeps.storage.upload).not.toHaveBeenCalled();
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
