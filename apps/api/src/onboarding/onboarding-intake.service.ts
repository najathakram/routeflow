import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type IntakeSectionKey } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type {
  IntakeFileKind,
  IntakeFileView,
  IntakeOrderSnapshot,
  IntakeSectionView,
  IntakeSessionView,
  IssueIntakeLinkResponse,
  OnboardingIntakeAdminView,
  OrderAcceptanceView,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EmailService } from "../email/email.service";
import { StorageService } from "../storage/storage.service";
import { ProrationService } from "../billing/proration.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { escapeHtml, safeLinkHref } from "../common/html-escape";
import { hashSignedToken, mintSignedToken, verifySignedToken } from "../common/signed-token";
import {
  ADMIN_AUDIT_ENTITY,
  AdminAuditAction,
  type AdminAuditActionCode,
} from "../platform-admin/audit-actions.constant";
import { INTAKE_SCHEMA_VERSION, validateSectionAnswers } from "./dto/intake-sections.dto";
import { onboardingTokenSecret } from "./onboarding-token-secret";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** Every token failure — forged, unknown, expired, revoked, closed case — looks exactly alike (L-178). */
export const LINK_NOT_FOUND = "Link not found or expired.";
export const INTAKE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * The Terms/Privacy versions a customer accepts: the "Last updated" date of the published pages
 * (apps/web/app/(marketing)/terms|privacy/page.tsx `LAST_UPDATED`). A spec pins these to the pages,
 * so a Terms update that forgets to bump them fails the build.
 */
export const TERMS_VERSION = "2026-09-17";
export const PRIVACY_VERSION = "2026-09-17";

const SECTION_KEYS: IntakeSectionKey[] = [
  "ACCOUNT",
  "TAX_COMPLIANCE",
  "INVOICING",
  "TEAM",
  "OPERATIONS",
  "DATA_FILES",
  "GO_LIVE_PREFS",
];
const EDITABLE = new Set(["EMPTY", "DRAFT", "CHANGES_REQUESTED"]);
const FILE_KINDS = new Set<IntakeFileKind>([
  "products",
  "customers",
  "suppliers",
  "stock",
  "ar_aging",
  "open_docs",
  "tax_cert",
  "licence",
  "logo",
  "other",
]);
/** Kinds that carry retailers' or the business's personal/financial data. `other` is assumed to. */
const PII_KINDS = new Set<IntakeFileKind>([
  "customers",
  "ar_aging",
  "open_docs",
  "tax_cert",
  "licence",
  "other",
]);
/** Extension → the content types accepted for it (fail closed: both must match). */
export const INTAKE_UPLOAD_TYPES: Record<string, string[]> = {
  ".csv": ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
};
export const INTAKE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

type TokenCase = Prisma.IntakeAccessTokenGetPayload<{ include: { case: true } }>;
type UploadedFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };

/**
 * The secure intake link (#2159 S2, plan §4). The wholesaler reaches it through a one-time URL
 * (`<WEB_URL>/onboarding#token=…` — the token lives in the fragment, never a request URL) and
 * everything they do goes through POST bodies. Platform-level: base Prisma client only.
 *
 * Token lifecycle: 30 days; ONE active token per case (issuing revokes the prior); revoked when
 * the case goes LOST or LIVE; `lastUsedAt` bumped on use. A forged token is refused by its HMAC
 * before any database read.
 */
@Injectable()
export class OnboardingIntakeService {
  private readonly logger = new Logger(OnboardingIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly storage: StorageService,
    private readonly proration: ProrationService,
    private readonly catalog: PlanCatalogService,
  ) {}

  /** Null when unset or shorter than ONBOARDING_TOKEN_SECRET_MIN_LENGTH (SA-456: same bar as boot). */
  private secret(): string | null {
    return onboardingTokenSecret();
  }

  // ─── Back office: the link ──────────────────────────────────────────────────────

