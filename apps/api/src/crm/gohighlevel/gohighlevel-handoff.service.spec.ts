import { ImportEntityType } from "@prisma/client";
import { GoHighLevelHandoffService } from "./gohighlevel-handoff.service";
import { GoHighLevelWritebackService } from "./gohighlevel-writeback.service";
import { CrmHttpError } from "./gohighlevel.client";
import type { GhlContact, GhlOpportunity } from "../crm.types";

/**
 * TP4 — handoff service (T22-T31, T51). See
 * .claude/pipeline/2026-09-11-crm-gohighlevel-handoff/test-plan.md §3 for the oracle
 * behind every assertion below.
 *
 * The service is built from a plain dependency bag (see gohighlevel-handoff.service.ts)
 * rather than Nest DI, so collaborators here are hand-rolled jest.fn() doubles — no
 * import of the not-yet-built CustomersService/ExternalRefService/gateway/audit
 * modules is required to exercise the contract.
 */

function makeDeps() {
  const prisma: any = {
    importExternalRef: { findFirst: jest.fn().mockResolvedValue(null) },
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    crmConnection: { update: jest.fn().mockResolvedValue({}) },
    crmHandoff: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: "h1", attempts: 0, noteWritten: false }),
    },
  };
  const customersService = { create: jest.fn().mockResolvedValue({ id: "cust-1" }) };
  const externalRefService = { record: jest.fn().mockResolvedValue(undefined) };
  const gateway = { emitCrmHandoff: jest.fn() };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const ghlClient = {
    getContact: jest.fn(),
    // M10: the real `listTags()` returns `GhlTag[]` objects, never plain strings — mocking
    // strings here never exercised `ensureTags`'s object-shape branch.
    listTags: jest.fn().mockResolvedValue([]),
    createTag: jest.fn().mockResolvedValue({ id: "tag-new", name: "tag-new" }),
    assignTag: jest.fn().mockResolvedValue(undefined),
    updateContactCustomFields: jest.fn().mockResolvedValue(undefined),
    addTags: jest.fn().mockResolvedValue(undefined),
    createNote: jest.fn().mockResolvedValue(undefined),
    updateOpportunityStatus: jest.fn().mockResolvedValue(undefined),
  };

  return { prisma, customersService, externalRefService, gateway, audit, logger, ghlClient };
}

/** Wire prisma.customer.findFirst so it resolves `customer` only when the query
 * (stringified) mentions `needle` — precedence-agnostic to the exact `where` shape
 * the implementation ends up using for the email/name lookups. */
function mockCustomerMatch(prisma: any, needle: string, customer: unknown) {
  prisma.customer.findFirst.mockImplementation((args: unknown) => {
    const haystack = JSON.stringify(args ?? {}).toLowerCase();
    return Promise.resolve(haystack.includes(needle.toLowerCase()) ? customer : null);
  });
}

const opportunity: GhlOpportunity = {
  id: "opp-1",
  name: "Big Order",
  monetaryValue: 1200,
  pipelineId: "p1",
  pipelineStageId: "s1",
  contactId: "contact-1",
};

const connection = { id: "conn-1", tenantId: "t1", region: "CA", locationId: "loc-1" };

