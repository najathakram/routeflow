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
import { MESSAGE_PROVIDER } from "./providers/message-provider.interface";
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
  // F23/B183a, B180: getMatrix()/setRuleEnabled() consult the SAME capability seam sendMessage()
  // uses (cause-ruling.md §2) to mark a cell `unavailable`. Default every channel "has a transport"
  // here so unrelated cells stay available — REG-B145's own transport-honesty is proven separately
  // against the REAL StubProvider in messaging.transport-honesty.spec.ts, not via this mock.
  let provider: { send: jest.Mock; transports: jest.Mock };

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
    provider = { send: jest.fn(), transports: jest.fn().mockReturnValue(true) };

    const mod = await Test.createTestingModule({
      providers: [
        MessagingConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: MeterService, useValue: meter },
        { provide: MESSAGE_PROVIDER, useValue: provider },
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
    it("LOW_STOCK's INTERNAL cell carries the seeded template's parsed variables", async () => {
      const { rules, templates } = buildFullSeed();
      prisma.notificationRule.findMany.mockResolvedValue(rules);
      prisma.messageTemplate.findMany.mockResolvedValue(templates);
      prisma.messagingSettings.findUnique.mockResolvedValue(null);

      const result = await service.getMatrix();

      const lowStock = result.events.find((e) => e.eventKey === NotificationEvent.LOW_STOCK)!;
      expect(lowStock.channels).toHaveLength(1);
      const cell = lowStock.channels[0];
      expect(cell.channel).toBe(MessageChannel.INTERNAL);
      expect(cell.ruleId).toBeTruthy();
      expect(cell.locked).toBe(false);
      expect(cell.template?.variables).toEqual(["productName", "quantity"]);
    });

    it("REG-B180 T6: LOW_STOCK has no firing site anywhere in the app — the matrix marks its cell unavailable (NO_TRIGGER), disabled, and setRuleEnabled refuses to turn it on", async () => {
      const { rules, templates } = buildFullSeed();
      prisma.notificationRule.findMany.mockResolvedValue(rules);
      prisma.messageTemplate.findMany.mockResolvedValue(templates);
      prisma.messagingSettings.findUnique.mockResolvedValue(null);

      const result = await service.getMatrix();

      const lowStock = result.events.find((e) => e.eventKey === NotificationEvent.LOW_STOCK)!;
      const cell = lowStock.channels.find((c) => c.channel === MessageChannel.INTERNAL)!;
      expect(cell).toMatchObject({ unavailable: "NO_TRIGGER", enabled: false });

      const lowStockRule = rules.find((r) => r.eventKey === NotificationEvent.LOW_STOCK)!;
      prisma.notificationRule.findFirst.mockResolvedValue(lowStockRule);

      await expect(service.setRuleEnabled(lowStockRule.id, true)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.notificationRule.update).not.toHaveBeenCalled();
    });

    it("REG-B160 T3 (via getMatrix): settings default to the engine default (quietHoursEnabled=false) when no row exists, alongside the msgsMeter read", async () => {
      const { rules, templates } = buildFullSeed();
      prisma.notificationRule.findMany.mockResolvedValue(rules);
      prisma.messageTemplate.findMany.mockResolvedValue(templates);
      prisma.messagingSettings.findUnique.mockResolvedValue(null);

      const result = await service.getMatrix();

      expect(result.settings).toEqual({
        quietHoursEnabled: false,
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
    // F23 harness fix: DELIVERED:PORTAL was the original fixture here, but PORTAL has no
    // real transport (StubProvider declares none — cause-ruling.md §2) and no customer-facing
    // reader, so once P2 lands it becomes an `unavailable` cell setRuleEnabled must refuse. This
    // pin is about the ordinary toggle path, not about availability, so it fixtures a channel
    // (EMAIL) that stays available under the mocked capability provider — the unavailable/refuse
    // paths are covered on their own terms by T6 (NO_TRIGGER) and T8 (NO_CONSENT_WRITER) below.
    it("toggles a rule's enabled flag", async () => {
      prisma.notificationRule.findFirst.mockResolvedValue({
        id: "rule-1",
        eventKey: NotificationEvent.DELIVERED,
        channel: MessageChannel.EMAIL,
        enabled: false,
      });
      prisma.notificationRule.update.mockResolvedValue({
        id: "rule-1",
        eventKey: NotificationEvent.DELIVERED,
        channel: MessageChannel.EMAIL,
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

    it("REG-B183 T8: a WhatsApp/SMS cell is unavailable (NO_CONSENT_WRITER) — there is no consent writer yet, so getMatrix marks it and setRuleEnabled refuses to enable it", async () => {
      const { rules, templates } = buildFullSeed();
      prisma.notificationRule.findMany.mockResolvedValue(rules);
      prisma.messageTemplate.findMany.mockResolvedValue(templates);
      prisma.messagingSettings.findUnique.mockResolvedValue(null);

      const result = await service.getMatrix();
      const orderConfirmed = result.events.find(
        (e) => e.eventKey === NotificationEvent.ORDER_CONFIRMED,
      )!;
      const waCell = orderConfirmed.channels.find((c) => c.channel === MessageChannel.WHATSAPP)!;
      expect(waCell).toMatchObject({ unavailable: "NO_CONSENT_WRITER" });

      const waRule = rules.find(
        (r) =>
          r.eventKey === NotificationEvent.ORDER_CONFIRMED && r.channel === MessageChannel.WHATSAPP,
      )!;
      prisma.notificationRule.findFirst.mockResolvedValue(waRule);

      await expect(service.setRuleEnabled(waRule.id, true)).rejects.toThrow(BadRequestException);
      expect(prisma.notificationRule.update).not.toHaveBeenCalled();
    });
  });

  describe("NO_TRANSPORT — provider declares no transports (F23/B180/B183a)", () => {
    // Unlike the shared beforeEach's always-true provider (kept so T6/T8 precedence stays
    // covered), this mirrors the production StubProvider shape: no channel is transported.
    it("marks a customer-channel cell NO_TRANSPORT/disabled, and every INTERNAL cell reports NO_TRIGGER, and setRuleEnabled refuses it", async () => {
      const noTransportProvider = { send: jest.fn(), transports: jest.fn().mockReturnValue(false) };
      const mod = await Test.createTestingModule({
        providers: [
          MessagingConfigService,
          { provide: PrismaService, useValue: prisma },
          { provide: MeterService, useValue: meter },
          { provide: MESSAGE_PROVIDER, useValue: noTransportProvider },
        ],
      }).compile();
      const noTransportService: MessagingConfigService = mod.get(MessagingConfigService);

      const { rules, templates } = buildFullSeed();
      prisma.notificationRule.findMany.mockResolvedValue(rules);
      prisma.messageTemplate.findMany.mockResolvedValue(templates);
      prisma.messagingSettings.findUnique.mockResolvedValue(null);

      const result = await noTransportService.getMatrix();

      const invoiceSent = result.events.find((e) => e.eventKey === NotificationEvent.INVOICE_SENT)!;
      const emailCell = invoiceSent.channels.find((c) => c.channel === MessageChannel.EMAIL)!;
      expect(emailCell).toMatchObject({ unavailable: "NO_TRANSPORT", enabled: false });
      expect(noTransportProvider.transports).toHaveBeenCalledWith(MessageChannel.EMAIL);

      // Every INTERNAL event today is also a NO_TRIGGER event, so the `channel !== INTERNAL`
      // exemption in unavailabilityReason is currently unreachable — this pins that fact.
      // When the first INTERNAL event gains a firing site (leaves NO_TRIGGER_EVENTS), this
      // assertion fails and the exemption needs a real NO_TRANSPORT test.
      const internalCells = result.events.flatMap((e) =>
        e.channels.filter((c) => c.channel === MessageChannel.INTERNAL),
      );
      expect(internalCells.length).toBeGreaterThan(0);
      expect(internalCells.every((c) => c.unavailable === "NO_TRIGGER")).toBe(true);

      const emailRule = rules.find(
        (r) => r.eventKey === NotificationEvent.INVOICE_SENT && r.channel === MessageChannel.EMAIL,
      )!;
      prisma.notificationRule.findFirst.mockResolvedValue(emailRule);

      await expect(noTransportService.setRuleEnabled(emailRule.id, true)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.notificationRule.update).not.toHaveBeenCalled();
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
    it("REG-B160 T3: getSettings() default matches the engine default (quietHoursEnabled=false) when no row exists", async () => {
      prisma.messagingSettings.findUnique.mockResolvedValue(null);
      const result = await service.getSettings();
      expect(result).toEqual({
        quietHoursEnabled: false,
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
