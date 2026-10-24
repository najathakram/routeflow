/**
 * The advisory-lock statements a `$executeRaw` mock saw, without the `SET LOCAL lock_timeout`
 * bookkeeping around them (tenant-units-lock.ts bounds every wait). `calls[i]` is the tagged-template
 * argument list, `order[i]` its jest invocation order.
 */
export function lockCalls(exec: jest.Mock): {
  calls: Array<[TemplateStringsArray, ...string[]]>;
  order: number[];
} {
  const keep = exec.mock.calls
    .map((c, i) => i)
    .filter(
      (i) => !(exec.mock.calls[i][0] as TemplateStringsArray).join("?").startsWith("SET LOCAL"),
    );
  return {
    calls: keep.map((i) => exec.mock.calls[i] as [TemplateStringsArray, ...string[]]),
    order: keep.map((i) => exec.mock.invocationCallOrder[i]),
  };
}
