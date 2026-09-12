import { GoHighLevelWritebackService } from "./gohighlevel-writeback.service";
import { GoHighLevelClient } from "./gohighlevel.client";
import type { GhlCustomField } from "../crm.types";

/**
 * TP5: write-back service (T32-T38, spec R19/R20). GHL is mocked at the
 * GoHighLevelClient boundary; Prisma access is a hand-built jest.fn() model
 * mock (no PrismaService, no HTTP module) per the ruling's skeleton rule.
 */

function makeClient(): jest.Mocked<GoHighLevelClient> {
  return {
    getLocation: jest.fn(),
    listPipelines: jest.fn(),
    searchOpportunities: jest.fn(),
    getContact: jest.fn(),
    listCustomFields: jest.fn(),
    createCustomField: jest.fn(),
    updateContactCustomFields: jest.fn(),
    addTags: jest.fn(),
    createNote: jest.fn(),
    updateOpportunityStatus: jest.fn(),
  } as unknown as jest.Mocked<GoHighLevelClient>;
}

function makePrisma() {
  return {
    crmConnection: { update: jest.fn().mockResolvedValue({}) },
    crmHandoff: { update: jest.fn().mockResolvedValue({}) },
  };
}

function makeConfig(webBase = "https://web.test") {
  return { get: jest.fn((key: string) => (key === "urls.web" ? webBase : undefined)) };
}

const CONNECTION = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "conn-1",
  tenantId: "t1",
  customFieldIds: {
    "contact.routeflow_customer_id": "f-id",
    "contact.routeflow_link": "f-link",
    "contact.routeflow_status": "f-status",
  },
  writeBackFields: true,
  writeBackTag: true,
  writeBackNote: true,
  markWon: true,
  ...overrides,
});

const HANDOFF = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "handoff-1",
  opportunityId: "opp-1",
  contactId: "contact-1",
  status: "CREATED",
  attempts: 0,
  noteWritten: false,
  ...overrides,
});

const CUSTOMER = { id: "cust-1", businessName: "Acme Foods" };