describe("GoHighLevelHandoffService.matchExistingCustomer (T22-T25, R15)", () => {
  it("T22 — ref match wins over an email match (first hit wins)", async () => {
    const deps = makeDeps();
    deps.prisma.importExternalRef.findFirst.mockResolvedValue({ entityId: "c-ref" });
    mockCustomerMatch(deps.prisma, "foo@x.com", { id: "c-email" });
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = { id: "contact-1", email: "foo@x.com" };
    const result = await service.matchExistingCustomer("t1", contact, "CA");

    expect(result).toEqual({ customerId: "c-ref", how: "ref" });
    // Precedence, not just "a ref exists": the email lookup must never even run.
    expect(deps.prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("T23 — email match is case-insensitive", async () => {
    const deps = makeDeps();
    mockCustomerMatch(deps.prisma, "foo@x.com", { id: "c-email", email: "FOO@x.com" });
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = { id: "contact-1", email: "foo@x.com" };
    const result = await service.matchExistingCustomer("t1", contact, "CA");

    expect(result).toEqual({ customerId: "c-email", how: "email" });
  });

  it("T24 — phone match compares normalized E.164 values", async () => {
    const deps = makeDeps();
    deps.prisma.customer.findMany.mockResolvedValue([
      { id: "c-other", phone: "416-555-9999", mobile: null },
      { id: "c-phone", phone: "(416) 555-0134", mobile: null },
    ]);
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = { id: "contact-1", phone: "416-555-0134" };
    const result = await service.matchExistingCustomer("t1", contact, "CA");

    expect(result).toEqual({ customerId: "c-phone", how: "phone" });
  });

  // M6 — the bug this replaces: a stored, unnormalized US number never matched the E.164
  // form GHL sends. Both sides are normalized in memory now.
  //
  // NOTE on the literal: the fix plan's example pair was "(555) 123-4567" / "+15551234567",
  // but 555-1234567 has no valid NANP area code, so `normalizePhoneE164` (which requires
  // `isValid()`, spec R25) returns null for BOTH sides and the pair can never match by
  // construction. "(212) 555-0134" / "+12125550134" is the same formatted-vs-E.164 shape
  // with a number libphonenumber-js actually accepts.
  it("M6 — a stored '(212) 555-0134' matches a GHL contact phone of '+12125550134' in region US", async () => {
    const deps = makeDeps();
    deps.prisma.customer.findMany.mockResolvedValue([
      { id: "c-other", phone: "(212) 736-5000", mobile: null },
      { id: "c-us", phone: "(212) 555-0134", mobile: null },
    ]);
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = { id: "contact-1", phone: "+12125550134" };
    const result = await service.matchExistingCustomer("t1", contact, "US");

    expect(result).toEqual({ customerId: "c-us", how: "phone" });
    const args = deps.prisma.customer.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ tenantId: "t1", deletedAt: null });
    expect(args.take).toBe(5000);
  });

  it("T25 — business-name match is case-insensitive", async () => {
    const deps = makeDeps();
    mockCustomerMatch(deps.prisma, "acme foods", { id: "c-name", businessName: "Acme Foods" });
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = { id: "contact-1", companyName: "acme foods" };
    const result = await service.matchExistingCustomer("t1", contact, "CA");

    expect(result).toEqual({ customerId: "c-name", how: "name" });
  });

  it("T22b — an ExternalRef match wins over a business-name match", async () => {
    const deps = makeDeps();
    deps.prisma.importExternalRef.findFirst.mockResolvedValue({ entityId: "c-ref" });
    // Distinguish the name-path findFirst by its where clause: only businessName lookups
    // resolve to a customer here, so a name-first ordering would wrongly surface "c-name".
    deps.prisma.customer.findFirst.mockImplementation((args: any) => {
      if (args?.where?.businessName) return Promise.resolve({ id: "c-name" });
      return Promise.resolve(null);
    });
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = { id: "contact-1", companyName: "Acme Foods" };
    const result = await service.matchExistingCustomer("t1", contact, "CA");

    expect(result).toEqual({ customerId: "c-ref", how: "ref" });
    // Precedence, not just "a ref exists": the name-path lookup must never even run.
    expect(deps.prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("T22c — an email match wins over a phone match", async () => {
    const deps = makeDeps();
    // Distinguish the email-path findFirst by its where clause: only email lookups resolve.
    deps.prisma.customer.findFirst.mockImplementation((args: any) => {
      if (args?.where?.email) return Promise.resolve({ id: "c-email" });
      return Promise.resolve(null);
    });
    deps.prisma.customer.findMany.mockResolvedValue([
      { id: "c-phone", phone: "416-555-0134", mobile: null },
    ]);
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = { id: "contact-1", email: "foo@x.com", phone: "416-555-0134" };
    const result = await service.matchExistingCustomer("t1", contact, "CA");

    expect(result).toEqual({ customerId: "c-email", how: "email" });
    // Precedence, not just "an email match exists": the phone-candidate scan must never run.
    expect(deps.prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it("T22d — a phone match wins over a business-name match", async () => {
    const deps = makeDeps();
    // Email path misses (contact carries no email); name-path findFirst would hit "c-name"
    // if the phone check were skipped or run after it.
    deps.prisma.customer.findFirst.mockImplementation((args: any) => {
      if (args?.where?.businessName) return Promise.resolve({ id: "c-name" });
      return Promise.resolve(null);
    });
    deps.prisma.customer.findMany.mockResolvedValue([
      { id: "c-phone", phone: "416-555-0134", mobile: null },
    ]);
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = {
      id: "contact-1",
      phone: "416-555-0134",
      companyName: "Acme Foods",
    };
    const result = await service.matchExistingCustomer("t1", contact, "CA");

    expect(result).toEqual({ customerId: "c-phone", how: "phone" });
    // Precedence, not just "a phone match exists": the name-path lookup must never even run.
    expect(deps.prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  // #1 (blocker) — the ref lookup must use the model's real column name. `source` is not a
  // field of ImportExternalRef, so the real Prisma client rejects the query outright; only
  // the hand-rolled mock ever accepted it.
  it("#1 — the ExternalRef lookup filters on externalSource, never on a `source` key", async () => {
    const deps = makeDeps();
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = { id: "contact-9" };
    await service.matchExistingCustomer("t1", contact, "CA");

    const where = deps.prisma.importExternalRef.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenantId: "t1",
      entityType: "CUSTOMER",
      externalSource: "gohighlevel",
      externalId: "contact-9",
    });
    expect(where).not.toHaveProperty("source");
  });

  // F7 (IDOR) / L-100 — every lookup on the match path is scoped to the caller's tenant
  it("F7 — every match lookup carries where.tenantId === 't1'", async () => {
    const deps = makeDeps();
    const service = new GoHighLevelHandoffService(deps);

    const contact: GhlContact = {
      id: "contact-1",
      email: "foo@x.com",
      phone: "+14165550134",
      companyName: "Acme Foods",
    };
    const result = await service.matchExistingCustomer("t1", contact, "CA");

    expect(result).toBeNull();
    expect(deps.prisma.importExternalRef.findFirst.mock.calls[0][0].where.tenantId).toBe("t1");
    for (const call of deps.prisma.customer.findFirst.mock.calls) {
      expect(call[0].where.tenantId).toBe("t1");
    }
    for (const call of deps.prisma.customer.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe("t1");
    }
    expect(deps.prisma.customer.findFirst).toHaveBeenCalledTimes(2); // email + name
    expect(deps.prisma.customer.findMany).toHaveBeenCalledTimes(1); // phone candidates
  });
});

describe("GoHighLevelHandoffService.handle (T26-T31, T51)", () => {
  const noMatchContact: GhlContact = {
    id: "contact-1",
    companyName: "Acme Foods",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@acme.com",
    phone: "4165550134",
    address1: "1 Main St",
    city: "Toronto",
    state: "ON",
    country: "CA",
    postalCode: "M1M1M1",
  };

  it("T26 — no identity match creates a customer with the R16 field shape", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);

    await service.handle(connection, opportunity, {});

    expect(deps.customersService.create).toHaveBeenCalledTimes(1);
    const dto = deps.customersService.create.mock.calls[0][0];
    expect(dto).toMatchObject({
      username: expect.any(String),
      businessName: "Acme Foods",
      contactName: "Jane Doe",
      email: "jane@acme.com",
      phone: "+14165550134",
      customerType: "BUSINESS",
      addresses: [expect.objectContaining({ label: "Billing" })],
    });
    expect(dto.notes as string).toMatch(/^From GoHighLevel · deal: Big Order · value: 1200/);
  });

  it("T27 — a taken username gets a numeric collision suffix", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    deps.prisma.user.findFirst
      .mockResolvedValueOnce({ id: "u-existing" }) // "acme_foods" is taken
      .mockResolvedValueOnce(null); // "acme_foods_1" is free
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);

    await service.handle(connection, opportunity, {});

    expect(deps.customersService.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: "acme_foods_1" }),
    );
    // F7: `User` is unique on (tenantId, username) — the collision probe is tenant-scoped.
    expect(deps.prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" });
  });

  it("T28 — no email/phone on the contact → NEEDS_REVIEW reason no-identity, no customer created", async () => {
    const deps = makeDeps();
    const identityless: GhlContact = { id: "contact-1", companyName: "Acme Foods" };
    deps.ghlClient.getContact.mockResolvedValue(identityless);
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);

    await service.handle(connection, opportunity, {});

    expect(deps.customersService.create).not.toHaveBeenCalled();
    expect(deps.prisma.crmHandoff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_REVIEW", reason: "no-identity" }),
      }),
    );
  });

  it("T29 — CustomersService.create throwing BadRequestException → NEEDS_REVIEW reason identity-conflict", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    deps.customersService.create.mockRejectedValue(
      Object.assign(new Error("Email or username already taken"), {
        name: "BadRequestException",
      }),
    );
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);

    await service.handle(connection, opportunity, {});

    expect(deps.prisma.crmHandoff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_REVIEW", reason: "identity-conflict" }),
      }),
    );
  });

  it("T30 — the returned tempPassword is discarded and never logged", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    deps.customersService.create.mockResolvedValue({ id: "cust-1", tempPassword: "abc123" });
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);

    await service.handle(connection, opportunity, {});

    // Positive half: the handoff really did complete via CustomersService.create —
    // otherwise the negative assertions below would pass vacuously.
    expect(deps.customersService.create).toHaveBeenCalledTimes(1);

    const loggerCallsText = JSON.stringify([
      ...deps.logger.log.mock.calls,
      ...deps.logger.warn.mock.calls,
      ...deps.logger.error.mock.calls,
      ...deps.logger.debug.mock.calls,
    ]);
    expect(loggerCallsText).not.toContain("abc123");

    const handoffUpdateText = JSON.stringify(deps.prisma.crmHandoff.update.mock.calls);
    expect(handoffUpdateText).not.toContain("abc123");
  });

  it("T31 — CREATED path: creates only the missing tag, links external ref, emits + audits", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    // M10: real `GhlTag[]` objects, not strings.
    deps.ghlClient.listTags.mockResolvedValue([{ id: "tag-ghl", name: "GoHighLevel" }]);
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);

    await service.handle(connection, opportunity, {});

    // Idempotent tagging: only the missing tag is created; both are assigned.
    expect(deps.ghlClient.createTag).toHaveBeenCalledTimes(1);
    expect(deps.ghlClient.createTag).toHaveBeenCalledWith("Needs onboarding");
    expect(deps.ghlClient.createTag).not.toHaveBeenCalledWith("GoHighLevel");
    expect(deps.ghlClient.assignTag).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["GoHighLevel", "Needs onboarding"]),
    );

    expect(deps.externalRefService.record).toHaveBeenCalledWith(
      ImportEntityType.CUSTOMER,
      "cust-1",
      "gohighlevel",
      "contact-1",
    );
    expect(deps.gateway.emitCrmHandoff).toHaveBeenCalledWith("t1", {
      customerId: "cust-1",
      customerName: "Acme Foods",
      status: "CREATED",
      source: "gohighlevel",
    });
    expect(deps.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm.handoff.created" }),
    );
  });

  it("T31b — LINKED path: only the missing standard tag is assigned, nothing created twice", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    deps.ghlClient.listTags.mockResolvedValue([]);
    const service = new GoHighLevelHandoffService(deps);
    jest
      .spyOn(service, "matchExistingCustomer")
      .mockResolvedValue({ customerId: "c-ref", how: "ref" });

    await service.handle(connection, opportunity, {});

    expect(deps.customersService.create).not.toHaveBeenCalled();
    expect(deps.ghlClient.assignTag).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["GoHighLevel"]),
    );
    expect(deps.ghlClient.assignTag).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["Needs onboarding"]),
    );
  });

  // M17 — one shared tag cache across a tick means exactly one listTags() call
  it("M17 — a shared tagCache makes listTags run once across two handle() calls", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    deps.ghlClient.listTags.mockResolvedValue([
      { id: "tag-ghl", name: "GoHighLevel" },
      { id: "tag-onb", name: "Needs onboarding" },
    ]);
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue({
      customerId: "c-ref",
      how: "ref",
    });
    const tagCache = new Map<string, string>();

    await service.handle(connection, opportunity, { tagCache });
    await service.handle(connection, { ...opportunity, id: "opp-2" }, { tagCache });

    expect(deps.ghlClient.listTags).toHaveBeenCalledTimes(1);
    expect(deps.ghlClient.createTag).not.toHaveBeenCalled();
    expect(deps.ghlClient.assignTag).toHaveBeenCalledTimes(2);
  });

  // #3 — GHL answers a duplicate tag name with an error (a concurrent tick, or a tag created
  // since our cached listTags). Recover by re-reading the list and reusing the existing id;
  // a lost handoff over a tag that already exists is the wrong trade.
  it("#3 — a rejected createTag re-reads listTags and reuses the existing tag id", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    deps.ghlClient.listTags.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "tag-ghl", name: "GoHighLevel" },
      { id: "tag-onb", name: "Needs onboarding" },
    ]);
    deps.ghlClient.createTag
      .mockRejectedValueOnce(new CrmHttpError(409, "conflict", "tag already exists"))
      .mockResolvedValue({ id: "tag-onb", name: "Needs onboarding" });
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);
    const tagCache = new Map<string, string>();

    const result = (await service.handle(connection, opportunity, { tagCache })) as {
      status: string;
    };

    expect(result.status).toBe("CREATED");
    expect(deps.ghlClient.listTags).toHaveBeenCalledTimes(2);
    expect(tagCache.get("GoHighLevel")).toBe("tag-ghl");
    expect(deps.ghlClient.assignTag).toHaveBeenCalledWith(
      "contact-1",
      expect.arrayContaining(["GoHighLevel", "Needs onboarding"]),
    );
  });

  // #3 — a tag that is still absent after the re-read is a real failure, not a duplicate.
  it("#3 — createTag rejecting for a tag that is still absent rethrows", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    deps.ghlClient.listTags.mockResolvedValue([]);
    deps.ghlClient.createTag.mockRejectedValue(new CrmHttpError(500, "server_error", "boom"));
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue({
      customerId: "c-ref",
      how: "ref",
    });

    await expect(service.handle(connection, opportunity, {})).rejects.toThrow(/boom/);
    expect(deps.ghlClient.assignTag).not.toHaveBeenCalled();
  });

  // M8 — a dry-run row keeps the whole opportunity so "Retry" can replay it verbatim
  it("M8 — the dry-run payload stores the opportunity (name, value, source) for retry", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    const service = new GoHighLevelHandoffService(deps);
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);

    await service.handle(
      { ...connection, dryRun: true },
      { ...opportunity, source: "facebook" },
      {},
    );

    const call = deps.prisma.crmHandoff.update.mock.calls[0][0];
    expect(call.data.status).toBe("DRY_RUN");
    expect(call.data.payload.opportunity).toMatchObject({
      id: "opp-1",
      name: "Big Order",
      monetaryValue: 1200,
      source: "facebook",
      contactId: "contact-1",
    });
  });

  // M4 — a WRITEBACK_PENDING row that already has a customer resumes at write-back ONLY
  it("M4 — a write-back retry skips match/create/tags and emits no second notification", async () => {
    const deps = makeDeps();
    deps.prisma.crmHandoff.findFirst.mockResolvedValue({
      id: "h1",
      tenantId: "t1",
      status: "WRITEBACK_PENDING",
      customerId: "cust-9",
      contactId: "contact-1",
      contactName: "Acme Foods",
      matchedBy: "email",
      attempts: 2,
      noteWritten: true,
    });
    const writeBack = jest.fn().mockResolvedValue(undefined);
    const service = new GoHighLevelHandoffService({
      ...deps,
      writebackServiceFactory: () => ({ writeBack }),
    });

    const result = await service.handle(connection, opportunity, { handoffId: "h1" });

    expect(result).toEqual({ status: "LINKED", customerId: "cust-9" });
    expect(deps.ghlClient.getContact).not.toHaveBeenCalled();
    expect(deps.customersService.create).not.toHaveBeenCalled();
    expect(deps.ghlClient.assignTag).not.toHaveBeenCalled();
    expect(deps.gateway.emitCrmHandoff).not.toHaveBeenCalled();
    expect(deps.audit.log).not.toHaveBeenCalled();
    // M3: the real attempts/noteWritten reach the write-back, so the backoff keeps counting
    // and the R19(4) note is not re-posted.
    expect(writeBack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "h1", attempts: 2, noteWritten: true }),
      expect.objectContaining({ id: "cust-9" }),
    );
  });

  // F10 + M3 — the write-back receives the handoff's REAL id on the normal poll path, so a
  // failure actually reopens the row (it used to update `where: {id: undefined}` and swallow).
  it("F10 — a failing write-back on a fresh handoff persists WRITEBACK_PENDING with attempts 1", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    deps.ghlClient.addTags.mockRejectedValue(new Error("network error"));
    const wbConnection = {
      ...connection,
      customFieldIds: {
        "contact.routeflow_customer_id": "f-id",
        "contact.routeflow_link": "f-link",
        "contact.routeflow_status": "f-status",
      },
      writeBackFields: true,
      writeBackTag: true,
      writeBackNote: true,
      markWon: false,
    };
    const service = new GoHighLevelHandoffService({
      ...deps,
      writebackServiceFactory: (client) =>
        new GoHighLevelWritebackService(client as never, deps.prisma as never, {
          get: () => "https://web.test",
        }),
    });
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);

    await service.handle(wbConnection, opportunity, {});

    const reopen = deps.prisma.crmHandoff.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === "WRITEBACK_PENDING",
    );
    expect(reopen?.[0]).toMatchObject({ where: { id: "h1" } });
    expect(reopen?.[0]?.data).toEqual(
      expect.objectContaining({ status: "WRITEBACK_PENDING", attempts: 1 }),
    );
  });

  // M3 — a successful note is recorded so a later retry never re-posts it
  it("M3 — a successful write-back note persists noteWritten: true on the handoff row", async () => {
    const deps = makeDeps();
    deps.ghlClient.getContact.mockResolvedValue(noMatchContact);
    const wbConnection = {
      ...connection,
      customFieldIds: {
        "contact.routeflow_customer_id": "f-id",
        "contact.routeflow_link": "f-link",
        "contact.routeflow_status": "f-status",
      },
      writeBackFields: true,
      writeBackTag: true,
      writeBackNote: true,
      markWon: false,
    };
    const service = new GoHighLevelHandoffService({
      ...deps,
      writebackServiceFactory: (client) =>
        new GoHighLevelWritebackService(client as never, deps.prisma as never, {
          get: () => "https://web.test",
        }),
    });
    jest.spyOn(service, "matchExistingCustomer").mockResolvedValue(null);

    await service.handle(wbConnection, opportunity, {});

    expect(deps.ghlClient.createNote).toHaveBeenCalledTimes(1);
    // #2: the flag is persisted in its own write right after createNote, and the terminal
    // status is restored by the end-of-sequence write.
    const noteWrite = deps.prisma.crmHandoff.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.noteWritten === true,
    );
    expect(noteWrite?.[0]).toMatchObject({ where: { id: "h1" }, data: { noteWritten: true } });
    const statusWrite = deps.prisma.crmHandoff.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.processedAt,
    );
    expect(statusWrite?.[0]?.data?.status).toBe("CREATED");
  });

  it("T51 — a 404 on getContact marks the handoff NEEDS_REVIEW reason contact-not-found, no writes", async () => {
    const deps = makeDeps();
    // M9: the real ctor is (status, code, message) — no post-hoc monkey-patching.
    const notFound = new CrmHttpError(404, "http", "GoHighLevel 404");
    deps.ghlClient.getContact.mockRejectedValue(notFound);
    const service = new GoHighLevelHandoffService(deps);
    const matchSpy = jest.spyOn(service, "matchExistingCustomer");

    await service.handle(connection, opportunity, {});

    expect(deps.prisma.crmHandoff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_REVIEW", reason: "contact-not-found" }),
      }),
    );
    expect(deps.customersService.create).not.toHaveBeenCalled();
    expect(deps.ghlClient.updateContactCustomFields).not.toHaveBeenCalled();
    expect(deps.ghlClient.addTags).not.toHaveBeenCalled();
    expect(deps.ghlClient.createNote).not.toHaveBeenCalled();
    expect(matchSpy).not.toHaveBeenCalled();
  });
});
