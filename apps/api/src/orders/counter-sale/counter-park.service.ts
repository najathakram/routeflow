import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  BadRequestException,
} from "@nestjs/common";
import {
  COUNTER_DEFAULT_REGISTER,
  COUNTER_PARK_MAX_BYTES,
  COUNTER_PARK_MAX_LINES,
  COUNTER_PARK_MAX_PER_REGISTER,
  COUNTER_PARK_MAX_PER_TENANT,
  COUNTER_PARK_PAGE_SIZE,
  REGISTER_KEY_PATTERN,
  hasReservedParkKey,
  COUNTER_PARK_RETRY_WINDOW_MS,
  COUNTER_PARK_TTL_HOURS,
  sanitizeParkedPayload,
  type ParkCartResponse,
  type ParkLimitScope,
  type ParkedCartListItem,
  type ParkedCartListResponse,
  type ResumeParkedCartResponse,
} from "@routeflow/pricing";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { tenantTimeZone } from "../../common/tenant-time-zone";
import { retryOnTxConflict } from "../../common/tx-retry";
import { PrismaService } from "../../prisma/prisma.service";
import { COUNTER_SALE_METHODS } from "./counter-sale.dto";
import { assertCounterSalesEnabled } from "./counter-sale-gate";
import {
  COUNTER_PARK_LOCK_FAMILY,
  customerNameOf,
  defaultParkLabel,
  iso,
  isUuid,
  lineCountOf,
  localHm,
  priceLinesOf,
  type ParkedRow,
} from "./counter-park";
import type { ListParkedDto, ParkCartDto } from "./counter-park.dto";
import {
  FULFILMENT_CAPABILITY_READER,
  type FulfilmentCapabilityReader,
} from "./fulfilment-capability-reader";

