// GoHighLevel handoff/match service (TP4, T22-T31, T51; spec R14-R18, R24). Fetches the GHL
// contact for a won/staged opportunity, matches it against an existing RouteFlow customer
// (ref -> email -> phone -> name, first hit wins) or creates one, tags the contact, and emits
// the operator notification + audit row. Write-back (R19) is delegated to an injected
// `writebackService` when the caller wires one — TP4's fixtures omit it, so the branch is
// inert there by design (see `GoHighLevelHandoffDeps.writebackService`).
//
// This service is deliberately constructed from a plain dependency bag (rather than Nest DI)
// so it can be unit-tested in isolation from the CrmModule wiring; the module may keep this
// shape or thread it through Nest DI as long as the exported class name and method signatures
// below are preserved.
//
// TENANT SCOPING (L-100): `tenantId` is an explicit argument on every lookup helper and is
// present in every Prisma `where` — a lead's email/phone/name must never match, or a username
// collide with, another tenant's rows.
import { randomBytes } from "crypto";
import { normalizeEmail, normalizePhoneE164, slugUsername } from "../crm-identity";
import type { GhlContact, GhlOpportunity } from "./gohighlevel.client";

export interface GoHighLevelHandoffDeps {
  /** PrismaService (or a tenant-scoped facade) — used via `deps.prisma.<model>.<method>`. */
  prisma: any;
  customersService: any;
  externalRefService: any;
  gateway: any;
  audit: any;
  logger: any;
  /** Default GHL client for this call — every TP4 fixture provides this directly. */
  ghlClient: any;
  /**
   * Optional production hook: builds a client bound to THIS connection's own decrypted
   * token/locationId (mirrors the poll service's `clientFactory`) — `deps.ghlClient`'s real
   * methods (besides `getLocation`) carry no per-call credential override, so a shared
   * singleton client cannot serve more than one tenant. When provided, its result is used
   * instead of `deps.ghlClient` for this call. Left undefined by every TP4 fixture, which
   * supplies an already-bound `ghlClient` mock directly.
   */
  resolveGhlClient?: (connection: unknown) => unknown;
  /**
   * Optional: builds the R19 write-back sequence for the client resolved above, invoked after
   * a CREATED/LINKED result. Left undefined by every TP4 fixture (they assert only
   * R14-R18/R24), so `handle()` skips write-back entirely when absent rather than reaching
   * into `deps.prisma`/config shapes those fixtures never provide.
   */
  writebackServiceFactory?: (ghlClient: unknown) => {
    writeBack(connection: unknown, handoff: unknown, customer: unknown): Promise<void>;
  };
}

export interface MatchResult {
  customerId: string;
  how: "ref" | "email" | "phone" | "name";
}

interface HandleConnection {
  id?: string;
  tenantId: string;
  region?: string;
  defaultRegion?: string;
  dryRun?: boolean;
  writeBackFields?: boolean;
  writeBackTag?: boolean;
  writeBackNote?: boolean;
  markWon?: boolean;
  customFieldIds?: Record<string, string> | null;
  [key: string]: unknown;
}

export interface HandleOpts {
  handoffId?: string;
  /**
   * M17: a per-poll-tick map of GHL tag name -> tag id, created by the poll service and shared
   * by every opportunity in that tick, so `listTags()` (the full location tag list) is fetched
   * at most once per tick instead of once per opportunity.
   */
  tagCache?: Map<string, string>;
}

/** Caches whose contents have already been filled from a `listTags()` call (M17). */
const LOADED_TAG_CACHES = new WeakSet<Map<string, string>>();

/** Phone-match scan cap — documented O(n) at pilot scale (build-plan WP3). */
const PHONE_SCAN_CAP = 5000;

function contactDisplayName(contact: GhlContact): string {
  const full = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  return contact.companyName || contact.name || full || "Unknown";
}

