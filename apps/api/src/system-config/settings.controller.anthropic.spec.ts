import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { quickKeysSettingsStubProvider } from "../testing/quick-keys-settings-stub";

/**
 * SA-1102 PR-A §2.4 (S-3, tenant half): GET /settings/anthropic describes the BUSINESS's own key only. RouteFlow's
 * env key is never read here, so it is never previewed to a client. The business key previews as its last 4.
 */
const ENV_KEY = "sk-ant-api03-ENVENVENVENVENVENVENVENVENVENVENVEcd34";
const BUSINESS_KEY = "sk-ant-api03-BUSINESSBUSINESSBUSINESSBUSINESSef56";

describe("SettingsController: GET/PATCH /settings/anthropic (SA-1102)", () => {
  let controller: SettingsController;
  let stored: Record<string, string>;
  let envRead: jest.Mock;

  beforeEach(async () => {
    stored = {};
    envRead = jest.fn((k: string) => (k === "ANTHROPIC_API_KEY" ? ENV_KEY : undefined));
    const svc = {
      get: jest.fn(async (k: string) => stored[k] ?? null),
      set: jest.fn(async (k: string, v: string) => {
        stored[k] = v;
      }),
      getAll: jest.fn(async () => ({})),
    };
    const mod = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SystemConfigService, useValue: svc },
        { provide: ConfigService, useValue: { get: envRead } },
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: EmailService, useValue: { send: jest.fn() } },
        quickKeysSettingsStubProvider,
      ],
    }).compile();
    controller = mod.get(SettingsController);
  });

  it("a business with no key of its own: RouteFlow's key, no preview, even with the env key set", async () => {
    expect(await controller.getAnthropicSettings()).toEqual({
      configured: false,
      keyPreview: null,
      source: "routeflow",
    });
  });

  it("never reads RouteFlow's env key", async () => {
    await controller.getAnthropicSettings();
    expect(envRead).not.toHaveBeenCalledWith("ANTHROPIC_API_KEY");
  });

  it("a business key previews as its last 4 and the source is business", async () => {
    stored["anthropic.apiKey"] = BUSINESS_KEY;
    const res = await controller.getAnthropicSettings();
    expect(res).toEqual({ configured: true, keyPreview: "…ef56", source: "business" });
    expect(JSON.stringify(res)).not.toContain("sk-ant");
  });

  it("PATCH saves the key and returns the new shape; a clear returns to RouteFlow's", async () => {
    const saved = await controller.updateAnthropicSettings({ apiKey: BUSINESS_KEY });
    expect(saved).toEqual({ configured: true, keyPreview: "…ef56", source: "business" });
    const cleared = await controller.updateAnthropicSettings({ apiKey: "" });
    expect(cleared).toEqual({ configured: false, keyPreview: null, source: "routeflow" });
  });
});