/** The raw-SQL surface of a Prisma transaction client (the tenant-transaction callback receives it as `any`). */
interface TxRaw {
  $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

const takenError = () =>
  new NotFoundException({
    code: API_ERROR_CODES.PARK_TAKEN,
    message: "This parked sale is no longer available.",
  });

/** 409 PARK_ID_CONFLICT: the id belongs to another tenant or register, or to a row already taken back or expired. */
const conflictError = () =>
  new ConflictException({
    code: API_ERROR_CODES.PARK_ID_CONFLICT,
    message: "This parked sale could not be saved. Park it again.",
  });

/**
 * Counter-sale PARK / RESUME (SA-748). A clerk sets the live cart aside as a SERVER row (`CounterParkedCart`) and takes
 * it back later, from any till. Every route first applies the COUNTER_SALES_DISABLED gate (`assertCounterSalesEnabled`,
 * the same function `POST /orders/counter-sale` uses) and is tenant-scoped by an EXPLICIT `"tenantId"` clause in every
 * statement (the raw SQL bypasses the tenant extension, so nothing here relies on it).
 *
 *  - park:   one transaction. `pg_advisory_xact_lock(counter-park, tenantId)` serialises every park of one tenant
 *            (all registers), then: replay check (same id + tenant + register returns the stored row, it does not count against
 *            the cap), cap check (open rows >= 10 -> 409 PARK_LIMIT), `INSERT ... ON CONFLICT (id) DO NOTHING`.
 *  - resume: ONE compare-and-set `UPDATE ... WHERE id AND tenantId AND resumedAt IS NULL AND expiresAt > now RETURNING`.
 *            Exactly one concurrent caller gets the row. No delete (the sweep removes it later); a retry may
 *            read it again within COUNTER_PARK_RETRY_WINDOW_MS, but only with the SAME `resumeAttemptId` (a lost response
 *            must not lose the cart; a second till has its own id and gets 404).
 *  - discard: `deleteMany({ id, tenantId, resumedAt: null })`.
 * The clock is the app's (`now`, bound): `timestamp(3)` columns are naive UTC, and a bound value does not depend on the
 * DB session's time zone the way `now()` compared to a naive column does. The race-safety rests on row state, not time.
 * Messages are fixed: no input is ever echoed. Placeholders only; no stock is reserved.
 */
@Injectable()
export class CounterParkService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FULFILMENT_CAPABILITY_READER)
    private readonly capability: FulfilmentCapabilityReader,
  ) {}

  /** The gate first (every route), then the tenant. `forTenant()` is UNSCOPED without a tenant: refuse (L-238). */
  private async enter(): Promise<string> {
    const tenantId = this.prisma.getTenantId();
    await assertCounterSalesEnabled(this.capability, tenantId);
    if (typeof tenantId !== "string" || !tenantId) {
      throw new ForbiddenException("Parked sales need a tenant-scoped session");
    }
    return tenantId;
  }

  private actorId(user: JwtPayload): string {
    if (typeof user?.sub !== "string" || !user.sub) {
      throw new ForbiddenException("Parked sales need a signed-in user");
    }
    return user.sub;
  }

  /** The register a request names, or the default when it names none or an invalid one. */
  private register(raw: string | undefined): string {
    return typeof raw === "string" && REGISTER_KEY_PATTERN.test(raw)
      ? raw
      : COUNTER_DEFAULT_REGISTER;
  }

  async park(
    dto: ParkCartDto,
    user: JwtPayload,
    now: Date = new Date(),
  ): Promise<ParkCartResponse> {
    const tenantId = await this.enter();
    const actor = this.actorId(user);
    const registerKey = this.register(dto.registerKey);

    // `_resume` is server-reserved (the resume compare-and-set writes it): a client may never send it.
    if (hasReservedParkKey(dto.payload))
      throw new BadRequestException("The sale to park is not valid.");
    const clean = sanitizeParkedPayload(dto.payload, COUNTER_SALE_METHODS);
    if (!clean.ok) {
      if (clean.reason === "TOO_MANY_LINES") {
        throw new PayloadTooLargeException(
          `A parked sale can hold at most ${COUNTER_PARK_MAX_LINES} lines.`,
        );
      }
      throw new BadRequestException("The sale to park is not valid.");
    }
    const payload = clean.value;
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") > COUNTER_PARK_MAX_BYTES) {
      throw new PayloadTooLargeException("This sale is too large to park.");
    }
    // Postgres jsonb refuses a NUL escape: a fixed 400 here instead of a 500 from the driver.
    if (json.includes("\\u0000")) throw new BadRequestException("The sale to park is not valid.");

    const customerName = customerNameOf(payload);
    // eslint-disable-next-line no-control-regex -- a NUL byte is not storable in a text column
    const typed = dto.label?.replace(/\u0000/g, "").trim();
    const label =
      typed ||
      defaultParkLabel(customerName, localHm(now, await tenantTimeZone(this.prisma, { tenantId })));
    const expiresAt = new Date(now.getTime() + COUNTER_PARK_TTL_HOURS * 3_600_000);
    const lineCount = lineCountOf(payload);

    return retryOnTxConflict("counter-park.park", () =>
      this.prisma.tenantTransaction(async (tx: unknown): Promise<ParkCartResponse> => {
        const db = tx as TxRaw;
        // Every park of this TENANT queues here (one lock for both caps, so the per-register and the tenant-wide count are
        // read and written together whatever the register); released at commit/rollback. Contention is negligible.
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${COUNTER_PARK_LOCK_FAMILY}), hashtext(${tenantId}))`;

        // 1. Replay: the same id, in THIS tenant, parked on THIS register, still OPEN, is the stored row (not counted
        // against the cap). A row already taken back or expired is closed: it falls through to the insert, whose ON
        // CONFLICT answers 409, so park -> resume -> park again never hands back the cart that was resumed.
        const stored = await db.$queryRaw<ParkedRow[]>`
          SELECT "id", "label", "registerKey", "createdAt", "expiresAt", "payload"
            FROM "CounterParkedCart"
           WHERE "id" = ${dto.id} AND "tenantId" = ${tenantId}
             AND "resumedAt" IS NULL AND "expiresAt" > ${now}`;
        if (stored.length > 0) {
          const row = stored[0];
          if (row.registerKey !== registerKey) throw conflictError();
          return {
            id: row.id,
            label: row.label,
            registerKey,
            createdAt: iso(row.createdAt),
            expiresAt: iso(row.expiresAt as Date | string),
            lineCount: lineCountOf(row.payload),
            ...(customerNameOf(row.payload) ? { customerName: customerNameOf(row.payload) } : {}),
            replayed: true,
          };
        }

        // 2. Caps, under the lock, before the insert: this register's open carts, then the whole tenant's.
        const open = await db.$queryRaw<Array<{ registerOpen: number; tenantOpen: number }>>`
          SELECT count(*) FILTER (WHERE "registerKey" = ${registerKey})::int AS "registerOpen",
                 count(*)::int AS "tenantOpen"
            FROM "CounterParkedCart"
           WHERE "tenantId" = ${tenantId} AND "resumedAt" IS NULL AND "expiresAt" > ${now}`;
        if ((open[0]?.registerOpen ?? 0) >= COUNTER_PARK_MAX_PER_REGISTER) {
          throw new ConflictException({
            code: API_ERROR_CODES.PARK_LIMIT,
            scope: "register" satisfies ParkLimitScope,
            message: "This register already holds the maximum number of parked sales.",
          });
        }
        if ((open[0]?.tenantOpen ?? 0) >= COUNTER_PARK_MAX_PER_TENANT) {
          throw new ConflictException({
            code: API_ERROR_CODES.PARK_LIMIT,
            scope: "tenant" satisfies ParkLimitScope,
            message: "Too many sales are parked across the registers.",
          });
        }

        // 3. Insert. Nothing returned = the id exists elsewhere (another tenant or register): the same fixed 409.
        const inserted = await db.$queryRaw<ParkedRow[]>`
          INSERT INTO "CounterParkedCart"
            ("id", "tenantId", "registerKey", "createdById", "label", "payload", "payloadVersion", "createdAt", "expiresAt")
          VALUES
            (${dto.id}, ${tenantId}, ${registerKey}, ${actor}, ${label}, ${json}::jsonb, 1, ${now}, ${expiresAt})
          ON CONFLICT ("id") DO NOTHING
          RETURNING "id", "label", "registerKey", "createdAt", "expiresAt"`;
        if (inserted.length === 0) throw conflictError();
        const row = inserted[0];
        return {
          id: row.id,
          label: row.label,
          registerKey: row.registerKey ?? registerKey,
          createdAt: iso(row.createdAt),
          expiresAt: iso(row.expiresAt as Date | string),
          lineCount,
          ...(customerName ? { customerName } : {}),
          replayed: false,
        };
      }),
    );
  }

  async list(query: ListParkedDto, now: Date = new Date()): Promise<ParkedCartListResponse> {
    const tenantId = await this.enter();
    const registerKey = this.register(query.register);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? COUNTER_PARK_PAGE_SIZE;
    const skip = (page - 1) * pageSize;

    const [rows, total] = await Promise.all([
      this.prisma.$queryRaw<ParkedRow[]>`
        SELECT "id", "label", "registerKey", "createdAt", "expiresAt",
               CASE WHEN jsonb_typeof("payload"->'lines') = 'array'
                    THEN jsonb_array_length("payload"->'lines') ELSE 0 END AS "lineCount",
               "payload"->'lines' AS "lines",
               "payload"->'customer'->>'businessName' AS "customerName"
          FROM "CounterParkedCart"
         WHERE "tenantId" = ${tenantId} AND "registerKey" = ${registerKey}
           AND "resumedAt" IS NULL AND "expiresAt" > ${now}
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT ${pageSize} OFFSET ${skip}`,
      this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS "n"
          FROM "CounterParkedCart"
         WHERE "tenantId" = ${tenantId} AND "registerKey" = ${registerKey}
           AND "resumedAt" IS NULL AND "expiresAt" > ${now}`,
    ]);

    const data: ParkedCartListItem[] = rows.map((r) => ({
      id: r.id,
      label: r.label,
      registerKey: r.registerKey ?? registerKey,
      createdAt: iso(r.createdAt),
      expiresAt: iso(r.expiresAt as Date | string),
      lineCount: Number(r.lineCount ?? 0),
      priceLines: priceLinesOf({ lines: r.lines }),
      ...(r.customerName ? { customerName: r.customerName } : {}),
    }));
    return { data, total: total[0]?.n ?? 0, page, pageSize };
  }

  /**
   * Takes a parked cart back. `attemptId` is the client's per-tap uuid: the compare-and-set stores it in the row's own
   * JSON (`_resume`, server-reserved) in the SAME statement that marks the row taken, and only a retry that carries that
   * same id may read the row again (inside COUNTER_PARK_RETRY_WINDOW_MS). Another till, even on the same login, has a
   * different id and gets 404 PARK_TAKEN, so a cart can never be held by two tills.
   */
  async resume(
    id: string,
    attemptId: string,
    user: JwtPayload,
    now: Date = new Date(),
  ): Promise<ResumeParkedCartResponse> {
    const tenantId = await this.enter();
    const actor = this.actorId(user);
    if (!isUuid(id)) throw takenError();

    // ONE transaction: the compare-and-set and the payload re-check commit together. If the stored payload no longer passes
    // the whitelist the throw rolls the UPDATE back, so the cart is not marked taken (and stays listed to discard) when the
    // clerk got nothing back.
    return this.prisma.tenantTransaction(async (tx: unknown): Promise<ResumeParkedCartResponse> => {
      const db = tx as TxRaw;
      // The compare-and-set: the row changes state only if it is still open, in this tenant, and unexpired. A stored payload
      // that is not a JSON object cannot carry `_resume` (jsonb_set on it would be a 500): it matches no row here, so the
      // retry read below finds nothing and the answer is the intended 404 PARK_TAKEN.
      let rows = await db.$queryRaw<ParkedRow[]>`
        UPDATE "CounterParkedCart"
           SET "resumedAt" = ${now}, "resumedById" = ${actor},
               "payload" = jsonb_set("payload", '{_resume}', jsonb_build_object('attemptId', ${attemptId}::text))
         WHERE "id" = ${id} AND "tenantId" = ${tenantId}
           AND "resumedAt" IS NULL AND "expiresAt" > ${now}
           AND jsonb_typeof("payload") = 'object'
        RETURNING "id", "label", "createdAt", "payload"`;

      if (rows.length === 0) {
        // The retry of the SAME tap (a lost response): the row THAT attempt took a moment ago, and only that.
        const since = new Date(now.getTime() - COUNTER_PARK_RETRY_WINDOW_MS);
        rows = await db.$queryRaw<ParkedRow[]>`
          SELECT "id", "label", "createdAt", "payload"
            FROM "CounterParkedCart"
           WHERE "id" = ${id} AND "tenantId" = ${tenantId}
             AND "resumedAt" > ${since} AND "payload"->'_resume'->>'attemptId' = ${attemptId}`;
      }
      if (rows.length === 0) throw takenError();

      // Defence in depth: only a payload that still passes the whitelist leaves the server. The whitelist rebuild never
      // copies the server-reserved `_resume` key, so it is absent from the answer.
      const clean = sanitizeParkedPayload(rows[0].payload, COUNTER_SALE_METHODS);
      if (!clean.ok) throw takenError();
      return {
        id: rows[0].id,
        label: rows[0].label,
        createdAt: iso(rows[0].createdAt),
        payload: clean.value,
      };
    });
  }

  async discard(id: string): Promise<void> {
    const tenantId = await this.enter();
    if (!isUuid(id)) throw takenError();
    const res = await this.prisma
      .forTenant()
      .counterParkedCart.deleteMany({ where: { id, tenantId, resumedAt: null } });
    if (res.count === 0) throw takenError();
  }
}