function buildNotes(opportunity: GhlOpportunity, contact: GhlContact): string {
  const source =
    opportunity.source ||
    opportunity.attributionSource?.utmSource ||
    opportunity.attributionSource?.campaign ||
    "";
  const country = (contact as { country?: string }).country ?? "";
  const notes =
    `From GoHighLevel · deal: ${opportunity.name ?? ""} · value: ${opportunity.monetaryValue ?? ""}` +
    ` · source: ${source} · country: ${country} · contact: ${contact.id}`;
  return notes.slice(0, 2000);
}

/** M8: the exact opportunity fields a retried DRY_RUN row needs to re-run unchanged. */
function storableOpportunity(opportunity: GhlOpportunity): Record<string, unknown> {
  return {
    id: opportunity.id,
    name: opportunity.name ?? null,
    monetaryValue: opportunity.monetaryValue ?? null,
    source: opportunity.source ?? null,
    contactId: opportunity.contactId,
    pipelineStageId: opportunity.pipelineStageId ?? null,
    status: opportunity.status ?? null,
    lastStageChangeAt: opportunity.lastStageChangeAt ?? null,
    lastStatusChangeAt: opportunity.lastStatusChangeAt ?? null,
  };
}

export class GoHighLevelHandoffService {
  constructor(private readonly deps: GoHighLevelHandoffDeps) {}

