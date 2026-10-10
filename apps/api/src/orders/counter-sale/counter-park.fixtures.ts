/**
 * A small in-memory stand-in for the `CounterParkedCart` table, for the unit specs only. It answers the exact raw
 * statements `counter-park.service.ts` sends (matched by their SQL text) and APPLIES their bound values, so a spec asserts
 * what the service really asked for (the tenant, the register, the clock), not a canned answer. A statement it does not
 * recognise throws, so a new query cannot slip through a spec unseen. Every statement is also recorded.
 */
export interface FakeRow {
  id: string;
  tenantId: string;
  registerKey: string;
  createdById: string | null;
  label: string;
  payload: unknown;
  createdAt: Date;
  expiresAt: Date;
  resumedAt: Date | null;
  resumedById: string | null;
}

export interface Statement {
  sql: string;
  values: unknown[];
}

const norm = (strings: readonly string[]) => strings.join("?").replace(/\s+/g, " ").trim();

export class FakeParkDb {
  rows: FakeRow[] = [];
  statements: Statement[] = [];

  /** The tagged-template entry point both `$queryRaw` and `$executeRaw` mocks delegate to. */
  run(strings: readonly string[], values: unknown[]): unknown[] | number {
    const sql = norm(strings);
    this.statements.push({ sql, values });
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return 0;

    if (sql.startsWith("INSERT INTO")) {
      // (id, tenantId, registerKey, createdById, label, payload-json, createdAt, expiresAt)
      const [id, tenantId, registerKey, createdById, label, json, createdAt, expiresAt] =
        values as [string, string, string, string, string, string, Date, Date];
      if (this.rows.some((r) => r.id === id)) return []; // ON CONFLICT (id) DO NOTHING
      const row: FakeRow = {
        id,
        tenantId,
        registerKey,
        createdById,
        label,
        payload: JSON.parse(json),
        createdAt,
        expiresAt,
        resumedAt: null,
        resumedById: null,
      };
      this.rows.push(row);
      return [{ id, label, registerKey, createdAt, expiresAt }];
    }

    if (sql.startsWith("UPDATE")) {
      const [now, actor, attempt, id, tenantId, now2] = values as [
        Date,
        string,
        string,
        string,
        string,
        Date,
      ];
      const hit = this.rows.find(
        (r) => r.id === id && r.tenantId === tenantId && r.resumedAt === null && r.expiresAt > now2,
      );
      if (!hit) return [];
      hit.resumedAt = now;
      hit.resumedById = actor;
      // jsonb_set("payload", '{_resume}', jsonb_build_object('attemptId', attempt)): the server-reserved key, same statement
      hit.payload = { ...(hit.payload as object), _resume: { attemptId: attempt } };
      return [{ id: hit.id, label: hit.label, createdAt: hit.createdAt, payload: hit.payload }];
    }

    if (sql.startsWith("SELECT count(*) FILTER")) {
      // (registerKey, tenantId, now): this register's open carts and the whole tenant's
      const [registerKey, tenantId, now] = values as [string, string, Date];
      return [
        {
          registerOpen: this.open(tenantId, registerKey, now).length,
          tenantOpen: this.openAll(tenantId, now).length,
        },
      ];
    }
    if (sql.startsWith("SELECT count(*)")) {
      const [tenantId, registerKey, now] = values as [string, string, Date];
      return [{ n: this.open(tenantId, registerKey, now).length }];
    }

    if (sql.includes(`"payload"->'_resume'->>'attemptId' = ?`)) {
      // The resume retry: (id, tenantId, since, attempt): the row THAT attempt took, inside the window.
      const [id, tenantId, since, attempt] = values as [string, string, Date, string];
      return this.rows
        .filter(
          (r) =>
            r.id === id &&
            r.tenantId === tenantId &&
            r.resumedAt !== null &&
            r.resumedAt > since &&
            (r.payload as { _resume?: { attemptId?: string } })._resume?.attemptId === attempt,
        )
        .map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt, payload: r.payload }));
    }

    if (sql.includes('FROM "CounterParkedCart" WHERE "id" = ? AND "tenantId" = ?')) {
      // The park replay read: (id, tenantId, now) and only an OPEN row (not resumed, not expired) is a replay.
      const [id, tenantId, now] = values as [string, string, Date | undefined];
      return this.rows.filter(
        (r) =>
          r.id === id &&
          r.tenantId === tenantId &&
          (now === undefined || (r.resumedAt === null && r.expiresAt > now)),
      );
    }

    if (sql.includes('ORDER BY "createdAt" DESC, "id" DESC LIMIT')) {
      const [tenantId, registerKey, now, limit, skip] = values as [
        string,
        string,
        Date,
        number,
        number,
      ];
      return this.open(tenantId, registerKey, now)
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )
        .slice(skip, skip + limit)
        .map((r) => {
          const p = r.payload as { lines?: unknown[]; customer?: { businessName?: string } | null };
          return {
            id: r.id,
            label: r.label,
            registerKey: r.registerKey,
            createdAt: r.createdAt,
            expiresAt: r.expiresAt,
            lineCount: p.lines?.length ?? 0,
            customerName: p.customer?.businessName ?? null,
          };
        });
    }
    throw new Error(`FakeParkDb: unrecognised statement: ${sql}`);
  }

  openAll(tenantId: string, now: Date): FakeRow[] {
    return this.rows.filter(
      (r) => r.tenantId === tenantId && r.resumedAt === null && r.expiresAt > now,
    );
  }

  open(tenantId: string, registerKey: string, now: Date): FakeRow[] {
    return this.rows.filter(
      (r) =>
        r.tenantId === tenantId &&
        r.registerKey === registerKey &&
        r.resumedAt === null &&
        r.expiresAt > now,
    );
  }

  /** The `$queryRaw` / `$executeRaw` mocks: tagged-template functions over `run`. */
  queryRaw = jest.fn((strings: readonly string[], ...values: unknown[]) =>
    Promise.resolve(this.run(strings, values)),
  );
  executeRaw = jest.fn((strings: readonly string[], ...values: unknown[]) =>
    Promise.resolve(this.run(strings, values)),
  );
}
