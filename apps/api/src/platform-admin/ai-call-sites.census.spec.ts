import * as fs from "fs";
import * as path from "path";

/**
 * SA-1102 A-1(a): the Anthropic-call census. Every production file that calls the Anthropic API (`messages.create(` or a
 * raw `api.anthropic.com` fetch) is listed here, and each listed site calls `prepareAiCall(` BEFORE its client call, so
 * the business check, the key choice and the monthly budget cannot be skipped by a new site. `testConnection` (super
 * admin only, platform key, no business, not metered) is the one reviewed exemption. The table must equal the source
 * both ways: a new call site fails until it is listed, and a listed site that stopped calling is stale.
 */
const SRC = path.join(__dirname, "..");

/** file -> how many Anthropic client calls it makes (each needs its own prepareAiCall before it). */
const SITES: Record<string, number> = {
  "bookkeeping/bookkeeping.service.ts": 1, // receipt scan
  "route-optimization/route-analysis.service.ts": 2, // analyzeRoute + analyzeRouteRun
  "supplier-statements/supplier-statements.service.ts": 1, // statement scan
  "vendor-bills/vendor-bills.service.ts": 1, // bill scan
};

/** Reviewed: not a metered business call. */
const EXEMPT: Record<string, string> = {
  "platform-admin/platform-config.service.ts":
    "testConnection: super admin only, the platform key, no business, not metered",
};

const CALL = /\bmessages\.create\s*\(|api\.anthropic\.com/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

function scan(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const r = rel(file);
    if (r.endsWith(".spec.ts") || r.includes("/testing/")) continue;
    const n = (strip(fs.readFileSync(file, "utf8")).match(CALL) ?? []).length;
    if (n > 0) found[r] = n;
  }
  return found;
}

const indexes = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m.index ?? -1);

describe("Anthropic call sites all go through prepareAiCall (SA-1102 A-1 census)", () => {
  const found = scan();

  it("every file that calls Anthropic is a listed site or the reviewed exemption (both ways)", () => {
    expect(Object.keys(found).sort()).toEqual(
      [...Object.keys(SITES), ...Object.keys(EXEMPT)].sort(),
    );
  });

  it("each listed site makes the counted number of calls", () => {
    for (const [file, calls] of Object.entries(SITES))
      expect([file, found[file]]).toEqual([file, calls]);
  });

  it.each(Object.entries(SITES))(
    "%s calls prepareAiCall before each Anthropic call",
    (file, calls) => {
      const text = strip(fs.readFileSync(path.join(SRC, file), "utf8"));
      const prepares = indexes(text, /\bprepareAiCall\s*\(/g);
      const creates = indexes(text, /\bmessages\.create\s*\(/g);
      expect(prepares).toHaveLength(calls);
      expect(creates).toHaveLength(calls);
      creates.forEach((at, i) => expect(prepares[i]).toBeLessThan(at));
    },
  );

  // SA-1102 A-4 M3: tenant first. The AI method of every listed site (testConnection is the exemption) opens with
  // `this.platformConfig.requireAiTenant()` as its FIRST statement, so nothing (prisma, forTenant, systemConfig, or a
  // helper that reads through them) runs before a business is known. `prepareAiCall` stays after the method's own
  // reads so a not-found is still a 404; the tenant step is the one before everything.
  const AI_METHODS: Record<string, string[]> = {
    "bookkeeping/bookkeeping.service.ts": ["extractExpenseItems"],
    "route-optimization/route-analysis.service.ts": ["analyzeRoute", "analyzeRouteRun"],
    "supplier-statements/supplier-statements.service.ts": ["scanStatement"],
    "vendor-bills/vendor-bills.service.ts": ["scanInvoice"],
  };

  /** The text of a method's body: from its opening brace (after balanced params and an optional return type). */
  function methodBody(text: string, name: string): string {
    const at = text.search(new RegExp(String.raw`\basync\s+${name}\s*\(`));
    expect(at).toBeGreaterThan(-1);
    let i = text.indexOf("(", at);
    for (let depth = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    const open = text.slice(i + 1).search(/\{/);
    const head = text.slice(i + 1, i + 1 + open);
    expect(head).toMatch(/^\s*(:\s*[^{]+)?\s*$/); // only an optional return type between ")" and "{"
    return text.slice(i + 1 + open + 1);
  }

  it("every AI method opens with requireAiTenant() as its first statement", () => {
    expect(Object.keys(AI_METHODS).sort()).toEqual(Object.keys(SITES).sort());
    for (const [file, names] of Object.entries(AI_METHODS)) {
      const text = strip(fs.readFileSync(path.join(SRC, file), "utf8"));
      for (const name of names) {
        const body = methodBody(text, name).trimStart();
        expect([file, name, body.startsWith("this.platformConfig.requireAiTenant();")]).toEqual([
          file,
          name,
          true,
        ]);
      }
    }
  });

  it("prepareAiCall and requireAiTenant have one home: prepareAiCall's own first step is requireAiTenant", () => {
    const text = strip(
      fs.readFileSync(path.join(SRC, "platform-admin/platform-config.service.ts"), "utf8"),
    );
    expect(text.match(/^ {2}requireAiTenant[(][)]: string [{]/gm)).toHaveLength(1); // one definition
    // prepareAiCall's return type is an object type, so take the body from the `}> {` that closes it.
    const head = text.indexOf("async prepareAiCall(");
    expect(head).toBeGreaterThan(-1);
    const bodyStart = text.indexOf("}> {", head) + "}> {".length;
    expect(
      text.slice(bodyStart).trimStart().startsWith("const tenantId = this.requireAiTenant();"),
    ).toBe(true);
  });

  it("no site resolves a key or a model on its own any more (prepareAiCall is the one entry)", () => {
    for (const file of Object.keys(SITES)) {
      const text = strip(fs.readFileSync(path.join(SRC, file), "utf8"));
      expect([file, /\bresolveAnthropicKey\s*\(/.test(text)]).toEqual([file, false]);
      expect([file, /\bresolveModel(For)?\s*\(/.test(text)]).toEqual([file, false]);
    }
  });

  it("the exemption stays reviewed: it is listed with a reason", () => {
    for (const reason of Object.values(EXEMPT)) expect(reason.trim().length).toBeGreaterThan(10);
  });
});
