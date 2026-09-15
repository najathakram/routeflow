import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Shared replay guard over the global `IdempotencyKey` table (platform.prisma).
 *
 * COPIED from the three private RF-019 helpers on `RoutesService`
 * (makeKeyHash / checkIdempotencyKey / saveIdempotencyKey) — same
 * sha256(`${scope}:${key}`) hashing, same 24h read window, same ON CONFLICT
 * upsert, same FAIL-OPEN catches. This is NOT a lift-and-delete: RoutesService
 * still owns its own three private copies and still uses them for production
 * driver traffic (route dispatch/completion). There are now TWO
 * implementations to reason about, not one. Any change to the hashing, the
 * window, the upsert, or the fail-open behaviour here must be mirrored by
 * hand in `RoutesService`'s copies (RF-019) — RouteFlow's server-side scope
 * fence (RULINGS R7) keeps `RoutesService` out of this diff, so consolidating
 * the two is left for a future pass, not done here.
 *
 * FAIL-OPEN IS DELIBERATE, not an oversight: a replay guard must never 500 a
 * legitimate request. A DB error inside `check` returns null (so the request
 * proceeds and a duplicate can land) and a failing `save` is swallowed. Every
 * caller therefore keeps its own domain-level backstop — for returns that is
 * the cumulative over-return guard plus PENDING status, which means no money
 * moves without an operator approving it.
 *
 * Raw SQL (rather than the Prisma delegate) is also inherited verbatim: it is
 * what lets the guard degrade quietly on an environment where the table has
 * not been provisioned yet.
 *
 * SCOPING WARNING: `keyHash` is GLOBALLY unique and these queries run on the
 * un-scoped client, so a new caller MUST embed its tenantId in the scope string
 * (e.g. `returns.create:${tenantId}:${orderId}`) or a key could collide across
 * tenants. RoutesService's existing scopes are left exactly as they are —
 * retrofitting a tenantId into them would silently invalidate in-flight driver
 * keys.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /** sha256 of `${scope}:${key}` — the row's globally unique `keyHash`. */
  keyHash(key: string, scope: string): string {
    return createHash("sha256").update(`${scope}:${key}`).digest("hex");
  }

  /** The stored response for this key+scope inside the 24h window, else null. */
  async check<T = unknown>(key: string, scope: string): Promise<T | null> {
    const hash = this.keyHash(key, scope);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    try {
      const rows = await this.prisma.$queryRaw<{ response: string }[]>`
        SELECT response FROM "IdempotencyKey"
        WHERE "keyHash" = ${hash} AND "createdAt" >= ${cutoff}
        LIMIT 1
      `;
      if (!rows || rows.length === 0) return null;
      return JSON.parse(rows[0].response) as T;
    } catch {
      return null; // table doesn't exist yet — degrade gracefully
    }
  }

  /** Best-effort store of this request's response under key+scope. */
  async save(key: string, scope: string, response: unknown): Promise<void> {
    const hash = this.keyHash(key, scope);
    try {
      const responseJson = JSON.stringify(response);
      await this.prisma.$executeRaw`
        INSERT INTO "IdempotencyKey" ("id", "keyHash", "response", "createdAt")
        VALUES (gen_random_uuid(), ${hash}, ${responseJson}, now())
        ON CONFLICT ("keyHash") DO UPDATE
          SET response   = EXCLUDED.response,
              "createdAt" = now()
      `;
    } catch {
      // best-effort — don't fail the request if idempotency storage errors
    }
  }
}
