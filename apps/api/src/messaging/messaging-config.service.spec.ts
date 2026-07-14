import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MessageChannel, NotificationEvent } from "@prisma/client";
import {
  DEFAULT_ON,
  DEFAULT_TEMPLATES,
  EVENT_CHANNELS,
  MessagingConfigService,
} from "./messaging-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { extractVariables } from "./messaging.helpers";

const ALL_PAIRS = (Object.keys(EVENT_CHANNELS) as NotificationEvent[]).flatMap((eventKey) =>
  EVENT_CHANNELS[eventKey].map((channel) => ({ eventKey, channel })),
);

/** A fully-seeded tenant's rule/template rows, matching what seedMissing would have written. */
function buildFullSeed() {
  const rules = ALL_PAIRS.map((p, i) => ({
    id: `rule-${i}`,
    eventKey: p.eventKey,
    channel: p.channel,
    enabled: DEFAULT_ON.has(`${p.eventKey}:${p.channel}`),
  }));
  const templates = ALL_PAIRS.map((p, i) => ({
    id: `tpl-${i}`,
    eventKey: p.eventKey,
    channel: p.channel,
    body: DEFAULT_TEMPLATES[p.eventKey].body,
    variables: extractVariables(DEFAULT_TEMPLATES[p.eventKey].body),
    waTemplateName: null,
    waApprovalStatus: "NONE",
    isActive: true,
  }));
  return { rules, templates };
}

