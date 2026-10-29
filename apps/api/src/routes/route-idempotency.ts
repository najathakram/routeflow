import { createHash } from "crypto";

/**
 * RF-019: the replay guard behind the route run's completion endpoints, extracted VERBATIM from `RoutesService`
 * (behaviour-neutral; it frees routes.service.ts headroom, SA-065). It uses raw SQL so the feature works before the
 * IdempotencyKey table migration is applied: queries are wrapped in try/catch and fail silently if the table does not
 * yet exist (FAIL-OPEN on purpose: a replay guard must never 500 a legitimate request).
 *
 * `common/idempotency.service.ts` copies these semantics (sha256 of `${scope}:${key}`, the 24h read window, the ON
 * CONFLICT upsert, the fail-open catches). It is a separate, transactional implementation by design; a change to the
 * hashing, the window or the upsert here must be mirrored there by hand.
 */
type RawClient = {
  $queryRaw: <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

export function makeRouteKeyHash(key: string, scope: string): string {
  return createHash("sha256").update(`${scope}:${key}`).digest("hex");
}

export async function checkRouteIdempotencyKey(
  prisma: RawClient,
  key: string,
  scope: string,
): Promise<unknown> {
  const hash = makeRouteKeyHash(key, scope);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const rows = await prisma.$queryRaw<{ response: string }[]>`
        SELECT response FROM "IdempotencyKey"
        WHERE "keyHash" = ${hash} AND "createdAt" >= ${cutoff}
        LIMIT 1
      `;
    if (!rows || rows.length === 0) return null;
    return JSON.parse(rows[0].response);
  } catch {
    return null; // table doesn't exist yet — degrade gracefully
  }
}

export async function saveRouteIdempotencyKey(
  prisma: RawClient,
  key: string,
  scope: string,
  response: unknown,
): Promise<void> {
  const hash = makeRouteKeyHash(key, scope);
  try {
    const responseJson = JSON.stringify(response);
    await prisma.$executeRaw`
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
