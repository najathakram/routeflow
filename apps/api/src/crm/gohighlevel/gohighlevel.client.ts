/**
 * GoHighLevel HTTP client (TP2, T6-T12; spec R2, R9, R13, R19). Every call carries the fixed
 * `Version` header GHL requires, times out after 10s, and maps 401/429 to typed errors so
 * callers (CrmConnectionService, the poll/handoff/write-back services) never touch raw
 * status codes. No zod — the two response shapes callers must trust are validated by the
 * hand-written type guards below.
 */

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const TIMEOUT_MS = 10_000;

export class CrmAuthError extends Error {
  constructor(message = "GoHighLevel rejected the token") {
    super(message);
    this.name = "CrmAuthError";
  }
}

export class CrmRateLimitError extends Error {
  readonly retryAfterSec: number | null;
  constructor(retryAfterSec: number | null, message = "GoHighLevel rate limit") {
    super(message);
    this.name = "CrmRateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

export class CrmHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CrmHttpError";
    this.status = status;
    this.code = code;
  }
}

export interface GoHighLevelClientCreds {
  token: string;
  locationId: string;
}

export interface SearchOpportunitiesParams {
  page?: number;
  pipelineId?: string;
  stageId?: string;
  status?: string;
}

export interface GhlOpportunity {
  id: string;
  name?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  contactId: string;
  status?: string;
  monetaryValue?: number;
  source?: string;
  lastStageChangeAt?: string;
  lastStatusChangeAt?: string;
  updatedAt?: string;
  attributionSource?: { utmSource?: string; campaign?: string };
  [key: string]: unknown;
}

export interface GhlOpportunitySearchResponse {
  opportunities: GhlOpportunity[];
  meta?: { nextPage?: number };
}

export interface GhlContact {
  id: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  companyName?: string | null;
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  [key: string]: unknown;
}

export interface GhlCustomField {
  id: string;
  name?: string;
  fieldKey?: string;
}

export interface GhlTag {
  id: string;
  name: string;
}

export interface GhlPipelineStage {
  id: string;
  name: string;
  position?: number;
}

export interface GhlPipeline {
  id: string;
  name: string;
  stages: GhlPipelineStage[];
}

/** Hand-written type guard: a `searchOpportunities` response actually has an `opportunities` array. */
export function isOpportunityPage(json: unknown): json is GhlOpportunitySearchResponse {
  return (
    !!json &&
    typeof json === "object" &&
    Array.isArray((json as { opportunities?: unknown }).opportunities)
  );
}

/** Hand-written type guard: a `getContact` response actually carries a `contact` object. */
export function isContact(json: unknown): json is { contact: GhlContact } {
  return (
    !!json &&
    typeof json === "object" &&
    typeof (json as { contact?: unknown }).contact === "object" &&
    (json as { contact?: unknown }).contact !== null
  );
}

export class GoHighLevelClient {
  private readonly token: string;
  private readonly locationId: string;