describe("MessagingConfigService (P6-6)", () => {
  let service: MessagingConfigService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let meter: { read: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    meter = {
      read: jest.fn().mockResolvedValue({
        used: 3,
        included: 500,
        remaining: 497,
        resetsAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    };

    const mod = await Test.createTestingModule({
      providers: [
        MessagingConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: MeterService, useValue: meter },
      ],
    }).compile();
    service = mod.get(MessagingConfigService);
  });

  describe("getMatrix — seeding", () => {
    it("seeds every missing rule/template pair on first read (createMany skipDuplicates, DEFAULT_ON count enabled)", async () => {
      prisma.notificationRule.findMany.mockResolvedValue([]);
      prisma.messageTemplate.findMany.mockResolvedValue([]);

      await service.getMatrix();

      expect(prisma.notificationRule.createMany).toHaveBeenCalledTimes(1);
      const ruleArgs = prisma.notificationRule.createMany.mock.calls[0][0];
      expect(ruleArgs.skipDuplicates).toBe(true);
      expect(ruleArgs.data).toHaveLength(ALL_PAIRS.length);
      expect(ruleArgs.data.filter((r: { enabled: boolean }) => r.enabled)).toHaveLength(
        DEFAULT_ON.size,
      );

      expect(prisma.messageTemplate.createMany).toHaveBeenCalledTimes(1);
      const tplArgs = prisma.messageTemplate.createMany.mock.calls[0][0];
      expect(tplArgs.skipDuplicates).toBe(true);
      expect(tplArgs.data).toHaveLength(ALL_PAIRS.length);
    });

    it("seeds INVOICE_SENT only for EMAIL+PORTAL; matrix surfaces WHATSAPP/SMS as locked (never seeded)", async () => {
      prisma.notificationRule.findMany.mockResolvedValue([]);
      prisma.messageTemplate.findMany.mockResolvedValue([]);

      const result = await service.getMatrix();

      const ruleArgs = prisma.notificationRule.createMany.mock.calls[0][0];
      const invoiceRuleChannels = ruleArgs.data
        .filter(
          (r: { eventKey: NotificationEvent }) => r.eventKey === NotificationEvent.INVOICE_SENT,
        )
        .map((r: { channel: MessageChannel }) => r.channel)
        .sort();
      expect(invoiceRuleChannels).toEqual([MessageChannel.EMAIL, MessageChannel.PORTAL].sort());

      const tplArgs = prisma.messageTemplate.createMany.mock.calls[0][0];
      const invoiceTplChannels = tplArgs.data
        .filter(
          (t: { eventKey: NotificationEvent }) => t.eventKey === NotificationEvent.INVOICE_SENT,
        )
        .map((t: { channel: MessageChannel }) => t.channel)
        .sort();
      expect(invoiceTplChannels).toEqual([MessageChannel.EMAIL, MessageChannel.PORTAL].sort());

      const invoiceEvent = result.events.find(
        (e) => e.eventKey === NotificationEvent.INVOICE_SENT,
      )!;
      const wa = invoiceEvent.channels.find((c) => c.channel === MessageChannel.WHATSAPP);
      const sms = invoiceEvent.channels.find((c) => c.channel === MessageChannel.SMS);
      expect(wa).toMatchObject({ locked: true, enabled: false, ruleId: null, template: null });
      expect(sms).toMatchObject({ locked: true, enabled: false, ruleId: null, template: null });
    });

    it("is idempotent — a fully-seeded tenant triggers no createMany and reads each model once", async () => {
      const { rules, templates } = buildFullSeed();
      prisma.notificationRule.findMany.mockResolvedValue(rules);
      prisma.messageTemplate.findMany.mockResolvedValue(templates);

      await service.getMatrix();

      expect(prisma.notificationRule.createMany).not.toHaveBeenCalled();
      expect(prisma.messageTemplate.createMany).not.toHaveBeenCalled();
      expect(prisma.notificationRule.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.messageTemplate.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe("getMatrix — cell shape / settings / meter", () => {
    it("LOW_STOCK exposes a single enabled INTERNAL cell with the seeded template's parsed variables", async () => {
      const { rules, templates } = buildFullSeed();
      prisma.notificationRule.findMany.mockResolvedValue(rules);
      prisma.messageTemplate.findMany.mockResolvedValue(templates);
      prisma.messagingSettings.findUnique.mockResolvedValue(null);

      const result = await service.getMatrix();

      const lowStock = result.events.find((e) => e.eventKey === NotificationEvent.LOW_STOCK)!;
      expect(lowStock.channels).toHaveLength(1);
      const cell = lowStock.channels[0];
      expect(cell.channel).toBe(MessageChannel.INTERNAL);
      expect(cell.enabled).toBe(true);
      expect(cell.ruleId).toBeTruthy();
      expect(cell.locked).toBe(false);
      expect(cell.template?.variables).toEqual(["productName", "quantity"]);

      expect(result.settings).toEqual({
        quietHoursEnabled: true,
        quietHoursStart: "21:00",
        quietHoursEnd: "07:00",
        timezone: null,
      });

      expect(result.msgsMeter).toEqual({
        used: 3,
        included: 500,
        remaining: 497,
        resetsAt: "2026-08-01T00:00:00.000Z",
      });
    });

    it("returns a null msgsMeter (matrix still returned) when the meter read throws", async () => {
      const { rules, templates } = buildFullSeed();
      prisma.notificationRule.findMany.mockResolvedValue(rules);
      prisma.messageTemplate.findMany.mockResolvedValue(templates);
      meter.read.mockRejectedValueOnce(new Error("meter unavailable"));

      const result = await service.getMatrix();

      expect(result.msgsMeter).toBeNull();
      expect(result.events.length).toBeGreaterThan(0);
    });
  });

  describe("setRuleEnabled", () => {
    it("toggles a rule's enabled flag", async () => {
      prisma.notificationRule.findFirst.mockResolvedValue({
        id: "rule-1",
        eventKey: NotificationEvent.DELIVERED,
        channel: MessageChannel.PORTAL,
        enabled: false,
      });
      prisma.notificationRule.update.mockResolvedValue({
        id: "rule-1",
        eventKey: NotificationEvent.DELIVERED,
        channel: MessageChannel.PORTAL,
        enabled: true,
      });

      const result = await service.setRuleEnabled("rule-1", true);

      expect(prisma.notificationRule.update).toHaveBeenCalledWith({
        where: { id: "rule-1" },
        data: { enabled: true },
      });
      expect(result).toMatchObject({ id: "rule-1", enabled: true });
    });

    it("404s for an unknown rule id", async () => {
      prisma.notificationRule.findFirst.mockResolvedValue(null);
      await expect(service.setRuleEnabled("missing", true)).rejects.toThrow(NotFoundException);
      expect(prisma.notificationRule.update).not.toHaveBeenCalled();
    });

    it("refuses to enable a G12-locked pair (BadRequest, no update)", async () => {
      prisma.notificationRule.findFirst.mockResolvedValue({
        id: "rule-inv",
        eventKey: NotificationEvent.INVOICE_SENT,
        channel: MessageChannel.WHATSAPP,
        enabled: false,
      });

      await expect(service.setRuleEnabled("rule-inv", true)).rejects.toThrow(BadRequestException);
      expect(prisma.notificationRule.update).not.toHaveBeenCalled();
    });

    it("allows disabling a G12 pair (only enabling is blocked)", async () => {
      prisma.notificationRule.findFirst.mockResolvedValue({
        id: "rule-inv",
        eventKey: NotificationEvent.INVOICE_SENT,
        channel: MessageChannel.WHATSAPP,
        enabled: true,
      });
      prisma.notificationRule.update.mockResolvedValue({
        id: "rule-inv",
        eventKey: NotificationEvent.INVOICE_SENT,
        channel: MessageChannel.WHATSAPP,
        enabled: false,
      });

      const result = await service.setRuleEnabled("rule-inv", false);

      expect(result.enabled).toBe(false);
      expect(prisma.notificationRule.update).toHaveBeenCalledWith({
        where: { id: "rule-inv" },
        data: { enabled: false },
      });
    });
  });

  describe("updateTemplate", () => {
    it("re-parses {{vars}} on a body edit and clears waTemplateName on an empty string", async () => {
      prisma.messageTemplate.findFirst.mockResolvedValue({
        id: "tpl-1",
        body: "old",
        variables: [],
        waTemplateName: "old_wa_name",
        waApprovalStatus: "APPROVED",
        isActive: true,
      });
      prisma.messageTemplate.update.mockResolvedValue({
        id: "tpl-1",
        body: "Hi {{name}}, order {{orderNumber}}",
        variables: ["name", "orderNumber"],
        waTemplateName: null,
        waApprovalStatus: "APPROVED",
        isActive: true,
      });

      const result = await service.updateTemplate("tpl-1", {
        body: "Hi {{name}}, order {{orderNumber}}",
        waTemplateName: "",
      });

      expect(prisma.messageTemplate.update).toHaveBeenCalledWith({
        where: { id: "tpl-1" },
        data: {
          body: "Hi {{name}}, order {{orderNumber}}",
          variables: ["name", "orderNumber"],
          waTemplateName: null,
        },
      });
      expect(result.variables).toEqual(["name", "orderNumber"]);
      expect(result.waTemplateName).toBeNull();
    });

    it("404s for an unknown template id", async () => {
      prisma.messageTemplate.findFirst.mockResolvedValue(null);
      await expect(service.updateTemplate("missing", { body: "x" })).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.messageTemplate.update).not.toHaveBeenCalled();
    });
  });

  describe("preview", () => {
    it("renders a missing var as empty string and returns the parsed variable names", () => {
      const result = service.preview("Hi {{name}}, ref #{{missing}}.", { name: "Acme" });
      expect(result.rendered).toBe("Hi Acme, ref #.");
      expect(result.variables).toEqual(["name", "missing"]);
    });
  });

  describe("getSettings / updateSettings", () => {
    it("returns defaults when no settings row exists", async () => {
      prisma.messagingSettings.findUnique.mockResolvedValue(null);
      const result = await service.getSettings();
      expect(result).toEqual({
        quietHoursEnabled: true,
        quietHoursStart: "21:00",
        quietHoursEnd: "07:00",
        timezone: null,
      });
    });

    it("upserts only the provided keys (create-on-first-save)", async () => {
      prisma.messagingSettings.findUnique.mockResolvedValue({
        tenantId: "test-tenant",
        quietHoursEnabled: false,
        quietHoursStart: "21:00",
        quietHoursEnd: "07:00",
        timezone: null,
      });

      await service.updateSettings({ quietHoursEnabled: false });

      expect(prisma.messagingSettings.upsert).toHaveBeenCalledWith({
        where: { tenantId: "test-tenant" },
        create: { tenantId: "test-tenant", quietHoursEnabled: false },
        update: { quietHoursEnabled: false },
      });
    });
  });
});

describe("extractVariables", () => {
  it("returns distinct variable names in first-appearance order", () => {
    expect(extractVariables("{{b}} and {{a}} and {{b}} again")).toEqual(["b", "a"]);
  });

  it("tolerates inner whitespace", () => {
    expect(extractVariables("Hi {{ name }}!")).toEqual(["name"]);
  });

  it("supports dotted paths", () => {
    expect(extractVariables("Total: {{order.total}}")).toEqual(["order.total"]);
  });

  it("returns an empty array when there are no placeholders", () => {
    expect(extractVariables("no placeholders here")).toEqual([]);
  });
});
