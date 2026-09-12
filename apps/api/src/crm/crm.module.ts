// CRM (GoHighLevel) feature module (WP1-WP3; spec R1-R24). Wires the Nest-standard
// controller/connection-service pair (WP2) alongside the plain-dependency-bag poll/handoff/
// write-back services (WP3), and registers the single LeaderCron entry point
// ("*/3 * * * *", job name "crm-gohighlevel.poll").
import { Injectable, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { LeaderCron } from "../common/cron-lock";
import { EmailModule } from "../email/email.module";
import { EmailService } from "../email/email.service";
import { CustomersModule } from "../customers/customers.module";
import { CustomersService } from "../customers/customers.service";
import { ImportModule } from "../import/import.module";
import { ExternalRefService } from "../import/external-ref.service";
import { GatewaysModule } from "../gateways/gateways.module";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";

import { CrmController } from "./crm.controller";
import { CrmConnectionService } from "./crm-connection.service";
import { GHL_CLIENT_FACTORY, type GhlClientFactory } from "./crm.types";
import { GoHighLevelClient, type GoHighLevelClientCreds } from "./gohighlevel/gohighlevel.client";
import { GoHighLevelPollService } from "./gohighlevel/gohighlevel-poll.service";
import { GoHighLevelHandoffService } from "./gohighlevel/gohighlevel-handoff.service";
import { GoHighLevelWritebackService } from "./gohighlevel/gohighlevel-writeback.service";

/** Decrypts a connection's cipher (when present) into a per-tenant, correctly-scoped client. */
function buildGhlClientForConnection(
  connection: { secretCipher?: string | null; locationId: string },
  encryption: EncryptionService,
): GoHighLevelClient {
  const creds: GoHighLevelClientCreds = {
    token: connection.secretCipher ? encryption.decrypt(connection.secretCipher) : "",
    locationId: connection.locationId,
  };
  return new GoHighLevelClient(creds);
}

/**
 * `GoHighLevelHandoffService.ensureTags` calls `ghlClient.assignTag(contactId, names)` with an
 * ARRAY of tag names in one call (see that service's `ensureTags`) — `GoHighLevelClient`'s own
 * `assignTag(contactId, tagId: string)` takes exactly one id, so calling it directly here would
 * serialize the array into a nested `{tags:[[...]]}` body. This facade keeps the handoff
 * service's one-call-per-set contract while delegating the actual HTTP call to the client's
 * `addTags(contactId, tags: string[])` (bulk-by-name), which is spec R19/R18's real shape.
 * Every other method passes straight through, so the facade also satisfies
 * `GoHighLevelWritebackService`'s narrower `GoHighLevelClient` surface unchanged.
 */
function ghlClientFacade(client: GoHighLevelClient) {
  return {
    getLocation: client.getLocation.bind(client),
    listPipelines: client.listPipelines.bind(client),
    searchOpportunities: client.searchOpportunities.bind(client),
    getContact: client.getContact.bind(client),
    listCustomFields: client.listCustomFields.bind(client),
    createCustomField: client.createCustomField.bind(client),
    updateContactCustomFields: client.updateContactCustomFields.bind(client),
    listTags: client.listTags.bind(client),
    createTag: client.createTag.bind(client),
    assignTag: (contactId: string, names: string[]) => client.addTags(contactId, names),
    addTags: client.addTags.bind(client),
    createNote: client.createNote.bind(client),
    updateOpportunityStatus: client.updateOpportunityStatus.bind(client),
  };
}

/**
 * Thin `@LeaderCron` entry point. Deliberately kept OFF `GoHighLevelPollService.pollAll()`
 * itself: that method is exercised directly by `gohighlevel-poll.service.spec.ts` with no
 * mock of `../common/db-locks`, so decorating it there would make a plain unit test attempt a
 * real Postgres advisory-lock connection. This runner is the only source-tree call site the
 * `no-bare-cron.spec.ts` guard needs to see.
 */
@Injectable()
class GoHighLevelCronRunner {
  private readonly logger = new Logger(GoHighLevelCronRunner.name);

  constructor(private readonly pollService: GoHighLevelPollService) {}

  @LeaderCron("*/3 * * * *", "crm-gohighlevel.poll")
  async run(): Promise<void> {
    try {
      await this.pollService.pollAll();
    } catch (e) {
      // pollAll already isolates per-tenant failures; this is a last-resort net so a bug in
      // that isolation itself cannot crash the scheduler.
      this.logger.error(`crm-gohighlevel.poll tick failed: ${(e as Error).message}`);
    }
  }
}

/**
 * The injectable per-tenant client factory (F4). Every service that needs to talk to
 * GoHighLevel AS a tenant resolves its client here — `CrmConnectionService.listPipelines`
 * used to borrow the shared empty-creds instance below, which carries no locationId and so
 * 401s for every tenant, always.
 */
const GHL_CLIENT_FACTORY_PROVIDER = {
  provide: GHL_CLIENT_FACTORY,
  useFactory: (encryption: EncryptionService): GhlClientFactory => ({
    forConnection: (connection) => buildGhlClientForConnection(connection, encryption),
  }),
  inject: [EncryptionService],
};

const GO_HIGH_LEVEL_CLIENT_PROVIDER = {
  provide: GoHighLevelClient,
  // A single shared, empty-creds instance used only via `getLocation`'s per-call token/
  // locationId override (see gohighlevel.client.ts) — `CrmConnectionService`'s connect/test/
  // pipeline calls. The poll/handoff/write-back pipeline below builds its own per-tenant
  // client through `buildGhlClientForConnection` instead, since every other client method
  // carries no such override.
  useValue: new GoHighLevelClient({ token: "", locationId: "" }),
};

const GO_HIGH_LEVEL_HANDOFF_SERVICE_PROVIDER = {
  provide: GoHighLevelHandoffService,
  useFactory: (
    prisma: PrismaService,
    customersService: CustomersService,
    externalRefService: ExternalRefService,
    gateway: RouteFlowGateway,
    audit: AuditService,
    encryption: EncryptionService,
    config: ConfigService,
  ) =>
    new GoHighLevelHandoffService({
      prisma,
      customersService,
      externalRefService,
      gateway,
      audit,
      logger: new Logger(GoHighLevelHandoffService.name),
      // Never actually called directly (resolveGhlClient below always wins in production);
      // present only so the type stays a plain object rather than `undefined`.
      ghlClient: null,
      resolveGhlClient: (connection) =>
        ghlClientFacade(
          buildGhlClientForConnection(
            connection as { secretCipher?: string | null; locationId: string },
            encryption,
          ),
        ),
      writebackServiceFactory: (ghlClient) =>
        new GoHighLevelWritebackService(ghlClient as never as GoHighLevelClient, prisma as never, {
          get: (key: string) => config.get<string>(key),
        }),
    }),
  inject: [
    PrismaService,
    CustomersService,
    ExternalRefService,
    RouteFlowGateway,
    AuditService,
    EncryptionService,
    ConfigService,
  ],
};

const GO_HIGH_LEVEL_POLL_SERVICE_PROVIDER = {
  provide: GoHighLevelPollService,
  useFactory: (
    prisma: PrismaService,
    encryption: EncryptionService,
    handoffService: GoHighLevelHandoffService,
    emailService: EmailService,
    tenantCtx: TenantContextService,
  ) =>
    new GoHighLevelPollService(
      prisma,
      (connection: { secretCipher?: string | null; locationId: string }) =>
        buildGhlClientForConnection(connection, encryption),
      handoffService,
      emailService,
      tenantCtx,
    ),
  inject: [
    PrismaService,
    EncryptionService,
    GoHighLevelHandoffService,
    EmailService,
    TenantContextService,
  ],
};

@Module({
  imports: [EmailModule, CustomersModule, ImportModule, GatewaysModule],
  controllers: [CrmController],
  providers: [
    CrmConnectionService,
    GHL_CLIENT_FACTORY_PROVIDER,
    GO_HIGH_LEVEL_CLIENT_PROVIDER,
    GO_HIGH_LEVEL_HANDOFF_SERVICE_PROVIDER,
    GO_HIGH_LEVEL_POLL_SERVICE_PROVIDER,
    GoHighLevelCronRunner,
  ],
  exports: [GoHighLevelPollService, GoHighLevelHandoffService, GHL_CLIENT_FACTORY],
})
export class CrmModule {}