  /** Match precedence, first hit wins: ref -> email -> phone -> name (spec R15). */
  async matchExistingCustomer(
    tenantId: string,
    contact: GhlContact,
    region: string,
  ): Promise<MatchResult | null> {
    const ref = await this.deps.prisma.importExternalRef.findFirst({
      where: {
        tenantId,
        entityType: "CUSTOMER",
        // The model field is `externalSource` (see ImportExternalRef in platform.prisma) —
        // a `source` key is an unknown-argument error at the real client, which the unit
        // mocks (plain jest.fn()) could never surface.
        externalSource: "gohighlevel",
        externalId: contact.id,
      },
      select: { entityId: true },
    });
    if (ref) return { customerId: ref.entityId, how: "ref" };

    const email = contact.email ? normalizeEmail(contact.email) : null;
    if (email) {
      const byEmail = await this.deps.prisma.customer.findFirst({
        where: { tenantId, deletedAt: null, email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (byEmail) return { customerId: byEmail.id, how: "email" };
    }

    const phone = contact.phone ? normalizePhoneE164(contact.phone, region) : null;
    if (phone) {
      // M6: stored `phone`/`mobile` are free-form ("(555) 123-4567"), so the comparison has
      // to normalize BOTH sides — a direct column equality against the E.164 form never
      // matches. Candidates are scanned in memory, capped at PHONE_SCAN_CAP rows.
      const candidates =
        (await this.deps.prisma.customer.findMany({
          where: {
            tenantId,
            deletedAt: null,
            OR: [{ phone: { not: null } }, { mobile: { not: null } }],
          },
          select: { id: true, phone: true, mobile: true },
          take: PHONE_SCAN_CAP,
        })) ?? [];
      for (const row of candidates as Array<{
        id: string;
        phone?: string | null;
        mobile?: string | null;
      }>) {
        const candidate = row.phone ?? row.mobile;
        if (!candidate) continue;
        if (normalizePhoneE164(candidate, region) === phone) {
          return { customerId: row.id, how: "phone" };
        }
      }
    }

    const name = contact.companyName || contact.name;
    if (name) {
      const byName = await this.deps.prisma.customer.findFirst({
        where: { tenantId, deletedAt: null, businessName: { equals: name, mode: "insensitive" } },
        select: { id: true },
      });
      if (byName) return { customerId: byName.id, how: "name" };
    }

    return null;
  }

  /**
   * Looks up/creates `names` by exact GHL tag name, then assigns all of them in one call.
   * M17: when a per-tick `tagCache` is supplied, the location's tag list is fetched at most
   * once for the whole tick.
   */
  private async ensureTags(
    ghlClient: any,
    contactId: string,
    names: string[],
    tagCache?: Map<string, string>,
  ): Promise<void> {
    const known = tagCache ?? new Map<string, string>();
    if (!tagCache || !LOADED_TAG_CACHES.has(tagCache)) {
      const existing = (await ghlClient.listTags()) ?? [];
      for (const tag of existing as unknown[]) {
        if (typeof tag === "string") {
          known.set(tag, tag);
          continue;
        }
        const name = (tag as { name?: string })?.name;
        if (name) known.set(name, (tag as { id?: string })?.id ?? name);
      }
      if (tagCache) LOADED_TAG_CACHES.add(tagCache);
    }
    for (const name of names) {
      if (known.has(name)) continue;
      try {
        const created = await ghlClient.createTag(name);
        known.set(name, (created as { id?: string })?.id ?? name);
      } catch (e) {
        // A concurrent tick (or a stale cache) may have created this exact tag between our
        // `listTags()` and this call — GHL answers the duplicate with an error. Re-read the
        // list and reuse the existing id rather than failing the whole handoff; only a tag
        // that is still genuinely absent rethrows.
        const found = await this.findTagIdByName(ghlClient, name);
        if (found === undefined) throw e;
        known.set(name, found);
      }
    }
    await ghlClient.assignTag(contactId, names);
  }

  /** Re-reads the location tag list and returns the id of the tag with this exact name. */
  private async findTagIdByName(ghlClient: any, name: string): Promise<string | undefined> {
    const refreshed = (await ghlClient.listTags()) ?? [];
    for (const tag of refreshed as unknown[]) {
      if (typeof tag === "string") {
        if (tag === name) return tag;
        continue;
      }
      const tagName = (tag as { name?: string })?.name;
      if (tagName === name) return (tag as { id?: string })?.id ?? tagName;
    }
    return undefined;
  }

  private async resolveUsername(tenantId: string, businessName: string): Promise<string> {
    const base = slugUsername(businessName);
    for (let i = 0; i <= 20; i++) {
      const candidate = i === 0 ? base : `${base}_${i}`;
      // `User` is unique on (tenantId, username) — scoping here is what makes the collision
      // check match the real constraint.
      const existing = await this.deps.prisma.user.findFirst({
        where: { tenantId, username: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    return `${base}_${randomBytes(3).toString("hex")}`;
  }

  /**
   * F10: returns the updated row so the caller gets the handoff's REAL id (and its current
   * `attempts`/`noteWritten`) — on the normal poll path `opts.handoffId` is undefined, and a
   * write-back that failed with `where: {id: undefined}` silently left the row terminal.
   */
  private async updateHandoff(
    connection: HandleConnection,
    opportunity: GhlOpportunity,
    opts: HandleOpts,
    data: Record<string, unknown>,
  ): Promise<{ id?: string; attempts?: number; noteWritten?: boolean } | null> {
    const where = opts.handoffId
      ? { id: opts.handoffId }
      : {
          tenantId_provider_opportunityId: {
            tenantId: connection.tenantId,
            provider: "gohighlevel",
            opportunityId: opportunity.id,
          },
        };
    return (await this.deps.prisma.crmHandoff.update({ where, data })) ?? null;
  }

  private async runWriteback(
    ghlClient: any,
    connection: HandleConnection,
    handoffRef: {
      id?: string;
      status: "CREATED" | "LINKED";
      contactId: string;
      attempts: number;
      noteWritten: boolean;
    },
    opportunity: GhlOpportunity,
    customerId: string,
    businessName: string,
  ): Promise<void> {
    const writebackService = this.deps.writebackServiceFactory?.(ghlClient);
    if (!writebackService) return;
    try {
      await writebackService.writeBack(
        connection,
        {
          id: handoffRef.id,
          opportunityId: opportunity.id,
          contactId: handoffRef.contactId,
          status: handoffRef.status,
          // M3: real values from the persisted row, not hardcoded 0/false — otherwise every
          // retry restarts the R20 backoff and re-posts the R19(4) note.
          attempts: handoffRef.attempts,
          noteWritten: handoffRef.noteWritten,
        },
        { id: customerId, businessName },
      );
    } catch (e) {
      this.deps.logger?.warn?.(`crm write-back failed: ${(e as Error).message}`);
    }
  }

  /**
   * Process one opportunity: fetch its contact, match-or-create the RouteFlow customer,
   * tag it, notify + audit, and (when wired) trigger write-back. `opts` may carry
   * `handoffId` when re-invoked by `retryHandoff` on an already-existing row.
   */
  async handle(
    connectionInput: unknown,
    opportunityInput: unknown,
    optsInput?: unknown,
  ): Promise<unknown> {
    const connection = connectionInput as HandleConnection;
    const opportunity = opportunityInput as GhlOpportunity;
    const opts = (optsInput ?? {}) as HandleOpts;
    const region = connection.region ?? connection.defaultRegion ?? "US";
    const tenantId = connection.tenantId;
    const dryRun = !!connection.dryRun;
    const ghlClient = this.deps.resolveGhlClient
      ? this.deps.resolveGhlClient(connection)
      : this.deps.ghlClient;

    // M4: a WRITEBACK_PENDING row whose RouteFlow side already succeeded resumes at write-back
    // only — re-running the forward path would re-tag, re-audit and fire a SECOND
    // "customer linked/created" notification for the same customer.
    if (opts.handoffId) {
      const existing = await this.deps.prisma.crmHandoff.findFirst?.({
        where: { id: opts.handoffId, tenantId },
      });
      if (existing?.customerId && existing.status === "WRITEBACK_PENDING") {
        const terminal: "CREATED" | "LINKED" = existing.matchedBy ? "LINKED" : "CREATED";
        await this.runWriteback(
          ghlClient,
          connection,
          {
            id: existing.id ?? opts.handoffId,
            status: terminal,
            contactId: existing.contactId,
            attempts: existing.attempts ?? 0,
            noteWritten: !!existing.noteWritten,
          },
          opportunity,
          existing.customerId,
          existing.contactName ?? "",
        );
        return { status: terminal, customerId: existing.customerId };
      }
    }

    let contact: GhlContact;
    try {
      contact = await ghlClient.getContact(opportunity.contactId);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      const reason = status === 404 ? "contact-not-found" : "contact-fetch-failed";
      await this.updateHandoff(connection, opportunity, opts, {
        status: "NEEDS_REVIEW",
        reason,
      });
      return { status: "NEEDS_REVIEW", reason };
    }

    const match = await this.matchExistingCustomer(tenantId, contact, region);

    if (dryRun) {
      const email = contact.email ? normalizeEmail(contact.email) : null;
      const phone = contact.phone ? normalizePhoneE164(contact.phone, region) : null;
      await this.updateHandoff(connection, opportunity, opts, {
        status: "DRY_RUN",
        matchedBy: match?.how ?? null,
        payload: {
          action: match ? "link" : "create",
          matchedBy: match?.how,
          // M8: keep the opportunity itself so "Retry" on a DRY_RUN row does not lose the
          // deal name/value/source (the client has no single-opportunity GET).
          opportunity: storableOpportunity(opportunity),
          preview: {
            businessName: contactDisplayName(contact),
            contactName: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
            email,
            phone,
            address: contact.address1 || undefined,
          },
          writeBack: {
            fields: connection.writeBackFields ?? true,
            tag: connection.writeBackTag ?? true,
            note: connection.writeBackNote ?? true,
            markWon: connection.markWon ?? false,
          },
        },
      });
      return { status: "DRY_RUN" };
    }

    if (match) {
      await this.ensureTags(ghlClient, contact.id, ["GoHighLevel"], opts.tagCache);
      await this.deps.externalRefService.record(
        "CUSTOMER",
        match.customerId,
        "gohighlevel",
        contact.id,
      );
      const row = await this.updateHandoff(connection, opportunity, opts, {
        status: "LINKED",
        customerId: match.customerId,
        matchedBy: match.how,
      });
      const customerName = contactDisplayName(contact);
      await this.deps.gateway.emitCrmHandoff(tenantId, {
        customerId: match.customerId,
        customerName,
        status: "LINKED",
        source: "gohighlevel",
      });
      await this.deps.audit.log({
        tenantId,
        userId: null,
        action: "crm.handoff.linked",
        entityType: "customer",
        entityId: match.customerId,
        meta: { opportunityId: opportunity.id, contactId: contact.id, matchedBy: match.how },
      });
      await this.runWriteback(
        ghlClient,
        connection,
        {
          id: opts.handoffId ?? row?.id,
          status: "LINKED",
          contactId: contact.id,
          attempts: row?.attempts ?? 0,
          noteWritten: !!row?.noteWritten,
        },
        opportunity,
        match.customerId,
        customerName,
      );
      return { status: "LINKED", customerId: match.customerId };
    }

    const email = contact.email ? normalizeEmail(contact.email) : null;
    const phone = contact.phone ? normalizePhoneE164(contact.phone, region) : null;
    if (!email && !phone) {
      await this.updateHandoff(connection, opportunity, opts, {
        status: "NEEDS_REVIEW",
        reason: "no-identity",
      });
      return { status: "NEEDS_REVIEW", reason: "no-identity" };
    }

    const businessName = contactDisplayName(contact);
    const contactName =
      [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
      contact.name ||
      businessName;
    const username = await this.resolveUsername(tenantId, businessName);
    const notes = buildNotes(opportunity, contact);
    const addresses = contact.address1
      ? [
          {
            label: "Billing",
            line1: contact.address1,
            city: contact.city ?? "",
            state: contact.state ?? "",
            zip: contact.postalCode ?? "",
            isDefault: true,
            addressType: "BILLING",
          },
        ]
      : undefined;

    let created: { id: string; tempPassword?: string };
    try {
      created = await this.deps.customersService.create({
        username,
        businessName,
        contactName,
        firstName: contact.firstName ?? undefined,
        lastName: contact.lastName ?? undefined,
        email: email ?? undefined,
        phone: phone ?? contact.phone ?? undefined,
        customerType: contact.companyName ? "BUSINESS" : "INDIVIDUAL",
        notes,
        addresses,
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      const message = (e as Error)?.message ?? "";
      let reason = "create-failed";
      if (name === "BadRequestException") reason = "identity-conflict";
      else if (name === "CustomerCapExceededException" || /customer.?cap/i.test(message)) {
        reason = "customer-cap";
      }
      await this.updateHandoff(connection, opportunity, opts, {
        status: "NEEDS_REVIEW",
        reason,
        ...(reason === "create-failed" ? { payload: { message } } : {}),
      });
      return { status: "NEEDS_REVIEW", reason };
    }
    // `created.tempPassword` is intentionally never read again — spec R16: discarded, never
    // logged, never persisted on the handoff row.

    await this.ensureTags(
      ghlClient,
      contact.id,
      ["GoHighLevel", "Needs onboarding"],
      opts.tagCache,
    );
    await this.deps.externalRefService.record("CUSTOMER", created.id, "gohighlevel", contact.id);
    const row = await this.updateHandoff(connection, opportunity, opts, {
      status: "CREATED",
      customerId: created.id,
    });
    await this.deps.gateway.emitCrmHandoff(tenantId, {
      customerId: created.id,
      customerName: businessName,
      status: "CREATED",
      source: "gohighlevel",
    });
    await this.deps.audit.log({
      tenantId,
      userId: null,
      action: "crm.handoff.created",
      entityType: "customer",
      entityId: created.id,
      meta: { opportunityId: opportunity.id, contactId: contact.id },
    });
    await this.runWriteback(
      ghlClient,
      connection,
      {
        id: opts.handoffId ?? row?.id,
        status: "CREATED",
        contactId: contact.id,
        attempts: row?.attempts ?? 0,
        noteWritten: !!row?.noteWritten,
      },
      opportunity,
      created.id,
      businessName,
    );
    return { status: "CREATED", customerId: created.id };
  }
}
