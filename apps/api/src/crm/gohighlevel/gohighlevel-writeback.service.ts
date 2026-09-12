// GoHighLevel write-back service (TP5, T32-T38; spec R19/R20). Pushes the RouteFlow-side
// result of a CREATED/LINKED handoff back onto the GHL contact: three custom fields, the
// `routeflow-customer` tag, an idempotent note, and (optionally) a won-status flip on the
// opportunity. Every step is idempotent and independently toggle-able; a failure anywhere
// reopens the handoff as WRITEBACK_PENDING with the R20 backoff, or FAILED after 5 attempts.
import { GoHighLevelClient, type GhlCustomField } from "./gohighlevel.client";

export interface WritebackCrmConnectionRow {
  id: string;
  tenantId: string;
  customFieldIds?: Record<string, string> | null;
  writeBackFields: boolean;
  writeBackTag: boolean;
  writeBackNote: boolean;
  markWon: boolean;
}

export interface WritebackCrmHandoffRow {
  id: string;
  opportunityId: string;
  contactId: string;
  status: string;
  attempts: number;
  noteWritten: boolean;
}

export interface WritebackCustomer {
  id: string;
  businessName?: string | null;
}

/** Narrow surface of PrismaService this service needs (hand-mocked in tests). */
export interface WritebackPrismaModels {
  crmConnection: { update: (...args: unknown[]) => Promise<unknown> };
  crmHandoff: { update: (...args: unknown[]) => Promise<unknown> };
}

export interface WritebackConfigService {
  get: (key: string) => string | undefined;
}

/** `fieldKey` -> label used to create it when missing (spec R19(1)). Order is display-only. */
const CUSTOM_FIELD_DEFS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "contact.routeflow_customer_id", label: "RouteFlow Customer ID" },
  { key: "contact.routeflow_link", label: "RouteFlow Link" },
  { key: "contact.routeflow_status", label: "RouteFlow Status" },
];

/** Minutes by attempt (1-based, capped at 5) — spec R20's exact backoff table. */
const BACKOFF_MINUTES: readonly number[] = [1, 5, 15, 60, 240];

export class GoHighLevelWritebackService {
  constructor(
    private readonly client: GoHighLevelClient,
    private readonly prisma: WritebackPrismaModels,
    private readonly config: WritebackConfigService,
  ) {}

  /** GET existing custom fields, create only the missing ones, cache all three ids (R19(1)). */
  async ensureCustomFields(connection: WritebackCrmConnectionRow): Promise<Record<string, string>> {
    const existing = ((await this.client.listCustomFields()) ?? []) as GhlCustomField[];
    const byKey = new Map<string, string>();
    for (const field of existing) {
      if (field?.fieldKey && field.id) byKey.set(field.fieldKey, field.id);
    }
    for (const def of CUSTOM_FIELD_DEFS) {
      if (!byKey.has(def.key)) {
        const created = await this.client.createCustomField(def.label);
        if (created?.id) byKey.set(def.key, created.id);
      }
    }
    const customFieldIds: Record<string, string> = {};
    for (const def of CUSTOM_FIELD_DEFS) {
      const id = byKey.get(def.key);
      if (id) customFieldIds[def.key] = id;
    }
    await this.prisma.crmConnection.update({
      where: { id: connection.id },
      data: { customFieldIds },
    });
    return customFieldIds;
  }

  private webLink(customerId: string): string {
    const webBase = this.config.get("urls.web") ?? "";
    return `${webBase}/customers/${customerId}`;
  }

