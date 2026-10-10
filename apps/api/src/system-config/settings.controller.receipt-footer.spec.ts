import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { RECEIPT_FOOTER_MAX_CHARS, sanitizeReceiptFooter } from "./receipt-footer";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { QuickKeysSettingsService } from "./quick-keys-settings.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-762r F6: `settings.receiptFooter` rides PATCH /settings through SystemConfigService.set (the tenant-scoped
 * writer), comes back on GET, and is checked before any write: non-string -> 400, control / bidi characters
 * stripped, more than 200 characters after the strip -> 400, and no tenant context -> 403.
 */
describe("SettingsController: receiptFooter (SA-762r F6)", () => {
  let controller: SettingsController;
  let svc: { get: jest.Mock; set: jest.Mock; getAll: jest.Mock };
  let prisma: ReturnType<typeof createMockPrisma>;
  let stored: Record<string, string>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    stored = {};
    svc = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(async (k: string, v: string) => {
        stored[k] = v;
      }),
      getAll: jest.fn(async () => ({ ...stored })),
    };
    const mod = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SystemConfigService, useValue: svc },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn() } },
        // the quick-keys settings are not under test here: a stub keeps GET /settings' extra field inert
        {
          provide: QuickKeysSettingsService,
          useValue: { fromAll: jest.fn(() => undefined), prepare: jest.fn(), save: jest.fn() },
        },
      ],
    }).compile();
    controller = mod.get(SettingsController);
  });

  it("PATCH stores it under settings.receiptFooter, and GET returns it", async () => {
    const res = await controller.updateSettings({
      receiptFooter: "Thank you!\nReturns within 7 days",
    });
    expect(svc.set).toHaveBeenCalledWith(
      "settings.receiptFooter",
      "Thank you!\nReturns within 7 days",
    );
    expect(res.receiptFooter).toBe("Thank you!\nReturns within 7 days");
    expect((await controller.getSettings()).receiptFooter).toBe(
      "Thank you!\nReturns within 7 days",
    );
  });

  it("GET returns an empty string when the tenant has not set one", async () => {
    expect((await controller.getSettings()).receiptFooter).toBe("");
  });

  it("an empty footer clears it (stored as the empty string)", async () => {
    await controller.updateSettings({ receiptFooter: "x" });
    await controller.updateSettings({ receiptFooter: "" });
    expect(svc.set).toHaveBeenLastCalledWith("settings.receiptFooter", "");
  });

  it("no tenant context is 403 and nothing is written (not even the other fields in the body)", async () => {
    prisma.getTenantId.mockReturnValue(null);
    await expect(
      controller.updateSettings({ receiptFooter: "hi", taxRate: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it.each([[42], [null], [{ a: 1 }], [["x"]], [true]])(
    "a non-string (%j) is 400 and nothing is written",
    async (bad) => {
      await expect(
        controller.updateSettings({ receiptFooter: bad, taxRate: 5 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(svc.set).not.toHaveBeenCalled();
    },
  );

  it("200 characters pass, 201 characters after the strip are 400 with nothing written", async () => {
    await controller.updateSettings({ receiptFooter: "a".repeat(RECEIPT_FOOTER_MAX_CHARS) });
    expect(stored["settings.receiptFooter"]).toHaveLength(200);
    svc.set.mockClear();
    await expect(
      controller.updateSettings({ receiptFooter: "a".repeat(201), taxRate: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it("the limit is judged AFTER the strip: 201 characters of which one is a control character pass", async () => {
    await controller.updateSettings({ receiptFooter: "a".repeat(200) + "\u0007" });
    expect(stored["settings.receiptFooter"]).toBe("a".repeat(200));
  });

  describe("sanitizeReceiptFooter: what is stripped", () => {
    it("strips C0 controls except \\n (tab and carriage return included), DEL and the C1 block", () => {
      expect(sanitizeReceiptFooter("a\u0000b\tc\rd\u001Be\u007Ff\u0085g\u009Fh\ni")).toBe(
        "abcdefgh\ni",
      );
    });

    it("strips the bidi overrides U+202A-202E and isolates U+2066-2069", () => {
      expect(sanitizeReceiptFooter("a‪b‫c‬d‭e‮f⁦g⁧h⁨i⁩j")).toBe("abcdefghij");
    });

    it("keeps ordinary text, accents, emoji and the newline untouched", () => {
      const ok = "Gracias éñ \u{1F600}\nSecond line";
      expect(sanitizeReceiptFooter(ok)).toBe(ok);
    });

    it("counts an emoji as one character", () => {
      expect(sanitizeReceiptFooter("\u{1F600}".repeat(200))).toHaveLength(400); // 200 code points
      expect(() => sanitizeReceiptFooter("\u{1F600}".repeat(201))).toThrow(BadRequestException);
    });
  });
});
