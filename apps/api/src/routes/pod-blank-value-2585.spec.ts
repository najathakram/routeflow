/**
 * #2585 (a) / SA-519: a present-but-BLANK POD value (`signatureUrl` or a `podPhotoUrls` entry, empty
 * or whitespace) used to pass `podCaptureValueRefusal` as "not a key" and was then written as-is,
 * so `signatureUrl: ""` wiped a stored signature. It is now REFUSED with a 400 that names the field,
 * before anything is uploaded or written. Absent means omitted: no blank→absent coercion; null stays
 * refused; the legacy sentinel is unchanged. Red-first. Bootstrap copied from
 * routes.pod-key-traversal-2542.spec.ts.
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

import { podCaptureValueRefusal } from "./pod-artifacts.util";

const T = "t1";
const operator = { sub: "user-op", role: "OPERATOR", tenantId: T } as any;

describe("POD values: a blank value is refused, never written (#2585, SA-519)", () => {
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

  describe("podCaptureValueRefusal", () => {
    it.each([[""], ["  \t"], [" "], ["\n"]])("%j ⇒ refused as blank", (v) => {
      expect(podCaptureValueRefusal(v, T)).toMatch(/must not be blank/);
    });
    it("a real own-tenant pod key ⇒ null (accepted)", () => {
      expect(
        podCaptureValueRefusal(`tenants/${T}/pod/stop-1/signature-sig00001.jpg`, T),
      ).toBeNull();
    });
    it("null stays refused; the legacy sentinel stays accepted", () => {
      expect(podCaptureValueRefusal(null, T)).toMatch(/must be a string/);
      expect(podCaptureValueRefusal("native-captured", T)).toBeNull();
    });
  });

  describe("completeStop", () => {
    beforeEach(() => {
      prisma.routeRun.findUnique.mockResolvedValue({
        id: "run-1",
        status: "IN_PROGRESS",
        driverId: "drv-1",
      } as any);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        status: "PENDING",
        signatureUrl: "tenants/t1/pod/stop-1/signature-sig00001.jpg",
        podPhotoUrls: [],
        orders: [],
      } as any);
    });

    const nothingWritten = () => {
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
      // #2631 (the lead's #2621 LOW): the completion CLAIMS the stop with updateMany
      // (claimStopCompletion) — asserting on `update` alone could never catch a write.
      expect(prisma.routeRunStop.updateMany).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    };

    it.each([[""], ["   "]])(
      "signatureUrl %j ⇒ 400 naming signatureUrl; the stop row is untouched",
      async (blank) => {
        const caught: any = await service
          .completeStop("run-1", "stop-1", { signatureUrl: blank } as any, operator)
          .catch((e) => e);
        expect(caught).toBeInstanceOf(BadRequestException);
        expect(caught.message).toMatch(/^signatureUrl: .*must not be blank/);
        nothingWritten();
      },
    );

    it("a blank podPhotoUrls entry ⇒ 400 naming the entry; nothing uploaded or written", async () => {
      const caught: any = await service
        .completeStop(
          "run-1",
          "stop-1",
          { podPhotoUrls: ["data:image/jpeg;base64,/9j/fake", " \t "] } as any,
          operator,
        )
        .catch((e) => e);
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(caught.message).toMatch(/^podPhotoUrls\[1\]: .*must not be blank/);
      nothingWritten();
    });

    it("omitted POD fields ⇒ no refusal; the completion goes ahead (the stored signature is not touched)", async () => {
      prisma.routeRunStop.updateMany.mockResolvedValue({ count: 1 } as any);
      await service.completeStop("run-1", "stop-1", {} as any, operator).catch(() => undefined);
      expect(prisma.tenantTransaction).toHaveBeenCalled();
      // #2631 (the lead's #2621 LOW): the old loop read routeRunStop.update, which the completion
      // never calls (the claim is updateMany), so it passed vacuously. Pin the REAL claim was
      // reached for this stop, and that neither write names the signature.
      const claims = prisma.routeRunStop.updateMany.mock.calls.filter(
        (c: any[]) => c[0]?.where?.id === "stop-1",
      );
      expect(claims.length).toBeGreaterThan(0);
      for (const c of [
        ...prisma.routeRunStop.updateMany.mock.calls,
        ...prisma.routeRunStop.update.mock.calls,
      ])
        expect(c[0].data).not.toHaveProperty("signatureUrl");
    });
  });

  // #2631 (the lead's #2621 LOW): completeWithPayment runs the SAME ingestPodCapture (its POD path had
  // no spec). Same refusals, same "nothing written".
  describe("completeWithPayment", () => {
    beforeEach(() => {
      prisma.routeRun.findUnique.mockResolvedValue({
        id: "run-1",
        status: "IN_PROGRESS",
        driverId: "drv-1",
      } as any);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        status: "PENDING",
        signatureUrl: "tenants/t1/pod/stop-1/signature-sig00001.jpg",
        podPhotoUrls: [],
        orders: [],
      } as any);
    });

    const nothingWritten = () => {
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
      expect(prisma.routeRunStop.updateMany).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
      expect(invoicesService.recordDeliveryPaymentInTx).not.toHaveBeenCalled();
    };

    it.each([[""], ["   "]])(
      "signatureUrl %j ⇒ 400 naming signatureUrl; nothing written, no payment",
      async (blank) => {
        const caught: any = await service
          .completeWithPayment("run-1", "stop-1", { signatureUrl: blank } as any, operator)
          .catch((e) => e);
        expect(caught).toBeInstanceOf(BadRequestException);
        expect(caught.message).toMatch(/^signatureUrl: .*must not be blank/);
        nothingWritten();
      },
    );

    it("a blank podPhotoUrls entry ⇒ 400 naming the entry; nothing uploaded, written or paid", async () => {
      const caught: any = await service
        .completeWithPayment(
          "run-1",
          "stop-1",
          { podPhotoUrls: ["data:image/jpeg;base64,/9j/fake", " \t "] } as any,
          operator,
        )
        .catch((e) => e);
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(caught.message).toMatch(/^podPhotoUrls\[1\]: .*must not be blank/);
      nothingWritten();
    });
  });
});