  /**
   * Runs the R19 sequence — fields, tag, note, won-status — each gated by its own toggle and
   * each idempotent (the note is guarded by `noteWritten`, the fields PUT is a full overwrite,
   * the tag assignment is idempotent by name). A failure anywhere reopens the row per R20.
   */
  async writeBack(
    connection: WritebackCrmConnectionRow,
    handoff: WritebackCrmHandoffRow,
    customer: WritebackCustomer,
  ): Promise<void> {
    // F10: the caller must hand us the handoff's REAL id — an `update({where:{id:undefined}})`
    // is rejected by Prisma and (being inside this method's own catch) used to be swallowed,
    // leaving a failed write-back terminal forever. Guard instead of writing garbage.
    const canPersist = typeof handoff.id === "string" && handoff.id.length > 0;
    if (!canPersist) {
      // Nothing can be recorded about the outcome, so do not touch GHL either — the poll's
      // next tick will re-handle the row with a real id.
      throw new Error("write-back called without a persisted handoff id");
    }
    try {
      if (connection.writeBackFields) {
        let fieldIds = (connection.customFieldIds ?? {}) as Record<string, string>;
        const hasAll = CUSTOM_FIELD_DEFS.every((def) => !!fieldIds[def.key]);
        if (!hasAll) {
          fieldIds = await this.ensureCustomFields(connection);
        }
        // #10: GHL rejects (or silently drops) an entry with no field id, so a key that
        // could not be resolved is left out entirely; with nothing left to write the PUT
        // itself is skipped rather than sent empty.
        const fields = [
          { id: fieldIds["contact.routeflow_customer_id"], field_value: customer.id },
          { id: fieldIds["contact.routeflow_link"], field_value: this.webLink(customer.id) },
          { id: fieldIds["contact.routeflow_status"], field_value: "Customer" },
        ].filter((entry): entry is { id: string; field_value: string } => !!entry.id);
        if (fields.length > 0) {
          await this.client.updateContactCustomFields(handoff.contactId, fields);
        }
      }

      if (connection.writeBackTag) {
        await this.client.addTags(handoff.contactId, ["routeflow-customer"]);
      }

      if (connection.writeBackNote && !handoff.noteWritten) {
        const link = this.webLink(customer.id);
        const body =
          handoff.status === "LINKED"
            ? `Customer linked to existing customer: ${link}`
            : `Customer created in RouteFlow: ${link}`;
        await this.client.createNote(handoff.contactId, body);
        // #2 (M3/R19(4)): persist the flag IMMEDIATELY, in its own write — deferring it to
        // the end-of-sequence update meant a later failing step (markWon) rolled the row
        // back to WRITEBACK_PENDING with `noteWritten` still false, and every retry posted
        // the note again.
        await this.prisma.crmHandoff.update({
          where: { id: handoff.id },
          data: { noteWritten: true },
        });
      }

      if (connection.markWon) {
        await this.client.updateOpportunityStatus(handoff.opportunityId, "won");
      }

      // R20: the whole sequence succeeded — put the row back to the terminal status it held
      // before write-back opened it (CREATED/LINKED). `noteWritten` is already persisted.
      const successData: Record<string, unknown> = { processedAt: new Date() };
      if (handoff.status === "CREATED" || handoff.status === "LINKED") {
        successData.status = handoff.status;
      }
      await this.prisma.crmHandoff.update({ where: { id: handoff.id }, data: successData });
    } catch (e) {
      const newAttempts = (handoff.attempts ?? 0) + 1;
      if (newAttempts > BACKOFF_MINUTES.length) {
        await this.prisma.crmHandoff.update({
          where: { id: handoff.id },
          data: {
            status: "FAILED",
            reason: `write-back failed after ${newAttempts - 1} attempts: ${(e as Error).message}`,
          },
        });
        return;
      }
      await this.prisma.crmHandoff.update({
        where: { id: handoff.id },
        data: {
          status: "WRITEBACK_PENDING",
          attempts: newAttempts,
          nextAttemptAt: this.nextAttemptAt(newAttempts, new Date()),
        },
      });
    }
  }

  /** `now + [1,5,15,60,240][min(attempts,5)-1]` minutes — spec R20's exact backoff table. */
  nextAttemptAt(attempts: number, now: Date): Date {
    const idx = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
    return new Date(now.getTime() + BACKOFF_MINUTES[idx] * 60_000);
  }
}