  async issueLink(
    caseId: string,
    adminId: string,
    send: boolean,
  ): Promise<IssueIntakeLinkResponse> {
    const secret = this.secret();
    if (!secret) throw new ConflictException("Intake links are not configured on this server");
    const c = await this.prisma.onboardingCase.findUnique({ where: { id: caseId } });
    if (!c) throw new NotFoundException("Onboarding case not found");
    if (c.status !== "OPEN") {
      throw new ConflictException({
        statusCode: 409,
        code: API_ERROR_CODES.ONBOARDING_CASE_NOT_OPEN,
        message: `This case is ${c.status}; reopen it before issuing a link`,
      });
    }
    const token = mintSignedToken(secret);
    const expiresAt = new Date(Date.now() + INTAKE_TOKEN_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "OnboardingCase" WHERE id = ${caseId} FOR UPDATE`;
      await this.ensureSections(tx, caseId);
      await tx.intakeAccessToken.updateMany({
        where: { caseId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.intakeAccessToken.create({
        data: { caseId, tokenHash: hashSignedToken(token), expiresAt, createdById: adminId },
      });
      await this.event(tx, caseId, "link.issued", "ADMIN", adminId, {
        expiresAt: expiresAt.toISOString(),
        emailed: send,
      });
    });
    await this.adminAudit(c.tenantId, adminId, AdminAuditAction.ONBOARDING_LINK_ISSUED, { caseId });
    const url = `${webUrl()}/onboarding#token=${token}`;
    let emailed = false;
    if (send) {
      const r = await this.email.sendPlatform({
        to: c.contactEmail,
        subject: "Your RouteFlow order and setup questionnaire",
        html: linkEmailHtml(c.contactName, c.companyName, url, expiresAt),
      });
      emailed = r.delivered;
      if (!r.delivered) this.logger.warn(`intake link email not delivered for case ${caseId}`);
    }
    return { url, expiresAt: expiresAt.toISOString(), emailed };
  }

  async revokeLink(caseId: string, adminId: string): Promise<OnboardingIntakeAdminView> {
    const c = await this.prisma.onboardingCase.findUnique({ where: { id: caseId } });
    if (!c) throw new NotFoundException("Onboarding case not found");
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.intakeAccessToken.updateMany({
        where: { caseId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (r.count > 0) await this.event(tx, caseId, "link.revoked", "ADMIN", adminId);
    });
    await this.adminAudit(c.tenantId, adminId, AdminAuditAction.ONBOARDING_LINK_REVOKED, {
      caseId,
    });
    return this.adminView(caseId);
  }

  // ─── Public: token resolution ───────────────────────────────────────────────────

  /**
   * THE gate for every public route. Order matters: shape → HMAC (no DB) → hash lookup →
   * revoked / expired / case closed. Every refusal is the same 404 body.
   */
  async resolve(token: unknown): Promise<TokenCase> {
    if (typeof token !== "string" || token.length < 16 || token.length > 300) throw notFound();
    const secret = this.secret();
    if (!secret || !verifySignedToken(token, secret)) throw notFound();
    const row = await this.prisma.intakeAccessToken.findUnique({
      where: { tokenHash: hashSignedToken(token) },
      include: { case: true },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) throw notFound();
    if (row.case.status === "LOST" || row.case.status === "LIVE") throw notFound();
    await this.prisma.intakeAccessToken.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    });
    return row;
  }

  async session(token: unknown): Promise<IntakeSessionView> {
    const t = await this.resolve(token);
    return this.sessionView(t);
  }

  async saveSection(
    token: unknown,
    key: IntakeSectionKey,
    answers: unknown,
  ): Promise<IntakeSessionView> {
    const t = await this.resolve(token);
    const clean = await validateSectionAnswers(key, answers, { partial: true });
    await this.prisma.$transaction(async (tx) => {
      const s = await this.lockSection(tx, t.caseId, key);
      this.assertEditable(s.status);
      await tx.intakeSection.update({
        where: { id: s.id },
        data: {
          answers: clean as Prisma.InputJsonValue,
          status: "DRAFT",
          schemaVersion: INTAKE_SCHEMA_VERSION,
        },
      });
    });
    return this.sessionView(t);
  }

  async submitSection(token: unknown, key: IntakeSectionKey): Promise<IntakeSessionView> {
    const t = await this.resolve(token);
    await this.prisma.$transaction(async (tx) => {
      const s = await this.lockSection(tx, t.caseId, key);
      this.assertEditable(s.status);
      // Full validation of what is stored — a submit is only as good as the saved answers.
      const clean = await validateSectionAnswers(key, s.answers, { partial: false });
      await tx.intakeSection.update({
        where: { id: s.id },
        data: {
          answers: clean as Prisma.InputJsonValue,
          status: "SUBMITTED",
          submittedAt: new Date(),
          schemaVersion: INTAKE_SCHEMA_VERSION,
        },
      });
      await this.event(tx, t.caseId, "section.submitted", "CUSTOMER", null, { key });
    });
    return this.sessionView(t);
  }

  /**
   * Click-accept. The snapshot is computed HERE from the case's deal terms and the live catalog —
   * never taken from the request — and frozen in an append-only row; a prior acceptance is
   * superseded in the same transaction. IP and user agent come from the request.
   */
  async accept(
    token: unknown,
    input: {
      acceptedName: string;
      acceptedEmail: string;
      ip: string | null;
      userAgent: string | null;
    },
  ): Promise<IntakeSessionView> {
    const t = await this.resolve(token);
    const snapshot = await this.computeSnapshot(t.case);
    if (!snapshot) {
      throw new ConflictException({
        statusCode: 409,
        code: API_ERROR_CODES.INTAKE_ORDER_NOT_READY,
        message: "Your order isn't ready to accept yet — we'll let you know when it is",
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "OnboardingCase" WHERE id = ${t.caseId} FOR UPDATE`;
      // #2431 fold (d): a double submit of the SAME order, versions and signer is not a new
      // acceptance — keep the current row (checked under the case lock, so two concurrent
      // submits serialise and the second sees the first).
      const current = await tx.orderAcceptance.findFirst({
        where: { caseId: t.caseId, supersededAt: null },
      });
      if (
        current &&
        current.termsVersion === TERMS_VERSION &&
        current.privacyVersion === PRIVACY_VERSION &&
        current.acceptedName === input.acceptedName.trim() &&
        current.acceptedEmail === input.acceptedEmail.trim() &&
        sameOrder(current.orderSnapshot, snapshot)
      ) {
        return;
      }
      const now = new Date();
      await tx.orderAcceptance.updateMany({
        where: { caseId: t.caseId, supersededAt: null },
        data: { supersededAt: now },
      });
      const a = await tx.orderAcceptance.create({
        data: {
          caseId: t.caseId,
          tenantId: t.case.tenantId,
          orderSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          termsVersion: TERMS_VERSION,
          privacyVersion: PRIVACY_VERSION,
          acceptedName: input.acceptedName.trim(),
          acceptedEmail: input.acceptedEmail.trim(),
          acceptedAt: now,
          ip: input.ip?.slice(0, 64) ?? null,
          userAgent: input.userAgent?.slice(0, 400) ?? null,
          tokenId: t.id,
        },
      });
      await this.event(tx, t.caseId, "order.accepted", "CUSTOMER", null, {
        acceptanceId: a.id,
        dueToday: snapshot.dueToday,
        termsVersion: TERMS_VERSION,
      });
    });
    return this.sessionView(t);
  }

  // ─── Files ────────────────────────────────────────────────────────────────────

  async uploadAsCustomer(
    token: unknown,
    sectionKey: IntakeSectionKey,
    kind: string,
    file: UploadedFile | undefined,
  ): Promise<IntakeSessionView> {
    const t = await this.resolve(token);
    // #2431 fold (a): a file belongs to its section — once the section is sent in, approved,
    // applied or waived, the customer can no longer add to it.
    await this.assertSectionEditable(t.caseId, sectionKey);
    await this.storeFile(t.caseId, sectionKey, kind, file, "customer");
    return this.sessionView(t);
  }

  async uploadAsAdmin(
    caseId: string,
    sectionKey: IntakeSectionKey,
    kind: string,
    file: UploadedFile | undefined,
    adminId: string,
  ): Promise<OnboardingIntakeAdminView> {
    const c = await this.prisma.onboardingCase.findUnique({
      where: { id: caseId },
      select: { id: true },
    });
    if (!c) throw new NotFoundException("Onboarding case not found");
    await this.storeFile(caseId, sectionKey, kind, file, adminId);
    return this.adminView(caseId);
  }

  /** A customer may delete only a file they uploaded themselves. */
  async deleteAsCustomer(token: unknown, fileId: unknown): Promise<IntakeSessionView> {
    const t = await this.resolve(token);
    if (typeof fileId !== "string") throw new NotFoundException("File not found");
    const f = await this.prisma.intakeFile.findFirst({
      where: { id: fileId, caseId: t.caseId, uploadedBy: "customer", deletedAt: null },
    });
    if (!f) throw new NotFoundException("File not found");
    // #2431 fold (a): nor delete from it — an approved file's object must never be removed
    // by the customer. Checked before any write, so a refusal leaves row and object intact.
    await this.assertSectionEditable(t.caseId, f.sectionKey);
    await this.prisma.intakeFile.update({ where: { id: f.id }, data: { deletedAt: new Date() } });
    await this.storage
      .delete(f.storageKey)
      .catch((err: Error) =>
        this.logger.warn(`intake file delete (storage) failed for ${f.id}: ${err.message}`),
      );
    await this.prisma.onboardingEvent.create({
      data: {
        caseId: t.caseId,
        type: "file.deleted",
        actorType: "CUSTOMER",
        payload: { fileId: f.id },
      },
    });
    return this.sessionView(t);
  }

  async signedFileUrl(caseId: string, fileId: string): Promise<{ url: string }> {
    const f = await this.prisma.intakeFile.findFirst({
      where: { id: fileId, caseId, deletedAt: null, purgedAt: null },
    });
    if (!f) throw new NotFoundException("File not found");
    return { url: await this.storage.presignedUrl(f.storageKey) };
  }

  private async storeFile(
    caseId: string,
    sectionKey: IntakeSectionKey,
    kindRaw: string,
    file: UploadedFile | undefined,
    uploadedBy: string,
  ): Promise<void> {
    if (!file || !file.buffer) throw new BadRequestException("A file is required");
    if (!SECTION_KEYS.includes(sectionKey)) throw new BadRequestException("Unknown section");
    const kind = kindRaw as IntakeFileKind;
    if (!FILE_KINDS.has(kind)) throw new BadRequestException("Unknown file kind");
    assertAllowedUpload(file);
    const safeName = safeFileName(file.originalname);
    const storageKey = `onboarding/${caseId}/${randomUUID()}-${safeName}`;
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    await this.storage.upload(storageKey, file.buffer, file.mimetype);
    await this.prisma.intakeFile.create({
      data: {
        caseId,
        sectionKey,
        kind,
        storageKey,
        originalName: file.originalname.slice(0, 255),
        contentType: file.mimetype,
        sizeBytes: file.size,
        sha256,
        containsPii: PII_KINDS.has(kind),
        uploadedBy,
      },
    });
    await this.prisma.onboardingEvent.create({
      data: {
        caseId,
        type: "file.uploaded",
        actorType: uploadedBy === "customer" ? "CUSTOMER" : "ADMIN",
        actorId: uploadedBy === "customer" ? null : uploadedBy,
        payload: { kind, sectionKey, sizeBytes: file.size },
      },
    });
  }

  // ─── Back office: review ───────────────────────────────────────────────────────

  async review(
    caseId: string,
    key: IntakeSectionKey,
    action: "approve" | "request_changes" | "waive",
    noteRaw: string | undefined,
    adminId: string,
  ): Promise<OnboardingIntakeAdminView> {
    const note = noteRaw?.trim() || null;
    if ((action === "request_changes" || action === "waive") && !note) {
      throw new BadRequestException("A note is required to send a section back or waive it");
    }
    const c = await this.prisma.onboardingCase.findUnique({ where: { id: caseId } });
    if (!c) throw new NotFoundException("Onboarding case not found");
    await this.prisma.$transaction(async (tx) => {
      await this.ensureSections(tx, caseId);
      const s = await this.lockSection(tx, caseId, key);
      const allowed =
        action === "waive"
          ? s.status !== "APPLIED" && s.status !== "WAIVED"
          : s.status === "SUBMITTED";
      if (!allowed) {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.INTAKE_SECTION_NOT_REVIEWABLE,
          message: `This section is ${s.status}`,
        });
      }
      const status =
        action === "approve" ? "APPROVED" : action === "waive" ? "WAIVED" : "CHANGES_REQUESTED";
      await tx.intakeSection.update({
        where: { id: s.id },
        data: { status, reviewedById: adminId, reviewedAt: new Date(), reviewNote: note },
      });
      await this.event(
        tx,
        caseId,
        `section.${action === "request_changes" ? "sent_back" : action === "approve" ? "approved" : "waived"}`,
        "ADMIN",
        adminId,
        { key, note },
      );
    });
    if (action === "request_changes") {
      const r = await this.email.sendPlatform({
        to: c.contactEmail,
        subject: `A few questions about your ${SECTION_LABEL[key]} answers`,
        html: sentBackEmailHtml(c.contactName, SECTION_LABEL[key], note!),
      });
      if (!r.delivered)
        this.logger.warn(`section sent-back email not delivered for case ${caseId}`);
    }
    return this.adminView(caseId);
  }

  async adminView(caseId: string): Promise<OnboardingIntakeAdminView> {
    const c = await this.prisma.onboardingCase.findUnique({
      where: { id: caseId },
      include: {
        sections: true,
        files: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
        acceptances: { orderBy: { acceptedAt: "desc" } },
        tokens: { where: { revokedAt: null }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!c) throw new NotFoundException("Onboarding case not found");
    const live = c.tokens[0] && c.tokens[0].expiresAt.getTime() > Date.now() ? c.tokens[0] : null;
    return {
      link: {
        active: !!live,
        expiresAt: live?.expiresAt.toISOString() ?? null,
        lastUsedAt: live?.lastUsedAt?.toISOString() ?? null,
      },
      sections: sortSections(c.sections).map((s) => ({
        ...sectionView(s),
        reviewedById: s.reviewedById,
        reviewedAt: s.reviewedAt?.toISOString() ?? null,
      })),
      files: c.files.map((f) => ({ ...fileView(f), containsPii: f.containsPii, sha256: f.sha256 })),
      acceptances: c.acceptances.map(acceptanceView),
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  /**
   * The order as it stands: deal terms priced against the LIVE published catalog. Null when the
   * deal can't be priced yet (no plan chosen, or an unknown plan/add-on) — never an error to the
   * customer, whose page then shows "your order is being prepared".
   */
  async computeSnapshot(c: { dealTerms: Prisma.JsonValue }): Promise<IntakeOrderSnapshot | null> {
    const d = (c.dealTerms ?? {}) as {
      planKey?: string;
      addonSkus?: string[];
      interval?: string;
      setupFeeCents?: number;
    };
    if (!d.planKey) return null;
    try {
      const q = await this.proration.quote({
        planKey: d.planKey,
        cycle: d.interval === "year" ? "ANNUAL" : "MONTHLY",
        addons: (d.addonSkus ?? []).map((sku) => ({ sku })),
      });
      const version = await this.catalog.getPublishedVersion();
      const setupFeeCents =
        Number.isInteger(d.setupFeeCents) && d.setupFeeCents! > 0 ? d.setupFeeCents! : 0;
      const setupFee = roundMoney(setupFeeCents / 100);
      return {
        planKey: q.planKey,
        planName: q.planName,
        cycle: q.cycle,
        isCustom: q.isCustom,
        lines: q.lines.map((l) => ({ ...l })),
        recurringDue: q.dueToday,
        setupFee,
        setupFeeCents,
        dueToday: roundMoney(q.dueToday + setupFee),
        catalogVersion: version?.version ?? null,
        currency: "USD",
        computedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.logger.warn(`intake order could not be priced: ${(err as Error).message}`);
      return null;
    }
  }

  private async sessionView(t: TokenCase): Promise<IntakeSessionView> {
    const c = await this.prisma.onboardingCase.findUniqueOrThrow({
      where: { id: t.caseId },
      include: {
        sections: true,
        files: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
        acceptances: { where: { supersededAt: null }, orderBy: { acceptedAt: "desc" }, take: 1 },
      },
    });
    const order = await this.computeSnapshot(c);
    return {
      companyName: c.companyName,
      contactName: c.contactName,
      expiresAt: t.expiresAt.toISOString(),
      sections: sortSections(c.sections).map(sectionView),
      files: c.files.map(fileView),
      order,
      orderUnavailable: order === null,
      terms: { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
      acceptance: c.acceptances[0] ? acceptanceView(c.acceptances[0]) : null,
    };
  }

  private async ensureSections(tx: Prisma.TransactionClient, caseId: string): Promise<void> {
    await tx.intakeSection.createMany({
      data: SECTION_KEYS.map((key) => ({ caseId, key, schemaVersion: INTAKE_SCHEMA_VERSION })),
      skipDuplicates: true,
    });
  }

  private async lockSection(tx: Prisma.TransactionClient, caseId: string, key: IntakeSectionKey) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "IntakeSection" WHERE "caseId" = ${caseId} AND key = ${key}::"IntakeSectionKey" FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException("Section not found");
    return tx.intakeSection.findUniqueOrThrow({ where: { id: rows[0].id } });
  }

  /** A section with no row yet has never been touched, so it is EMPTY (editable). */
  private async assertSectionEditable(caseId: string, key: IntakeSectionKey): Promise<void> {
    const s = await this.prisma.intakeSection.findUnique({
      where: { caseId_key: { caseId, key } },
      select: { status: true },
    });
    this.assertEditable(s?.status ?? "EMPTY");
  }

  private assertEditable(status: string): void {
    if (!EDITABLE.has(status)) {
      throw new ConflictException({
        statusCode: 409,
        code: API_ERROR_CODES.INTAKE_SECTION_LOCKED,
        message:
          "This section has been sent to us and can't be changed now — contact us if something is wrong",
      });
    }
  }

  private async event(
    tx: Prisma.TransactionClient,
    caseId: string,
    type: string,
    actorType: "ADMIN" | "CUSTOMER" | "SYSTEM",
    actorId: string | null,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await tx.onboardingEvent.create({
      data: {
        caseId,
        type,
        actorType,
        actorId,
        payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  private async adminAudit(
    tenantId: string | null,
    adminId: string,
    action: AdminAuditActionCode,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.log({
      tenantId,
      userId: adminId,
      action,
      entityType: ADMIN_AUDIT_ENTITY,
      entityId: tenantId,
      meta: { platformAdmin: true, ...meta },
    });
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────────

/** The same order, ignoring when it was computed (`computedAt` differs on every quote). */
export function sameOrder(a: unknown, b: unknown): boolean {
  const strip = (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const { computedAt: _at, ...rest } = v as Record<string, unknown>;
    return rest;
  };
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

/** Key-order-independent JSON (jsonb does not keep key order), for equality checks only. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const SECTION_LABEL: Record<IntakeSectionKey, string> = {
  ACCOUNT: "Account",
  TAX_COMPLIANCE: "Tax & compliance",
  INVOICING: "Invoicing",
  TEAM: "Team",
  OPERATIONS: "Operations",
  DATA_FILES: "Data files",
  GO_LIVE_PREFS: "Go-live preferences",
};

function notFound(): NotFoundException {
  return new NotFoundException(LINK_NOT_FOUND);
}

export function assertAllowedUpload(file: {
  originalname: string;
  mimetype: string;
  size: number;
}): void {
  if (file.size > INTAKE_UPLOAD_MAX_BYTES)
    throw new BadRequestException("Files must be 25 MB or smaller");
  const dot = file.originalname.lastIndexOf(".");
  const ext = dot >= 0 ? file.originalname.slice(dot).toLowerCase() : "";
  const types = INTAKE_UPLOAD_TYPES[ext];
  if (!types || !types.includes((file.mimetype ?? "").toLowerCase())) {
    throw new BadRequestException("Only CSV, XLSX, PDF, PNG or JPG files can be uploaded");
  }
}

export function safeFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "file").normalize("NFKD");
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-120);
  return cleaned || "file";
}

function sortSections<T extends { key: IntakeSectionKey }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => SECTION_KEYS.indexOf(a.key) - SECTION_KEYS.indexOf(b.key));
}

function sectionView(s: Prisma.IntakeSectionGetPayload<Record<string, never>>): IntakeSectionView {
  return {
    key: s.key,
    status: s.status,
    schemaVersion: s.schemaVersion,
    answers: (s.answers as Record<string, unknown>) ?? {},
    reviewNote: s.reviewNote,
    submittedAt: s.submittedAt?.toISOString() ?? null,
    editable: EDITABLE.has(s.status),
  };
}

function fileView(f: Prisma.IntakeFileGetPayload<Record<string, never>>): IntakeFileView {
  return {
    id: f.id,
    sectionKey: f.sectionKey,
    kind: f.kind as IntakeFileKind,
    originalName: f.originalName,
    contentType: f.contentType,
    sizeBytes: f.sizeBytes,
    uploadedBy: f.uploadedBy === "customer" ? "customer" : "admin",
    createdAt: f.createdAt.toISOString(),
  };
}

function acceptanceView(
  a: Prisma.OrderAcceptanceGetPayload<Record<string, never>>,
): OrderAcceptanceView {
  return {
    id: a.id,
    orderSnapshot: a.orderSnapshot as unknown as IntakeOrderSnapshot,
    termsVersion: a.termsVersion,
    privacyVersion: a.privacyVersion,
    acceptedName: a.acceptedName,
    acceptedEmail: a.acceptedEmail,
    acceptedAt: a.acceptedAt.toISOString(),
    supersededAt: a.supersededAt?.toISOString() ?? null,
  };
}

function webUrl(): string {
  return (process.env.WEB_URL || "https://www.routeflow.info").replace(/\/+$/, "");
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function linkEmailHtml(
  contactName: string,
  companyName: string,
  url: string,
  expiresAt: Date,
): string {
  const expires = escapeHtml(expiresAt.toISOString().slice(0, 10));
  // SA-127: a link is only ever an absolute http(s) URL; otherwise the button renders as text.
  const href = safeLinkHref(url, "onboardingIntakeLinkEmail");
  const button = href
    ? `<a href="${escapeHtml(href)}">Open your setup page</a>`
    : "Open your setup page from the link we send you separately";
  return `<p>Hi ${escapeHtml(firstName(contactName))},</p>
<p>Here's your secure link to review your RouteFlow order for ${escapeHtml(companyName)} and fill in the setup questionnaire:</p>
<p>${button}</p>
<p>The link works until ${expires}. Please don't forward it, and never put passwords or bank details into the form — we'll ask for those separately.</p>
<p>— The RouteFlow team</p>`;
}

function sentBackEmailHtml(contactName: string, sectionLabel: string, note: string): string {
  return `<p>Hi ${escapeHtml(firstName(contactName))}, thanks for sending ${escapeHtml(sectionLabel)}. Before we load it, could you confirm:</p>
<blockquote>${escapeHtml(note).replace(/\n/g, "<br>")}</blockquote>
<p>You can update your answers on the same setup page we sent you.</p>
<p>— The RouteFlow team</p>`;
}
