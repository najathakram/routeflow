/**
 * Row 556 / SA-1006 (R3): `plan.reprice` is classed `expected_system` in addon-change-source-class.ts only because
 * its single SYSTEM caller is the scheduled-downgrade cron. This census pins that count at 1, so a new automatic
 * re-price cannot hide under `expected_system`: it fails here and must be classified (a new source string) or the
 * pin raised with a reason.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(__dirname, "..");
const CALL = "repriceAddonsLeavingInclusionTx(";

/** Every non-spec .ts file under src. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

/** The argument text of each call of `name(` in `text`, up to its matching close paren. */
export function callArgs(text: string, name: string): string[] {
  const found: string[] = [];
  let at = text.indexOf(name);
  while (at !== -1) {
    let depth = 1;
    let i = at + name.length;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    found.push(text.slice(at + name.length, i));
    at = text.indexOf(name, i);
  }
  return found;
}

/** `file` of every call (outside its own definition) whose arguments pass `actorKind: "SYSTEM"`. */
export function systemCallers(files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // the definition `export async function repriceAddonsLeavingInclusionTx(` is not a call
    const calls = callArgs(text, CALL).filter(
      (_, k) => !/function\s+$/.test(text.slice(0, nthIndex(text, CALL, k))),
    );
    for (const args of calls) {
      if (/actorKind:\s*["']SYSTEM["']/.test(args)) hits.push(relative(SRC, f).replace(/\\/g, "/"));
    }
  }
  return hits;
}

function nthIndex(text: string, needle: string, n: number): number {
  let at = -1;
  for (let k = 0; k <= n; k++) at = text.indexOf(needle, at + 1);
  return at;
}

describe("repriceAddonsLeavingInclusionTx SYSTEM callers (SA-1006 census)", () => {
  it("exactly one SYSTEM caller: the scheduled-downgrade cron (plan.reprice stays expected_system)", () => {
    expect(systemCallers(sourceFiles(SRC))).toEqual(["billing/billing-cron.service.ts"]);
  });

  it("the census sees a second SYSTEM caller (R3: a new one would fail the pin above)", () => {
    const fake = `await ${CALL}tx, ev, { tenantId, actorKind: "SYSTEM", onInvalid: (a) => f(a) });`;
    expect(callArgs(fake, CALL)).toHaveLength(1);
    expect(/actorKind:\s*["']SYSTEM["']/.test(callArgs(fake, CALL)[0])).toBe(true);
  });

  it("a non-SYSTEM caller is not counted", () => {
    const person = `await ${CALL}tx, ev, { actorKind: "TENANT_USER" });`;
    expect(/actorKind:\s*["']SYSTEM["']/.test(callArgs(person, CALL)[0])).toBe(false);
  });
});
