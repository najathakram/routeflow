/**
 * A transaction double that records every call, IN ORDER, across all models: `model.method` for a
 * model verb, `$queryRaw` / `$executeRaw` for raw SQL (with the template text, `?` per bound value,
 * and the values). Built for lock-ORDER pins (SA-218): the property under test is which statement
 * a transaction issues first, which per-model `jest.fn()`s cannot express across models.
 *
 * `respond(op, args)` supplies a call's resolved value; returning `undefined` falls back to a
 * benign per-verb default, so a pin only stubs the reads that steer the code path it proves.
 */
export interface OpLogEntry {
  op: string;
  args?: any;
  sql?: string;
  values?: unknown[];
}

const DEFAULTS: Record<string, unknown> = {
  findMany: [],
  findFirst: null,
  findUnique: null,
  count: 0,
  updateMany: { count: 0 },
  deleteMany: { count: 0 },
  createMany: { count: 0 },
};

function sqlText(query: any): string {
  // Tagged-template call (`tx.$queryRaw\`…\``) or a `Prisma.sql` object passed as one argument.
  const strings = Array.isArray(query) ? query : query?.strings;
  return Array.isArray(strings) ? strings.join("?") : String(query);
}

export function createOpLogTx(respond: (op: string, args: any) => unknown = () => undefined): {
  tx: any;
  log: OpLogEntry[];
} {
  const log: OpLogEntry[] = [];
  const raw =
    (op: "$queryRaw" | "$executeRaw") =>
    async (query: any, ...values: unknown[]) => {
      const entry: OpLogEntry = {
        op,
        sql: sqlText(query),
        values: Array.isArray(query) ? values : (query?.values ?? values),
      };
      log.push(entry);
      const res = await respond(op, entry);
      return res !== undefined ? res : op === "$queryRaw" ? [] : 0;
    };
  const tx = new Proxy(
    {},
    {
      get(_target, model) {
        if (model === "$queryRaw" || model === "$executeRaw") return raw(model);
        // `then` stays undefined so neither the tx nor a model delegate is ever mistaken for a
        // thenable by an `await` or a promise resolution.
        if (typeof model !== "string" || model === "then") return undefined;
        return new Proxy(
          {},
          {
            get(_delegate, method) {
              if (typeof method !== "string" || method === "then") return undefined;
              return async (args?: any) => {
                const op = `${model}.${method}`;
                log.push({ op, args });
                const res = await respond(op, args);
                return res !== undefined ? res : (DEFAULTS[method] ?? {});
              };
            },
          },
        );
      },
    },
  );
  return { tx, log };
}