describe("GoHighLevelWritebackService", () => {
  let client: jest.Mocked<GoHighLevelClient>;
  let prisma: ReturnType<typeof makePrisma>;
  let config: ReturnType<typeof makeConfig>;
  let service: GoHighLevelWritebackService;

  beforeEach(() => {
    client = makeClient();
    prisma = makePrisma();
    config = makeConfig();
    service = new GoHighLevelWritebackService(client, prisma as never, config as never);
  });

  describe("ensureCustomFields", () => {
    it("T32 (R19): creates only the missing custom fields and caches all three ids on the connection", async () => {
      client.listCustomFields.mockResolvedValue([
        {
          id: "f-link",
          name: "RouteFlow Link",
          fieldKey: "contact.routeflow_link",
        } as GhlCustomField,
      ]);
      client.createCustomField.mockImplementation(async (name: string) => {
        const ids: Record<string, GhlCustomField> = {
          "RouteFlow Customer ID": { id: "f-id", name: "RouteFlow Customer ID" },
          "RouteFlow Status": { id: "f-status", name: "RouteFlow Status" },
        };
        return ids[name];
      });

      const connection = CONNECTION({ customFieldIds: null });
      await service.ensureCustomFields(connection);

      expect(client.createCustomField).toHaveBeenCalledTimes(2);
      expect(client.createCustomField).toHaveBeenCalledWith("RouteFlow Customer ID");
      expect(client.createCustomField).toHaveBeenCalledWith("RouteFlow Status");
      expect(client.createCustomField).not.toHaveBeenCalledWith("RouteFlow Link");

      expect(prisma.crmConnection.update).toHaveBeenCalledTimes(1);
      const updateArg = prisma.crmConnection.update.mock.calls[0][0] as {
        where: { id: string };
        data: { customFieldIds: Record<string, string> };
      };
      expect(updateArg.where).toEqual({ id: "conn-1" });
      expect(updateArg.data.customFieldIds).toEqual({
        "contact.routeflow_customer_id": "f-id",
        "contact.routeflow_link": "f-link",
        "contact.routeflow_status": "f-status",
      });
    });
  });

  describe("writeBack — ordering and payload", () => {
    it("T33 (R19): calls the four GHL write-back steps in order when every toggle is on and note is unwritten", async () => {
      const order: string[] = [];
      client.updateContactCustomFields.mockImplementation(async () => {
        order.push("updateContactCustomFields");
      });
      client.addTags.mockImplementation(async () => {
        order.push("addTags");
      });
      client.createNote.mockImplementation(async () => {
        order.push("createNote");
      });
      client.updateOpportunityStatus.mockImplementation(async () => {
        order.push("updateOpportunityStatus");
      });

      await service.writeBack(CONNECTION(), HANDOFF({ noteWritten: false }), CUSTOMER);

      expect(order).toEqual([
        "updateContactCustomFields",
        "addTags",
        "createNote",
        "updateOpportunityStatus",
      ]);
      expect(client.addTags).toHaveBeenCalledWith("contact-1", ["routeflow-customer"]);
    });

    it("T34 (R19, mutation probe #3): the PUT-equivalent customFields payload contains exactly the three field values, and nothing else", async () => {
      await service.writeBack(CONNECTION(), HANDOFF(), CUSTOMER);

      expect(client.updateContactCustomFields).toHaveBeenCalledTimes(1);
      const [contactId, fields] = client.updateContactCustomFields.mock.calls[0];
      expect(contactId).toBe("contact-1");
      expect(fields).toEqual([
        { id: "f-id", field_value: "cust-1" },
        { id: "f-link", field_value: "https://web.test/customers/cust-1" },
        { id: "f-status", field_value: "Customer" },
      ]);
    });

    // M3 (R19(4)/R20): the success path has to persist its own outcome — without it every
    // retry re-posted the note and the row stayed WRITEBACK_PENDING forever.
    it("M3: a successful sequence persists noteWritten:true and restores the pre-write-back status", async () => {
      await service.writeBack(CONNECTION(), HANDOFF({ status: "LINKED" }), CUSTOMER);

      expect(client.createNote).toHaveBeenCalledTimes(1);
      // #2: the note flag lands in its own write straight after createNote; the
      // end-of-sequence write restores the terminal status.
      expect(prisma.crmHandoff.update).toHaveBeenCalledTimes(2);
      const calls = prisma.crmHandoff.update.mock.calls.map(
        (c) => c[0] as { where: { id: string }; data: Record<string, unknown> },
      );
      expect(calls[0].where).toEqual({ id: "handoff-1" });
      expect(calls[0].data).toEqual({ noteWritten: true });
      expect(calls[1].where).toEqual({ id: "handoff-1" });
      expect(calls[1].data.status).toBe("LINKED");
    });

    // M3: an already-written note is never re-posted, and noteWritten is not re-asserted.
    it("M3: a handoff with noteWritten already true skips createNote entirely", async () => {
      await service.writeBack(CONNECTION(), HANDOFF({ noteWritten: true }), CUSTOMER);

      expect(client.createNote).not.toHaveBeenCalled();
      expect(prisma.crmHandoff.update).toHaveBeenCalledTimes(1);
      const updateArg = prisma.crmHandoff.update.mock.calls[0][0] as {
        data: { noteWritten?: boolean };
      };
      expect(updateArg.data.noteWritten).toBeUndefined();
    });

    // #2 — the note is the one irreversible step in the sequence: a step AFTER it failing
    // used to roll the row back with `noteWritten` still false, so every retry posted a
    // duplicate note on the contact.
    it("#2: a note written before a later failing step is persisted before the WRITEBACK_PENDING update", async () => {
      client.updateOpportunityStatus.mockRejectedValue(new Error("ghl 500"));

      await service.writeBack(CONNECTION(), HANDOFF({ status: "CREATED" }), CUSTOMER);

      expect(client.createNote).toHaveBeenCalledTimes(1);
      expect(prisma.crmHandoff.update).toHaveBeenCalledTimes(2);
      const calls = prisma.crmHandoff.update.mock.calls.map(
        (c) => c[0] as { where: { id: string }; data: Record<string, unknown> },
      );
      expect(calls[0].data).toEqual({ noteWritten: true });
      expect(calls[1].data).toMatchObject({ status: "WRITEBACK_PENDING", attempts: 1 });

      // The retry reads the persisted row back: the note is never posted a second time.
      client.createNote.mockClear();
      await service.writeBack(
        CONNECTION(),
        HANDOFF({ status: "CREATED", noteWritten: true, attempts: 1 }),
        CUSTOMER,
      );
      expect(client.createNote).not.toHaveBeenCalled();
    });

    // #10 — an entry with no resolved field id is dropped rather than PUT with `id: undefined`.
    it("#10: a custom-field id that cannot be resolved is filtered out of the PUT body", async () => {
      const connection = CONNECTION({
        customFieldIds: {
          "contact.routeflow_customer_id": "f-id",
          "contact.routeflow_link": "f-link",
        },
      });
      // The refresh finds the same two and cannot create the third.
      client.listCustomFields.mockResolvedValue([
        { id: "f-id", name: "RouteFlow Customer ID", fieldKey: "contact.routeflow_customer_id" },
        { id: "f-link", name: "RouteFlow Link", fieldKey: "contact.routeflow_link" },
      ] as GhlCustomField[]);
      client.createCustomField.mockResolvedValue(undefined as never);

      await service.writeBack(connection, HANDOFF(), CUSTOMER);

      expect(client.updateContactCustomFields).toHaveBeenCalledTimes(1);
      const [, fields] = client.updateContactCustomFields.mock.calls[0];
      expect(fields).toEqual([
        { id: "f-id", field_value: "cust-1" },
        { id: "f-link", field_value: "https://web.test/customers/cust-1" },
      ]);
    });

    // #10 — with nothing resolvable there is no PUT at all, rather than an empty body.
    it("#10: no resolvable custom-field ids means the PUT is skipped entirely", async () => {
      const connection = CONNECTION({ customFieldIds: {} });
      client.listCustomFields.mockResolvedValue([]);
      client.createCustomField.mockResolvedValue(undefined as never);

      await service.writeBack(connection, HANDOFF(), CUSTOMER);

      expect(client.updateContactCustomFields).not.toHaveBeenCalled();
      expect(client.addTags).toHaveBeenCalledTimes(1);
    });

    // F10: an id-less handoff must never reach `update({where:{id:undefined}})` — the caller
    // is told instead of the failure being written to nowhere and swallowed.
    it("F10: a handoff with no persisted id throws instead of updating where id is undefined", async () => {
      await expect(
        service.writeBack(CONNECTION(), HANDOFF({ id: undefined }), CUSTOMER),
      ).rejects.toThrow(/persisted handoff id/);

      expect(prisma.crmHandoff.update).not.toHaveBeenCalled();
      expect(client.updateContactCustomFields).not.toHaveBeenCalled();
    });

    it("T35 (R19): each write-back step is skipped when its toggle is off, but the custom-fields update still runs", async () => {
      const connection = CONNECTION({ writeBackTag: false, writeBackNote: false, markWon: false });

      await service.writeBack(connection, HANDOFF(), CUSTOMER);

      expect(client.updateContactCustomFields).toHaveBeenCalledTimes(1);
      expect(client.addTags).not.toHaveBeenCalled();
      expect(client.createNote).not.toHaveBeenCalled();
      expect(client.updateOpportunityStatus).not.toHaveBeenCalled();
    });
  });

  describe("writeBack — failure/backoff (R20)", () => {
    it("T36 (R20): a failed step marks the handoff WRITEBACK_PENDING with attempts incremented from 0 to 1", async () => {
      client.addTags.mockRejectedValue(new Error("network error"));
      const handoff = HANDOFF({ attempts: 0 });

      await service.writeBack(CONNECTION(), handoff, CUSTOMER);

      expect(prisma.crmHandoff.update).toHaveBeenCalledTimes(1);
      const updateArg = prisma.crmHandoff.update.mock.calls[0][0] as {
        where: { id: string };
        data: { status: string; attempts: number };
      };
      expect(updateArg.where).toEqual({ id: "handoff-1" });
      expect(updateArg.data.status).toBe("WRITEBACK_PENDING");
      expect(updateArg.data.attempts).toBe(1);
    });

    it("T38 (R20): a failure on an already-5-attempts handoff marks it FAILED with a reason set, not WRITEBACK_PENDING", async () => {
      client.addTags.mockRejectedValue(new Error("network error"));
      const handoff = HANDOFF({ attempts: 5 });

      await service.writeBack(CONNECTION(), handoff, CUSTOMER);

      expect(prisma.crmHandoff.update).toHaveBeenCalledTimes(1);
      const updateArg = prisma.crmHandoff.update.mock.calls[0][0] as {
        where: { id: string };
        data: { status: string; reason?: string };
      };
      expect(updateArg.where).toEqual({ id: "handoff-1" });
      expect(updateArg.data.status).toBe("FAILED");
      expect(typeof updateArg.data.reason).toBe("string");
      expect(updateArg.data.reason?.length).toBeGreaterThan(0);
    });
  });

  describe("nextAttemptAt", () => {
    it("T37 (R20): follows the exact backoff table [1,5,15,60,240] minutes indexed by attempts", () => {
      const now = new Date("2026-09-11T00:00:00.000Z");

      expect(service.nextAttemptAt(1, now)).toEqual(new Date("2026-09-11T00:01:00.000Z"));
      expect(service.nextAttemptAt(3, now)).toEqual(new Date("2026-09-11T00:15:00.000Z"));
      expect(service.nextAttemptAt(5, now)).toEqual(new Date("2026-09-11T04:00:00.000Z"));
    });
  });
});