  constructor(creds: GoHighLevelClientCreds) {
    this.token = creds.token;
    this.locationId = creds.locationId;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    tokenOverride?: string,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${tokenOverride ?? this.token}`,
          Version: VERSION,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new CrmHttpError(
        0,
        (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError"
          ? "timeout"
          : "network",
        String((e as Error).message),
      );
    }
    if (res.status === 401) throw new CrmAuthError("GoHighLevel rejected the token");
    if (res.status === 429) {
      const ra = Number(res.headers.get("Retry-After"));
      throw new CrmRateLimitError(Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    if (!res.ok) throw new CrmHttpError(res.status, "http", `GoHighLevel ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * `override` lets a caller holding a single shared client instance (e.g.
   * `CrmConnectionService`, which is not constructed per-tenant) supply a different
   * tenant's decrypted token/locationId for one call; omitted, it uses this instance's
   * own constructor-time creds (the T6 contract).
   */
  async getLocation(override?: {
    token?: string;
    locationId?: string;
  }): Promise<{ location?: { id: string; name?: string; country?: string } }> {
    return this.request(
      "GET",
      `/locations/${override?.locationId ?? this.locationId}`,
      undefined,
      override?.token,
    );
  }

  async listPipelines(): Promise<GhlPipeline[]> {
    const qs = new URLSearchParams({ locationId: this.locationId });
    const json = await this.request<{ pipelines?: GhlPipeline[] }>(
      "GET",
      `/opportunities/pipelines?${qs.toString()}`,
    );
    return json.pipelines ?? [];
  }

  /** Query param names/values are the exact spec R9 contract — never rename these. */
  async searchOpportunities(
    params: SearchOpportunitiesParams = {},
  ): Promise<GhlOpportunitySearchResponse> {
    const qs = new URLSearchParams();
    qs.set("location_id", this.locationId);
    qs.set("limit", "100");
    qs.set("page", String(params.page ?? 1));
    if (params.pipelineId) qs.set("pipeline_id", params.pipelineId);
    if (params.stageId) qs.set("pipeline_stage_id", params.stageId);
    if (!params.pipelineId && !params.stageId && params.status) qs.set("status", params.status);
    const json = await this.request<unknown>("GET", `/opportunities/search?${qs.toString()}`);
    return isOpportunityPage(json) ? json : { opportunities: [], meta: {} };
  }

  async getContact(contactId: string): Promise<GhlContact> {
    const json = await this.request<unknown>("GET", `/contacts/${contactId}`);
    if (!isContact(json)) {
      throw new CrmHttpError(
        200,
        "invalid-shape",
        "GoHighLevel returned an unexpected contact shape",
      );
    }
    return json.contact;
  }

  /** PUT body is exactly `{customFields}` — never `tags`/`firstName`/etc (spec R19). */
  async updateContactCustomFields(
    contactId: string,
    customFields: Array<{ id: string; field_value: string }>,
  ): Promise<void> {
    await this.request("PUT", `/contacts/${contactId}`, { customFields });
  }

  async createCustomField(name: string): Promise<GhlCustomField> {
    const json = await this.request<{ customField: GhlCustomField }>(
      "POST",
      `/locations/${this.locationId}/customFields`,
      { name, dataType: "TEXT", model: "contact" },
    );
    return json.customField;
  }

  async listCustomFields(): Promise<GhlCustomField[]> {
    const json = await this.request<{ customFields?: GhlCustomField[] }>(
      "GET",
      `/locations/${this.locationId}/customFields?model=contact`,
    );
    return json.customFields ?? [];
  }

  async listTags(): Promise<GhlTag[]> {
    const json = await this.request<{ tags?: GhlTag[] }>(
      "GET",
      `/locations/${this.locationId}/tags`,
    );
    return json.tags ?? [];
  }

  async createTag(name: string): Promise<GhlTag> {
    const json = await this.request<{ tag: GhlTag }>("POST", `/locations/${this.locationId}/tags`, {
      name,
    });
    return json.tag;
  }

  /** Idempotent tag assignment by tag id (used by the R18 lookup-or-create path). */
  async assignTag(contactId: string, tagId: string): Promise<void> {
    await this.request("POST", `/contacts/${contactId}/tags`, { tags: [tagId] });
  }

  /** Bulk tag-by-name on a contact (used by the R19 write-back's `routeflow-customer` tag). */
  async addTags(contactId: string, tags: string[]): Promise<void> {
    await this.request("POST", `/contacts/${contactId}/tags`, { tags });
  }

  async createNote(contactId: string, body: string): Promise<void> {
    await this.request("POST", `/contacts/${contactId}/notes`, { body });
  }

  async updateOpportunityStatus(opportunityId: string, status: string): Promise<void> {
    await this.request("PUT", `/opportunities/${opportunityId}/status`, { status });
  }
}
