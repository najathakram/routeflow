import { BadRequestException, Injectable } from "@nestjs/common";
import { MigrationSource } from "@prisma/client";

/** A raw record fetched/parsed from a source, ready to stage. */
export interface StagedRow {
  entityType: string; // an ImportEntityType value
  externalId?: string;
  payload: Record<string, unknown>;
}

export interface SourceConnector {
  readonly source: MigrationSource;
  /** true only when a real live fetch is wired (OAuth). Stubs return false. */
  readonly supportsFetch: boolean;
  fetch(scope: string[]): Promise<StagedRow[]>;
}

/** CSV / paper: rows are provided by direct upload, not fetched. */
class DirectUploadConnector implements SourceConnector {
  readonly supportsFetch = false;
  constructor(readonly source: MigrationSource) {}
  fetch(): Promise<StagedRow[]> {
    throw new BadRequestException(
      `${this.source} records are provided by direct upload — stage parsed rows instead of fetching.`,
    );
  }
}

/**
 * OAuth source stub (spec §3). The connector INTERFACE + registry are wired now;
 * the real read-only Zoho Books / QuickBooks fetch is a deferred, creds-gated PR
 * (needs a registered OAuth app + tokens). Until then the connector cleanly tells
 * the user to upload a CSV export.
 */
class OAuthConnectorStub implements SourceConnector {
  readonly supportsFetch = false;
  constructor(
    readonly source: MigrationSource,
    private readonly displayName: string,
  ) {}
  fetch(): Promise<StagedRow[]> {
    throw new BadRequestException(
      `The ${this.displayName} connector is not yet connected. Export a CSV from ${this.displayName} and upload it — everything else (staging, dedup, 24h undo) works the same.`,
    );
  }
}

/** Resolves a MigrationSource to its connector. */
@Injectable()
export class SourceConnectorRegistry {
  private readonly connectors: Record<MigrationSource, SourceConnector> = {
    CSV: new DirectUploadConnector("CSV"),
    PAPER: new DirectUploadConnector("PAPER"),
    ZOHO: new OAuthConnectorStub("ZOHO", "Zoho Books"),
    QUICKBOOKS: new OAuthConnectorStub("QUICKBOOKS", "QuickBooks"),
  };

  get(source: MigrationSource): SourceConnector {
    return this.connectors[source];
  }
}
