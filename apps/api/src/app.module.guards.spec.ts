/**
 * P4-b — regression pin (architecture review P-15/P-16). T2/R3
 * (2026-09-03-imp-p4-guard-order-findunique-pins/brief.md): a static read of
 * app.module.ts, pinning the two invariants guard-chain.security.spec.ts (T1)
 * exercises at runtime — the global APP_GUARD order, and that JwtAuthGuard is
 * NEVER one of them (it stays route-level, applied per-controller/handler via
 * @UseGuards, so `req.user` is unpopulated for every APP_GUARD).
 */
import * as fs from "fs";
import * as path from "path";

const APP_GUARD_RE = /provide:\s*APP_GUARD\s*,\s*use(?:Class|Existing):\s*(\w+)/g;

/** Returns the text strictly between the `providers: [` that opens this module's
 * provider array and its matching closing `]` — bracket-depth scanned so nested
 * arrays/objects inside a provider entry can't truncate the match early. */
function extractProvidersBlock(source: string): string {
  const marker = "providers: [";
  const start = source.indexOf(marker);
  if (start === -1) throw new Error("app.module.ts: no `providers: [` block found");
  let i = start + marker.length;
  let depth = 1;
  const bodyStart = i;
  while (depth > 0) {
    if (i >= source.length) throw new Error("app.module.ts: unterminated `providers: [` block");
    if (source[i] === "[") depth++;
    else if (source[i] === "]") depth--;
    i++;
  }
  return source.slice(bodyStart, i - 1);
}

describe("T2/R3 — app.module.ts APP_GUARD registration (static)", () => {
  const source = fs.readFileSync(path.join(__dirname, "app.module.ts"), "utf8");
  const providersBlock = extractProvidersBlock(source);

  it("registers exactly [ThrottlerGuard, TenantStatusGuard, ImpersonationGuard] as APP_GUARD, in that order", () => {
    const names = [...providersBlock.matchAll(APP_GUARD_RE)].map((m) => m[1]);
    expect(names).toEqual(["ThrottlerGuard", "TenantStatusGuard", "ImpersonationGuard"]);
  });

  it("never registers JwtAuthGuard as an APP_GUARD (it stays route-level, applied via @UseGuards)", () => {
    // Comments are stripped first: the invariant is about what is REGISTERED, and the block
    // deliberately DOCUMENTS (P4-b's guard-order note) why JwtAuthGuard is not one of the
    // global guards — a raw substring match would forbid writing that explanation down.
    const code = providersBlock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("JwtAuthGuard");
  });
});
